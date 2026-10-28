import { randomUUID } from "node:crypto";
import { aggregate, only, Rejection, Type } from "event-fabric";

/*
 * ─── Schemas ───────────────────────────────────────────────────────────────────
 * Every payload is a TypeBox schema. The same value is the payload's TypeScript
 * type and the JSON Schema that EventFabric checks at runtime: a Command's
 * payload before any Step runs, an Event's payload before it is appended.
 */
export const Issued = Type.Object(
  {
    customerId: Type.String({ minLength: 1 }),
    debtor: Type.String({ minLength: 1 }),
    amount: Type.Number({ exclusiveMinimum: 0 }),
    dueDate: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);
const Method = Type.Union([Type.Literal("bank-transfer"), Type.Literal("card")]);
/** What a caller sends. `method` is optional: TypeBox types do not record defaults. */
export const Payment = Type.Object(
  { amount: Type.Number({ exclusiveMinimum: 0 }), method: Type.Optional(Method) },
  { additionalProperties: false },
);
/** What is recorded: Schema version 2 always names the method (see `paymentRecorded`). */
const PaymentRecorded = Type.Object(
  { amount: Type.Number({ exclusiveMinimum: 0 }), method: Method },
  { additionalProperties: false },
);
const Receipt = Type.Object(
  { reference: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const Voided = Type.Object(
  { reason: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const Empty = Type.Object({}, { additionalProperties: false });
const DueDate = Type.Object(
  { dueDate: Type.String({ format: "date" }) },
  { additionalProperties: false },
);

/**
 * Rejection codes the Gateway maps to HTTP statuses. A Rejection's `kind` picks the
 * default status (validation 400, existence 404, precondition and rule 422,
 * conflict 409); a Gateway route may override it per `code`.
 */
export const invoiceRejections = {
  alreadySettled: "already-settled",
  voided: "voided",
  overpaid: "overpaid",
  hasPayments: "has-payments",
  notDue: "not-due",
  unknownCustomer: "unknown-customer",
} as const;

const DAY = 86_400_000;
/** The moment an Invoice becomes overdue: the end of its due date, in UTC. */
export const overdueAt = (dueDate: string) =>
  new Date(Date.parse(dueDate) + DAY).toISOString();

/**
 * ─── Aggregate `billing.invoice` ───────────────────────────────────────────────
 * `aggregate(context, name, { ... })` declares a consistency unit. Every type comes
 * from this call, with no type arguments: `state` types `get`/`set`/`initialState`,
 * each Event schema types `invoice.apply.<event>(payload)` and its handler, and each
 * Command schema types `command.payload` in its Steps.
 */
export const invoice = aggregate("billing", "invoice", {
  state: Type.Object({
    customerId: Type.String(),
    debtor: Type.String(),
    amount: Type.Number(),
    paid: Type.Number(),
    dueDate: Type.String(),
    status: Type.Union([
      Type.Literal("open"),
      Type.Literal("overdue"),
      Type.Literal("settled"),
      Type.Literal("void"),
    ]),
    receipt: Type.Union([Type.String(), Type.Null()]),
  }),
  initialState: {
    customerId: "",
    debtor: "",
    amount: 0,
    paid: 0,
    dueDate: "",
    status: "open",
    receipt: null,
  },

  /* A Command sent without an id (`issue(undefined, ...)`) gets one from here. */
  idGenerator: () => randomUUID(),

  /*
   * Runs once per Event about to be committed, after the Rules, and merges the result
   * into that Event's Metadata. Here every Invoice Event carries its customer, so the
   * Event store's `metadataIndexes: ["customerId"]` can find a customer's history.
   * Metadata is never erased: ids only, no personal data.
   */
  eventEnricher: (_event, state) => ({ customerId: state.get("customerId") }),

  /*
   * ─── Commands ───
   * Each Command checks its payload against `schema`, then runs `steps` in order.
   * `only.ifExists()`/`only.ifNotExists()` reject on the Stream's existence before
   * any Step. A Step is a Precondition when it throws and a handler when it applies
   * Events; only throwing rejects, a returned value never does. `apply` folds the
   * Event into the state at once, and every applied Event commits together when the
   * Command succeeds, or none do.
   */
  commands: {
    /*
     * An Invoice belongs to a Customer that already exists. The check loads the
     * Customer's Stream from the Event store, not a Readmodel, so a Customer registered
     * a moment ago is found; and a Customer is never deleted, so it cannot vanish
     * before this Invoice commits.
     */
    issue: {
      schema: Issued,
      steps: [
        only.ifNotExists(),
        async (command, invoice, app) => {
          const { customerId } = command.payload;
          const customer = await app.getDomain().billing.customer(customerId).load();
          if (customer.revision === 0)
            throw new Rejection(
              "precondition",
              "Customer does not exist",
              { customerId },
              invoiceRejections.unknownCustomer,
            );
          invoice.apply.issued(command.payload);
          app.schedule("overdue", overdueAt(command.payload.dueDate), {
            stream: { context: "billing", aggregate: "invoice", id: invoice.id }, name: "markOverdue",
          });
        },
      ],
    },

    recordPayment: {
      schema: Payment,
      steps: [
        only.ifExists(),
        // A Precondition: throws a Rejection, and the Command records nothing.
        (_, invoice) => {
          const status = invoice.get("status");
          if (status === "settled")
            throw new Rejection(
              "precondition",
              "Invoice is already settled",
              undefined,
              invoiceRejections.alreadySettled,
            );
          if (status === "void")
            throw new Rejection(
              "precondition",
              "Invoice is void",
              undefined,
              invoiceRejections.voided,
            );
        },
        // A handler. `locals` carries temporary values to the Rules; they are never stored.
        (command, invoice, app) => {
          invoice.locals.outstanding = invoice.get("amount") - invoice.get("paid");
          invoice.apply.paymentRecorded({
            amount: command.payload.amount,
            method: command.payload.method ?? "bank-transfer",
          });
          const paid = invoice.get("paid");
          if (paid >= invoice.get("amount")) {
            invoice.apply.settled({ paid });
            app.cancelSchedule("overdue");
          }
        },
      ],
      /*
       * Rules run after every Step, with the state after and before them and the
       * Events applied. A Rule that throws rejects the whole Command: here a payment
       * larger than what is owed records nothing, not even `paymentRecorded`.
       */
      rules: [
        (current) => {
          if (current.get("paid") > current.get("amount"))
            throw new Rejection(
              "rule",
              "Payment exceeds the outstanding amount",
              { outstanding: current.locals.outstanding },
              invoiceRejections.overpaid,
            );
        },
      ],
    },

    changeDueDate: {
      schema: DueDate,
      steps: [
        only.ifExists(),
        (command, invoice, app) => {
          // This example only reschedules an open Invoice; an overdue Event stays historical.
          if (invoice.get("status") !== "open")
            throw new Rejection("precondition", "Only an open Invoice can change its due date");
          invoice.apply.dueDateChanged(command.payload);
          app.schedule("overdue", overdueAt(command.payload.dueDate), {
            stream: { context: "billing", aggregate: "invoice", id: invoice.id }, name: "markOverdue",
          });
        },
      ],
    },

    /* A Schedule dispatches this check; ordinary manual checks still enforce the due date. */
    markOverdue: {
      schema: Empty,
      steps: [
        only.ifExists(),
        (command, invoice) => {
          if (invoice.get("status") !== "open") return;
          if (command.now.toISOString() < overdueAt(invoice.get("dueDate")))
            throw new Rejection(
              "precondition",
              "Invoice is not due yet",
              undefined,
              invoiceRejections.notDue,
            );
          invoice.apply.becameOverdue({});
        },
      ],
    },

    /* Admin only: the Gateway's Access map checks the caller's role (see `gateway/api.ts`). */
    void: {
      schema: Voided,
      steps: [
        only.ifExists(),
        (command, invoice, app) => {
          if (invoice.get("paid") > 0)
            throw new Rejection(
              "precondition",
              "An Invoice with payments cannot be voided",
              undefined,
              invoiceRejections.hasPayments,
            );
          if (invoice.get("status") === "void") return;
          invoice.apply.voided(command.payload);
          app.cancelSchedule("overdue");
        },
      ],
    },

    /* Sent by the receipts Worker only; the Gateway's Access map does not expose it. */
    confirmReceipt: {
      schema: Receipt,
      steps: [
        only.ifExists(),
        (command, invoice) => invoice.apply.receiptSent(command.payload),
      ],
    },
  },

  /*
   * ─── Events ───
   * Each Event folds into the state, both when it is applied and whenever the Invoice
   * is loaded from its Stream. Handlers must be deterministic: no clock, no I/O.
   */
  events: {
    issued: {
      schema: Issued,
      handler: ({ payload }, state) =>
        state.set({
          customerId: payload.customerId,
          debtor: payload.debtor,
          amount: payload.amount,
          dueDate: payload.dueDate,
          status: "open",
        }),
    },

    /*
     * Schema version 2 added `method`. Stored Events are never rewritten: an Event
     * recorded at version 1 passes through `upcasters[1]` (1 → 2) whenever it is read,
     * so handlers, Readmodels and Sagas only ever see the current shape.
     */
    dueDateChanged: {
      schema: DueDate,
      handler: ({ payload }, state) => state.set("dueDate", payload.dueDate),
    },
    paymentRecorded: {
      schema: PaymentRecorded,
      schemaVersion: 2,
      upcasters: { 1: (payload) => ({ ...payload, method: "bank-transfer" }) },
      handler: ({ payload }, state) =>
        state.set("paid", state.get("paid") + payload.amount),
    },

    settled: {
      schema: Type.Object({ paid: Type.Number() }, { additionalProperties: false }),
      handler: (_, state) => state.set("status", "settled"),
    },
    becameOverdue: {
      schema: Empty,
      handler: (_, state) => state.set("status", "overdue"),
    },
    voided: {
      schema: Voided,
      handler: (_, state) => state.set("status", "void"),
    },
    receiptSent: {
      schema: Receipt,
      handler: ({ payload }, state) => state.set("receipt", payload.reference),
    },

    /*
     * A retired Event: no Command applies it any more, but older Invoices may hold it.
     * Event names are permanent, so it stays declared with its schema and a no-op
     * handler; startup refuses a log holding an Event name no Aggregate declares.
     */
    reminderSent: {
      schema: Empty,
      handler: () => {},
    },
  },
});
