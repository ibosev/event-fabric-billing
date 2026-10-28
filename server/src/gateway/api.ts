import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import {
  command,
  comparePositions,
  decodePosition,
  encodePosition,
  handle,
  readmodel,
  sse,
  type EventStore,
  type Filter,
  type GatewayDefinition,
  type Position,
} from "event-fabric";
import { domain } from "../domain/index.js";
import { invoiceRejections } from "../domain/invoice.js";
import {
  CancelSubscription,
  StartSubscription,
  subscriptionRejections,
} from "../domain/subscription.js";
import type { Invoice } from "../readmodels/invoices.js";
import { dunning } from "../workflows/dunning.js";

/**
 * ─── Request context ───────────────────────────────────────────────────────────
 * The Application's own data about one request. A real Application would verify a
 * token here; this example trusts headers so the smoke test can play each role:
 *
 * - `X-Tenant`: whose settings and `Idempotency-Key`s share a namespace;
 * - `X-User`: who acts, recorded as Command Metadata;
 * - `X-Role`: `admin` may maintain settings, void Invoices and read revenue;
 * - `X-Customer-Id`: a customer-portal caller, who sees only their own Invoices.
 */
export type Caller = {
  tenant: string;
  user: string;
  role: "clerk" | "admin";
  customerId?: string;
};
const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return typeof value === "string" && value ? value : undefined;
};
const context = (req: IncomingMessage): Caller => ({
  tenant: header(req, "x-tenant") ?? "demo",
  user: header(req, "x-user") ?? "anonymous",
  role: header(req, "x-role") === "admin" ? "admin" : "clerk",
  customerId: header(req, "x-customer-id"),
});

/* Plain Express middleware runs, in order, before the routes. */
const requestId = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Request-Id", req.get("X-Request-Id") ?? randomUUID());
  // Which replica answered, when several run behind the load balancer.
  res.setHeader("X-Instance", hostname());
  next();
};

/**
 * ─── Gateway `api` ─────────────────────────────────────────────────────────────
 * A named HTTP entry point. Routes send Commands and read Readmodels through the
 * request's scoped handle, which applies the Access map to those operations.
 * The settings plugin adds ordinary CRUD routes with their own authorization.
 */
export const api = ({ port, host, store }: {
  port: number;
  host?: string;
  store: EventStore;
}): GatewayDefinition<Caller> => ({
  port,
  host,
  middleware: [requestId],
  context,

  /*
   * Turns the Request context into Command Metadata, explicitly; nothing else from
   * the request reaches a Command. Metadata is inherited down the chain: the Events,
   * Saga Commands and Worker Commands this request causes all carry `actor`.
   */
  commandMetadata: (ctx) => ({ actor: ctx.user, channel: "api" }),

  /*
   * With a scope, a request's `Idempotency-Key` header becomes its Command id, so a
   * client retry is a Duplicate Command: it gets the first outcome again, with
   * `EventFabric-Duplicate: true`, and nothing runs twice.
   */
  idempotencyScope: (ctx) => ctx.tenant,

  /* Adds a `Server-Timing` header to every response. */
  serverTiming: true,
  /* How long a read waits for a Readmodel to reach a requested Position. */
  waitTimeout: 5_000,

  /*
   * ─── Access map ───
   * Deny by default: only these Commands and Readmodels are reachable over HTTP,
   * however a route is written. Names are checked against the generated Register
   * (`npm run types`). A value is `true`, or a function of the caller:
   *
   * - for a Command, returning `true` allows it;
   * - for a Readmodel, returning an object allows it with an equality filter that is
   *   AND-ed into every read and live Notification. A filter value that is
   *   `undefined` denies with 403 rather than matching documents without the field.
   */
  access: {
    domain: {
      "billing.invoice.issue": true,
      "billing.invoice.recordPayment": true,
      "billing.invoice.void": (ctx) => ctx.role === "admin",
      "billing.customer.register": true,
      "billing.customer.addContact": true,
      // A rule also receives the Command: a portal caller subscribes only themselves.
      "billing.subscription.start": (ctx, command) =>
        !ctx.customerId || command.payload.customerId === ctx.customerId,
      // A rule cannot load the Subscription to check its owner, so only staff cancel.
      "billing.subscription.cancel": (ctx) => !ctx.customerId,
    },
    readmodels: {
      "billing.invoices": (ctx) =>
        ctx.customerId ? { customerId: ctx.customerId } : true,
      "billing.customers": true,
      "reporting.revenue": (ctx) => ctx.role === "admin",
      "billing.subscriptions": (ctx) =>
        ctx.customerId ? { customerId: ctx.customerId } : true,
      "reporting.plans": (ctx) => ctx.role === "admin",
    },
    /*
     * Workflows: `<name>.start`, `<name>.query` and `<name>.signals.<signal>`. A rule
     * also receives `{ id, payload }`; it cannot load the Invoice, so only staff see an
     * Invoice's dunning or record a debtor's promise to pay.
     */
    workflows: {
      "dunning.query": (ctx) => !ctx.customerId,
      "dunning.signals.promised": (ctx) => !ctx.customerId,
    },
  },

  /*
   * ─── Routes ───
   * `command(...)` and `readmodel(...)` build Express handlers. A Command's payload is
   * checked against its schema before the Aggregate sees it. `respondWith` answers with
   * the Readmodel document once it reflects the Command; responses carry
   * `EventFabric-Position`, which a client sends back as `EventFabric-Min-Position` to
   * read its own writes from any replica.
   */
  routes: [
    {
      method: "get",
      path: "/health",
      handler: (_req: Request, res: Response) => res.json({ ok: true }),
    },

    /* ─── Invoices ─── */
    {
      method: "post",
      path: "/invoices",
      handler: command(
        (req) => domain.billing.invoice.issue(undefined, req.body),
        { creates: true, respondWith: "billing.invoices" },
      ),
    },
    {
      method: "post",
      path: "/invoices/:id/payments",
      handler: command(
        (req) => domain.billing.invoice.recordPayment(String(req.params.id), req.body),
        {
          respondWith: "billing.invoices",
          // Per-code statuses; `overpaid` keeps the default 422 for its kind (`rule`).
          codes: {
            [invoiceRejections.alreadySettled]: 409,
            [invoiceRejections.voided]: 409,
          },
        },
      ),
    },
    {
      method: "post",
      path: "/invoices/:id/void",
      handler: command(
        (req) => domain.billing.invoice.void(String(req.params.id), req.body),
        { respondWith: "billing.invoices" },
      ),
    },

    /*
     * Pays what is left and waits for the receipt. `awaitCorrelated` subscribes before
     * sending, then resolves with the first matching Event in the same Correlation:
     * here `receiptSent`, four hops away (Saga → Worker → reply to the Saga → Command).
     */
    {
      method: "post",
      path: "/invoices/:id/settle",
      handler: async (req: Request, res: Response) => {
        const request = handle<Caller>(req);
        const id = String(req.params.id);
        const { document } = await request.readmodels.billing.invoices(id);
        if (!document) return res.status(404).json({ code: "not-found" });
        const result = await request.awaitCorrelated(
          domain.billing.invoice.recordPayment(id, {
            amount: document.amount - document.paid,
            ...(req.body?.method ? { method: req.body.method } : {}),
          }),
          domain.billing.invoice.receiptSent,
          { deadline: 15_000 },
        );
        if (result.status === "accepted")
          return res.json({ receipt: result.event?.payload.reference });
        res
          .status(result.status === "unknown" ? 504 : 422)
          .json(result.outcome);
      },
    },
    /*
     * ─── The dunning Workflow ───
     * `queryWorkflow` reads the instance's committed status, `set` view and result;
     * nothing runs the Workflow to answer. `sendSignal` delivers a typed Signal to the Workflow it names, checked
     * against its schema here (400 when it does not match).
     */
    {
      method: "get",
      path: "/invoices/:id/dunning",
      handler: async (req: Request, res: Response) => {
        const dunningOf = await handle<Caller>(req).queryWorkflow(dunning, String(req.params.id));
        if (!dunningOf) return res.status(404).json({ code: "not-found" });
        res.json(dunningOf);
      },
    },
    {
      method: "post",
      path: "/invoices/:id/promise",
      handler: async (req: Request, res: Response) => {
        await handle<Caller>(req).sendSignal(String(req.params.id), dunning.signals.promised(req.body));
        res.status(202).json({ accepted: true });
      },
    },
    {
      method: "get",
      path: "/invoices/:id",
      handler: readmodel("billing", "invoices", {
        id: (req) => String(req.params.id),
      }),
    },

    /*
     * A query written by hand: filters and `sort` are typed by the document, so an
     * unknown field or a wrong value type fails to compile. `q` is a text search over
     * the declared text index; quoted terms match phrases and `-term` excludes.
     * `elemMatch` matches an Invoice with at least one payment that fits, in the child table.
     */
    {
      method: "get",
      path: "/invoices",
      handler: async (req: Request, res: Response) => {
        const { readmodels } = handle<Caller>(req);
        const { status, method, q } = req.query;
        const filter: Filter<Invoice> = {
          ...(typeof status === "string" && { status: { in: [status as Invoice["status"]] } }),
          ...(typeof method === "string" && { payments: { elemMatch: { method } } }),
        };
        res.json(
          await readmodels.billing.invoices.find(filter, {
            q: typeof q === "string" ? q : undefined,
            sort: { dueDate: 1 },
            size: 50,
          }),
        );
      },
    },

    /* ─── Customers ─── */
    {
      method: "get",
      path: "/customers",
      handler: async (req: Request, res: Response) => {
        const pageSize = 20;
        let before: Position | undefined;
        let minimum: Position | undefined;
        try {
          for (const key of ["before", "minPosition"])
            if (req.query[key] !== undefined &&
                (typeof req.query[key] !== "string" || req.query[key].length > 128))
              throw new Error("Invalid cursor");
          if (typeof req.query.before === "string") before = decodePosition(req.query.before);
          if (typeof req.query.minPosition === "string") minimum = decodePosition(req.query.minPosition);
        } catch {
          res.status(400).json({ code: "invalid-cursor" });
          return;
        }
        const { readmodels } = handle<Caller>(req);
        // An empty read checks the Access map before touching registration history.
        await readmodels.billing.customers.find({ _id: { in: [] } }, { size: 0 });
        // Registration Positions provide stable newest-first pages, including imported history.
        const registrations = await store.readAll({
          eventNames: [domain.billing.customer.registered], reverse: true,
          fromPosition: before, limit: pageSize + 1,
        });
        const newest = registrations[0]?.position;
        if (newest && (!minimum || comparePositions(newest, minimum) > 0)) minimum = newest;
        if (minimum && (await readmodels.waitFor(minimum, ["billing"])).behind) {
          res.status(503).set("Retry-After", "1").json({ code: "customers-behind" });
          return;
        }
        const page = registrations.slice(0, pageSize);
        const documents = await readmodels.billing.customers.find({ _id: { in: page.map((event) => event.stream.id) } });
        if (documents.length !== page.length) {
          res.status(503).set("Retry-After", "1").json({ code: "customers-behind" });
          return;
        }
        const byId = new Map(documents.map((document) => [document._id, document]));
        res.json({
          items: page.map((event) => byId.get(event.stream.id)),
          nextCursor: registrations.length > pageSize ? encodePosition(page.at(-1)!.position) : null,
        });
      },
    },
    {
      method: "post",
      path: "/customers",
      handler: command(
        (req) => domain.billing.customer.register(undefined, req.body),
        { creates: true, respondWith: "billing.customers" },
      ),
    },
    {
      method: "post",
      path: "/customers/:id/contacts",
      handler: command(
        (req) => domain.billing.customer.addContact(String(req.params.id), req.body),
        { respondWith: "billing.customers" },
      ),
    },
    /* The list reads pages over HTTP and uses this feed only for change hints. */
    {
      method: "get",
      path: "/customers/live",
      handler: async (req: Request, res: Response) => {
        const { readmodels } = handle<Caller>(req);
        let feed: ReturnType<typeof sse> | undefined;
        const subscription = await readmodels.subscribe(
          "billing",
          "customers",
          (notification) =>
            feed?.send("changed", {
              ids: notification.ids,
              position: encodePosition(notification.position),
            }),
          { initialSize: 0 },
        );
        feed = sse(req, res, { heartbeat: 15_000 });
        feed.send("snapshot", subscription.initial);
        req.on("close", () => void subscription.stop());
      },
    },
    {
      method: "get",
      path: "/customers/:id",
      handler: readmodel("billing", "customers", {
        id: (req) => String(req.params.id),
      }),
    },

    /*
     * A live feed (Server-Sent Events) of one customer's Invoices. Readmodel
     * Notifications are at-most-once hints carrying a Position: a client re-reads on
     * each one, and re-reads everything after reconnecting.
     */
    {
      method: "get",
      path: "/customers/:id/invoices/live",
      handler: async (req: Request, res: Response) => {
        const { readmodels } = handle<Caller>(req);
        let feed: ReturnType<typeof sse> | undefined;
        // Subscribe before opening the stream, so a 403 is still a normal response.
        // A change before the stream opens is already in `initial`.
        const subscription = await readmodels.subscribe(
          "billing",
          "invoices",
          (notification) =>
            feed?.send("changed", {
              ids: notification.ids,
              position: encodePosition(notification.position),
            }),
          { filter: { customerId: String(req.params.id) } },
        );
        feed = sse(req, res, { heartbeat: 15_000 });
        feed.send("snapshot", subscription.initial);
        req.on("close", () => void subscription.stop());
      },
    },
    /* One customer's Subscriptions, over the `customerId` index. */
    {
      method: "get",
      path: "/customers/:id/subscriptions",
      handler: async (req: Request, res: Response) => {
        const { readmodels } = handle<Caller>(req);
        res.json(await readmodels.billing.subscriptions.find({ customerId: String(req.params.id) }));
      },
    },

    /*
     * ─── Subscriptions (decorated Aggregate and Readmodels) ───
     * A decorated Command class builds its Command with `to()`; routes, Access map and
     * `respondWith` treat it like any other.
     */
    {
      method: "post",
      path: "/subscriptions",
      handler: command((req) => StartSubscription.to(undefined, req.body), {
        creates: true,
        respondWith: "billing.subscriptions",
        codes: { [subscriptionRejections.unknownCustomer]: 422 },
      }),
    },
    {
      method: "post",
      path: "/subscriptions/:id/cancel",
      handler: command(
        (req) => CancelSubscription.to(String(req.params.id), req.body),
        { respondWith: "billing.subscriptions" },
      ),
    },
    {
      method: "get",
      path: "/subscriptions/:id",
      handler: readmodel("billing", "subscriptions", {
        id: (req) => String(req.params.id),
      }),
    },

    /* ─── Reports ─── */
    {
      method: "get",
      path: "/reports/revenue/:day",
      handler: readmodel("reporting", "revenue", {
        id: (req) => String(req.params.day),
      }),
    },
    {
      method: "get",
      path: "/reports/plans/:plan",
      handler: readmodel("reporting", "plans", {
        id: (req) => String(req.params.plan),
      }),
    },
  ],
});
