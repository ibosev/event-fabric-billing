/**
 * ─── Testing in process ────────────────────────────────────────────────────────
 * `event-fabric/testing` provides in-memory Event and Readmodel stores and transport,
 * so the same Aggregates, Readmodels and Sagas run in one process with no Postgres
 * or RabbitMQ. `npm test` runs this file with Node's test runner.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  assertDeclaredEvents,
  createApplication,
  type ApplicationConfig,
} from "event-fabric";
import {
  createInMemoryEventStore,
  createInMemoryTransport,
  createMemoryReadmodelStore,
} from "event-fabric/testing";
import { domain } from "./domain/index.js";
import { customer } from "./domain/customer.js";
import { invoice } from "./domain/invoice.js";
import {
  CancelSubscription,
  RenewSubscription,
  StartSubscription,
  SubscriptionAggregate,
} from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { reporting } from "./readmodels/reporting.js";
import { accounts } from "./sagas/accounts.js";
import { Renewals } from "./sagas/renewals.js";
import { createRegistry } from "./services/registry.js";
import type { Services } from "./services/index.js";
import { readmodelServices } from "./services/readmodel.js";

/* A controllable clock: Command Steps read it through `command.now`. */
let now = new Date("2026-10-15T12:00:00Z");
const store = createInMemoryEventStore();
const application = createApplication({
  name: "billing-test",
  // Decorated classes and `aggregate()` declarations in one Application.
  aggregates: [invoice, customer, SubscriptionAggregate],
  store,
  transport: createInMemoryTransport(),
  readmodelStore: createMemoryReadmodelStore(),
  // Two Partitions, as replicas would share them: each document and Saga instance still sees its Events in order.
  readmodels: { billing: { ...billing, partitions: 2 }, reporting },
  sagas: { accounts: { ...accounts, partitions: 2 }, renewals: Renewals },
  // Every registered service is required; a fake stands in for the mail provider.
  services: {
    registry: createRegistry(0), mailer: { sendReceipt: async () => "receipt", sendReminder: async () => "reminder" },
    get settings(): Services["settings"] { throw new Error("Settings belong to the HTTP/Postgres test"); },
  },
  readmodelServices,
  clock: () => now,
  pollInterval: 10,
} satisfies ApplicationConfig);
before(() => application.start());
after(() => application.close());

const send = application.sendCommand;
const issue = async (amount: number, dueDate = "2026-12-31") => {
  const registered = await send(
    domain.billing.customer.register(undefined, { name: "Example Debtor Ltd" }),
  );
  assert.equal(registered.status, "accepted");
  const customerId = registered.events[0]!.stream.id;
  const issued = await send(
    domain.billing.invoice.issue(undefined, {
      customerId,
      debtor: "Example Debtor Ltd",
      amount,
      dueDate,
    }),
  );
  assert.equal(issued.status, "accepted");
  return { customerId, id: issued.events[0]!.stream.id, issued };
};

test("a payment over the outstanding amount is rejected by the Rule", async () => {
  const { id } = await issue(100);
  const outcome = await send(domain.billing.invoice.recordPayment(id, { amount: 150 }));
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.status === "rejected" && outcome.error.code, "overpaid");
  assert.deepEqual(outcome.status === "rejected" && outcome.error.details, {
    outstanding: 100,
  });
});

test("paying in full settles, and the Event carries the enriched Metadata", async () => {
  const { id, customerId } = await issue(100);
  const outcome = await send(
    domain.billing.invoice.recordPayment(id, { amount: 100, method: "card" }),
  );
  assert.equal(outcome.status, "accepted");
  const names = outcome.status === "accepted" ? outcome.events.map((e) => e.name) : [];
  assert.deepEqual(names, ["paymentRecorded", "settled"]);
  assert.equal(outcome.status === "accepted" && outcome.events[0]!.metadata.customerId, customerId);

  // Read your own write: wait until the Readmodel reaches the Command's Position.
  const position = outcome.status === "accepted" ? outcome.events.at(-1)!.position : undefined;
  const { document } = await application.readmodels.billing.invoices(id, { minPosition: position });
  assert.equal(document?.status, "settled");
  assert.equal(document?.payments[0]?.method, "card");
  assert.ok(document?.payments[0]?.at instanceof Date);
});

test("the Application reports itself live and ready, with no rebuild pending", async () => {
  const health = await eventually(() => application.health(), (value) => value.readiness);
  assert.deepEqual(health, {
    liveness: true, readiness: true, postgres: true, broker: true, leases: true, rebuilding: [],
  });
});

test("sendCommand(...).await returns a recorded Event, and load reads an earlier Revision", async () => {
  const { id } = await issue(100);
  // `.await` picks the named Event out of the Command's own Events.
  const settled = await send(domain.billing.invoice.recordPayment(id, { amount: 100 })).await(
    domain.billing.invoice.settled,
  );
  assert.equal(settled.payload.paid, 100);
  // A domain handle loads the State, now or as it was at a Revision.
  const invoiceHandle = application.getDomain().billing.invoice(id);
  assert.equal((await invoiceHandle.load()).get("status"), "settled");
  assert.equal((await invoiceHandle.load({ atRevision: 1 })).get("status"), "open");
});

test("every Event name in the log is declared, retired ones included; an unknown name is refused", async () => {
  // The resolved declarations: the decorated Subscription class as an Aggregate definition.
  const aggregates = [...application.model.aggregates];
  await assertDeclaredEvents(store, aggregates);
  // `run` and `migrate` refuse to start on a log like this: Event names are permanent.
  const renamed = { eventNames: async () => ["billing.invoice.issued", "billing.invoice.reminderMailed"] };
  await assert.rejects(assertDeclaredEvents(renamed, aggregates), /billing\.invoice\.reminderMailed/);
  assert.ok(invoice.events.reminderSent, "the retired Event stays declared");
});

test("revenue sums money through the Readmodel helpers, not the Application services", async () => {
  now = new Date("2026-10-17T09:00:00Z");
  try {
    const { id } = await issue(1);
    await send(domain.billing.invoice.recordPayment(id, { amount: 0.1, method: "card" }));
    const second = await send(domain.billing.invoice.recordPayment(id, { amount: 0.2, method: "card" }));
    const minPosition = second.status === "accepted" ? second.events.at(-1)!.position : undefined;
    const { document } = await application.readmodels.reporting.revenue("2026-10-17", { minPosition });
    assert.deepEqual([document?.total, document?.byMethod.card], [0.3, 0.3]);
  } finally {
    now = new Date("2026-10-15T12:00:00Z");
  }
});

test("a Command id is accepted once", async () => {
  const { id } = await issue(100);
  const input = domain.billing.invoice.recordPayment(id, { amount: 10 }, { id: crypto.randomUUID() });
  const first = await send(input);
  const again = await send(input);
  assert.equal(first.status, "accepted");
  assert.equal(again.status === "accepted" && again.duplicate, true);
});

test("the Invoice owns its overdue Schedule through partial payment, due-date change and settlement", async () => {
  const { id } = await issue(100);
  const stream = { context: "billing", aggregate: "invoice", id };
  const original = await application.getSchedule(stream, "overdue");
  assert.equal(original?.dueAt, "2027-01-01T00:00:00.000Z");
  await send(domain.billing.invoice.recordPayment(id, { amount: 25 }));
  assert.deepEqual(await application.getSchedule(stream, "overdue"), original);
  const changed = await send({ stream, name: "changeDueDate", payload: { dueDate: "2027-01-15" } });
  assert.equal(changed.status, "accepted");
  const replacement = await application.getSchedule(stream, "overdue");
  assert.notEqual(replacement?.commandId, original?.commandId);
  assert.equal(replacement?.dueAt, "2027-01-16T00:00:00.000Z");
  const { document } = await application.readmodels.billing.invoices(id, { minPosition: changed.events.at(-1)!.position });
  assert.equal(document?.dueDate, "2027-01-15");
  const paid = await send(domain.billing.invoice.recordPayment(id, { amount: 75 }));
  assert.equal(paid.status, "accepted");
  assert.deepEqual(paid.cancellations, { overdue: "cancelled" });
  assert.equal(await application.getSchedule(stream, "overdue"), null);
  // A dispatched ordinary check also remains harmless after settlement.
  assert.deepEqual((await send(domain.billing.invoice.markOverdue(id, {}))).status, "accepted");
});

test("voiding an Invoice cancels its overdue Schedule", async () => {
  const { id } = await issue(100);
  const outcome = await send(domain.billing.invoice.void(id, { reason: "Cancelled" }));
  assert.equal(outcome.status, "accepted");
  assert.deepEqual(outcome.cancellations, { overdue: "cancelled" });
  assert.equal(await application.getSchedule({ context: "billing", aggregate: "invoice", id }, "overdue"), null);
});

test("markOverdue is refused before the due date and applies after it", async () => {
  const { id } = await issue(100, "2026-10-20");
  const early = await send(domain.billing.invoice.markOverdue(id, {}));
  assert.equal(early.status === "rejected" && early.error.code, "not-due");

  now = new Date("2026-10-21T00:00:01Z");
  const late = await send(domain.billing.invoice.markOverdue(id, {}));
  assert.deepEqual(late.status === "accepted" && late.events.map((e) => e.name), ["becameOverdue"]);
  now = new Date("2026-10-15T12:00:00Z");
});

test("a Schema version 1 payment is upcast when read", async () => {
  const { id } = await issue(100);
  const stream = { context: "billing", aggregate: "invoice", id };
  const [head] = await store.readStream(stream).then((events) => events.slice(-1));
  // Append an Event as an older release recorded it: version 1 had no `method`.
  await store.appendToStream(stream, head!.revision, [
    {
      id: crypto.randomUUID(),
      name: "paymentRecorded",
      payload: { amount: 5 },
      metadata: {},
      schemaVersion: 1,
      timestamp: now.toISOString(),
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
    },
  ]);
  const events = await store.readStream(stream);
  assert.deepEqual(events.at(-1)!.payload, { amount: 5, method: "bank-transfer" });
  assert.equal(events.at(-1)!.schemaVersion, 2);
});

test("a charge over the credit limit is refused, and the Saga voids the Invoice", async () => {
  const registered = await send(
    domain.billing.customer.register(undefined, { name: "Small Ltd", creditLimit: 50 }),
  );
  const customerId = registered.status === "accepted" ? registered.events[0]!.stream.id : "";
  const issued = await send(
    domain.billing.invoice.issue(undefined, {
      customerId,
      debtor: "Small Ltd",
      amount: 80,
      dueDate: "2026-12-31",
    }),
  );
  const id = issued.status === "accepted" ? issued.events[0]!.stream.id : "";
  let invoice;
  for (let i = 0; i < 100 && invoice?.status !== "void"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    invoice = (await application.readmodels.billing.invoices(id)).document;
  }
  assert.equal(invoice?.status, "void");
  assert.equal(invoice?.voidReason, "Credit limit exceeded");
  const account = (await application.readmodels.billing.customers(customerId)).document;
  assert.equal(account?.balance, 0, "a refused charge is never reversed");
});

test("the accounts Saga charges the Customer", async () => {
  const { customerId } = await issue(70);
  let account;
  for (let i = 0; i < 100 && account?.balance !== 70; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    account = (await application.readmodels.billing.customers(customerId)).document;
  }
  assert.equal(account?.balance, 70);
});

test("an Invoice for a Customer that does not exist is rejected", async () => {
  const outcome = await send(
    domain.billing.invoice.issue(undefined, {
      customerId: "nobody",
      debtor: "Nobody Ltd",
      amount: 10,
      dueDate: "2026-12-31",
    }),
  );
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.status === "rejected" && outcome.error.code, "unknown-customer");
});

/* ─── Decorated components: Subscription Aggregate, Readmodels and the renewals Saga ─── */
const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  let value = await read();
  for (let i = 0; i < 150 && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
};
const subscribe = async (monthlyAmount: number, creditLimit?: number, plan: "basic" | "pro" = "pro") => {
  const registered = await send(
    domain.billing.customer.register(undefined, { name: "Subscriber Ltd", creditLimit }),
  );
  assert.equal(registered.status, "accepted");
  const customerId = registered.events[0]!.stream.id;
  const started = await send(
    StartSubscription.to(undefined, {
      customerId,
      debtor: "Subscriber Ltd",
      plan,
      monthlyAmount,
      startsOn: "2026-10-15",
    }),
  );
  assert.equal(started.status, "accepted");
  return { customerId, id: started.events[0]!.stream.id, started };
};

test("a decorated Subscription bills its first period, and the decorated Saga issues the Invoice", async () => {
  const { id, customerId, started } = await subscribe(30);
  assert.deepEqual(
    started.status === "accepted" && started.events.map((e) => [e.name, e.metadata.customerId]),
    [["started", customerId], ["periodBilled", customerId]],
  );
  const invoice = await eventually(
    async () => (await application.readmodels.billing.invoices(`${id}-period-1`)).document,
    (document) => document !== null,
  );
  assert.deepEqual(
    { amount: invoice?.amount, dueDate: invoice?.dueDate, status: invoice?.status },
    { amount: 30, dueDate: "2026-10-29", status: "open" },
  );
  const { document } = await application.readmodels.billing.subscriptions(id);
  assert.deepEqual(
    { periods: document?.periods, invoices: document?.invoices, nextRenewal: document?.nextRenewal },
    { periods: 1, invoices: [`${id}-period-1`], nextRenewal: "2026-11-15" },
  );
});

test("renew is refused before its period starts, bills it after, and a resend records nothing", async () => {
  const { id } = await subscribe(30);
  const early = await send(RenewSubscription.to(id, { period: 2 }));
  assert.equal(early.status === "rejected" && early.error.code, "not-due");

  now = new Date("2026-11-15T00:00:01Z");
  try {
    const renewed = await send(RenewSubscription.to(id, { period: 2 }));
    assert.deepEqual(renewed.status === "accepted" && renewed.events.map((e) => e.payload.period), [2]);
    const again = await send(RenewSubscription.to(id, { period: 2 }));
    assert.deepEqual(again.status === "accepted" && again.events, []);
  } finally {
    now = new Date("2026-10-15T12:00:00Z");
  }
  const invoice = await eventually(
    async () => (await application.readmodels.billing.invoices(`${id}-period-2`)).document,
    (document) => document !== null,
  );
  assert.equal(invoice?.dueDate, "2026-11-29");
});

test("cancelling updates the decorated reporting Readmodel keyed by associationProperty", async () => {
  const plan = async () => (await application.readmodels.reporting.plans("basic")).document;
  const { id } = await subscribe(25, undefined, "basic");
  const before = await eventually(plan, (document) => (document?.active ?? 0) > 0);
  const cancelled = await send(CancelSubscription.to(id, { reason: "moving away" }));
  assert.deepEqual(cancelled.status === "accepted" && cancelled.events.map((e) => e.name), ["cancelled"]);
  const after = await eventually(plan, (document) => document?.active === before!.active - 1);
  assert.equal(after?.monthlyRevenue, before!.monthlyRevenue - 25);
  const { document } = await application.readmodels.billing.subscriptions(id);
  assert.deepEqual([document?.status, document?.cancelReason], ["cancelled", "moving away"]);
});

test("a charge the Customer refuses cancels the Subscription (existing Event → decorated Saga)", async () => {
  const { id } = await subscribe(80, 50);
  const document = await eventually(
    async () => (await application.readmodels.billing.subscriptions(id)).document,
    (document) => document?.status === "cancelled",
  );
  assert.equal(document?.cancelReason, "credit-limit");
  const invoice = (await application.readmodels.billing.invoices(`${id}-period-1`)).document;
  assert.equal(invoice?.status, "void", "the accounts Saga voids the refused Invoice as before");
});
