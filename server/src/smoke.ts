/**
 * ─── End-to-end smoke test ─────────────────────────────────────────────────────
 * Drives the running Application through HTTP only:
 *
 *   Command → Readmodel → Saga → Outbox → Worker → Command → Readmodel
 *
 * plus the Access map, idempotent retries, Rules, delayed Commands, text search,
 * awaitCorrelated, the dunning Workflow, the reporting group, ordinary settings CRUD
 * and the audit route.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Static } from "event-fabric";
import type { WorkflowQuery } from "event-fabric/workflows";
import type { Issued, Payment } from "./domain/invoice.js";
import type { Customer } from "./readmodels/customers.js";
import type { Invoice } from "./readmodels/invoices.js";
import type { Plan, Subscription } from "./readmodels/subscriptions.js";
import type { SettingResponse } from "./settings/dto.js";
import type { dunning } from "./workflows/dunning.js";

const base = process.env.API_URL ?? "http://localhost:3000";
const call = async <T = Invoice>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-User": "smoke", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (response.status === 204 ? undefined : await response.json()) as T,
  };
};
const admin = { "X-Role": "admin" };
const issue = (payload: Static<typeof Issued>) => call("POST", "/invoices", payload);
const pay = (id: string, payload: Static<typeof Payment>, headers?: Record<string, string>) =>
  call("POST", `/invoices/${id}/payments`, payload, headers);

const dunningOf = (invoiceId: string, headers?: Record<string, string>) =>
  call<WorkflowQuery<typeof dunning>>("GET", `/invoices/${invoiceId}/dunning`, undefined, headers);

// Polls until `done` holds or 15 seconds pass; Saga effects arrive asynchronously.
const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
};

/* ─── Ordinary settings: Gateway → controller → service → repository → Postgres ─── */
const settingsCaller = { ...admin, "X-Tenant": randomUUID() };
const settingPayload = { key: "invoicePrefix", value: "INV" };
assert.equal((await call("POST", "/settings", settingPayload)).status, 403);
const setting = await call<SettingResponse>("POST", "/settings", settingPayload, settingsCaller);
assert.equal(setting.status, 201, JSON.stringify(setting.body));
assert.equal(setting.headers.get("Location"), "/settings/invoicePrefix");
assert.equal(setting.headers.get("EventFabric-Position"), null);
assert.deepEqual(setting.body, settingPayload);
assert.deepEqual((await call("GET", "/settings/invoicePrefix", undefined, settingsCaller)).body, settingPayload);
assert.deepEqual((await call("GET", "/settings", undefined, settingsCaller)).body, [settingPayload]);
assert.equal((await call("POST", "/settings", settingPayload, settingsCaller)).status, 409);
assert.equal((await call("GET", "/settings/invoicePrefix", undefined, { "X-Tenant": randomUUID() })).status, 404);
const changedSetting = await call("PUT", "/settings/invoicePrefix", { value: "BILL" }, settingsCaller);
assert.equal(changedSetting.status, 200);
assert.deepEqual(changedSetting.body, { key: "invoicePrefix", value: "BILL" });
const deletedSetting = await call("DELETE", "/settings/invoicePrefix", undefined, settingsCaller);
assert.equal(deletedSetting.status, 204);
assert.equal(deletedSetting.body, undefined);
assert.equal((await call("GET", "/settings/invoicePrefix", undefined, settingsCaller)).status, 404);
console.log("ordinary settings CRUD persisted immediately across HTTP requests");

/* ─── Customer and Invoice ─── */
const registered = await call<Customer>("POST", "/customers", { name: "Example Debtor Ltd" });
assert.equal(registered.status, 201, JSON.stringify(registered.body));
const customerId = registered.body._id;
console.log(`registered customer ${customerId}`);

// A creation retried under its Idempotency-Key is the same Command: the same id and Customer, nothing twice.
const creation = { "Idempotency-Key": randomUUID() };
const created = await call<Customer>("POST", "/customers", { name: "Retry Ltd" }, creation);
const recreated = await call<Customer>("POST", "/customers", { name: "Retry Ltd" }, creation);
assert.equal(created.status, 201, JSON.stringify(created.body));
assert.equal(recreated.headers.get("EventFabric-Duplicate"), "true");
assert.equal(recreated.headers.get("EventFabric-Command-Id"), created.headers.get("EventFabric-Command-Id"));
assert.equal(recreated.body._id, created.body._id);
console.log("a retried creation answered the first Customer");

const issued = await issue({ customerId, debtor: "Example Debtor Ltd", amount: 100, dueDate: "2099-12-31" });
assert.equal(issued.status, 201, JSON.stringify(issued.body));
assert.equal(issued.body.status, "open");
assert.ok(issued.headers.get("EventFabric-Position"), "responses carry their Position");
assert.match(issued.headers.get("Server-Timing") ?? "", /total;dur=/);
const id = issued.body._id;
console.log(`issued invoice ${id}`);

/* ─── The dunning Workflow: one instance per Invoice, queried and signalled over HTTP ─── */
const chasing = await eventually(() => dunningOf(id), (response) => response.status === 200);
assert.deepEqual(chasing.body, { status: "running", state: { stage: "awaiting-payment", remindersSent: 0 } });
assert.equal((await dunningOf(id, { "X-Customer-Id": customerId })).status, 403, "staff only");
assert.equal((await call("POST", `/invoices/${id}/promise`, { until: "soon" })).status, 400, "the Signal's schema");
assert.equal((await call("POST", `/invoices/${id}/promise`, { until: "2099-12-31" })).status, 202);
console.log("dunning waits for the payment and took a promise to pay");

// Schema check before the Aggregate: 400.
assert.equal((await call("POST", "/invoices", { debtor: "", amount: -1 })).status, 400);

/* ─── Payments: idempotent retries and the overpayment Rule ─── */
const key = { "Idempotency-Key": randomUUID() };
const partial = await pay(id, { amount: 40, method: "card" }, key);
assert.equal(partial.status, 200, JSON.stringify(partial.body));
assert.equal(partial.body.paid, 40);
const retried = await pay(id, { amount: 40, method: "card" }, key);
assert.equal(retried.headers.get("EventFabric-Duplicate"), "true");
assert.equal(retried.body.paid, 40, "a retried request does not pay twice");
assert.equal((await pay(id, { amount: 41 }, key)).status, 409, "a key reused for another request");
console.log("idempotent retry accepted once");

// Read your own write on any replica: send back the Position the write answered with.
const position = partial.headers.get("EventFabric-Position")!;
for (let i = 0; i < 3; i++) {
  const own = await call("GET", `/invoices/${id}`, undefined, { "EventFabric-Min-Position": position });
  assert.equal(own.status, 200);
  assert.equal(own.body.paid, 40);
  assert.equal(own.headers.get("EventFabric-Behind"), null);
}
console.log("read its own write through the load balancer");

const overpaid = await pay(id, { amount: 500 });
assert.equal(overpaid.status, 422);
console.log("overpayment rejected by the Rule");

/* ─── Settle and wait for the receipt (awaitCorrelated) ─── */
const settle = await call<{ receipt: string }>("POST", `/invoices/${id}/settle`, {});
assert.equal(settle.status, 200, JSON.stringify(settle.body));
assert.equal(settle.body.receipt, `receipt-${id}`);
console.log(`settled; receipt ${settle.body.receipt}`);
assert.equal((await pay(id, { amount: 1 })).status, 409, "a settled Invoice takes no payments");

const read = await call("GET", `/invoices/${id}`);
assert.equal(read.body.status, "settled");
assert.deepEqual(read.body.payments.map((p) => p.method), ["card", "bank-transfer"]);
const paidUp = await eventually(() => dunningOf(id), (response) => response.body.status === "completed");
assert.deepEqual(paidUp.body, { status: "completed", state: { stage: "settled", remindersSent: 0 }, result: "settled" });
console.log("the payment ended the dunning");

/* ─── Delayed Command: an Invoice past its due date becomes overdue ─── */
const late = await issue({ customerId, debtor: "Late Payer GmbH", amount: 30, dueDate: "2020-01-31" });
const overdue = await eventually(
  async () => (await call("GET", `/invoices/${late.body._id}`)).body,
  (doc) => doc.status === "overdue",
);
assert.equal(overdue.status, "overdue");
console.log("overdue Schedule marked the late Invoice");
// Long past due: the dunning asks the reminders Worker at once, then gives up on it.
const chased = await eventually(() => dunningOf(late.body._id), (response) => response.body.status === "completed");
assert.deepEqual(chased.body, { status: "completed", state: { stage: "overdue", remindersSent: 1 }, result: "overdue" });
console.log("dunning reminded the late payer, then marked the Invoice overdue");

/* ─── Void: admin only, and only without payments ─── */
const voidable = await issue({ customerId, debtor: "Example Debtor Ltd", amount: 25, dueDate: "2099-01-31" });
const vid = voidable.body._id;
assert.equal((await call("POST", `/invoices/${vid}/void`, { reason: "duplicate" })).status, 403);
const voided = await call("POST", `/invoices/${vid}/void`, { reason: "duplicate" }, admin);
assert.equal(voided.status, 200, JSON.stringify(voided.body));
assert.equal(voided.body.status, "void");
assert.equal(voided.body.voidReason, "duplicate");
await pay(late.body._id, { amount: 10 });
assert.equal(
  (await call("POST", `/invoices/${late.body._id}/void`, { reason: "x" }, admin)).status,
  422,
);
console.log("void allowed for admin only, and not after a payment");

/* ─── Queries: filters, text search, and the customer-portal filter ─── */
const settledList = await call<Invoice[]>("GET", "/invoices?status=settled", undefined, { "X-Customer-Id": customerId });
assert.ok(settledList.body.some((doc) => doc._id === id));
const searched = await call<Invoice[]>("GET", `/invoices?q=${encodeURIComponent('"late payer"')}`, undefined, { "X-Customer-Id": customerId });
assert.ok(searched.body.some((doc) => doc._id === late.body._id));
assert.ok(searched.body.every((doc) => doc.debtor === "Late Payer GmbH"));
const byCard = await call<Invoice[]>("GET", "/invoices?method=card", undefined, { "X-Customer-Id": customerId });
assert.deepEqual(byCard.body.map((doc) => doc._id), [id], "only the Invoice with a card payment");
const portal = await call<Invoice[]>("GET", "/invoices", undefined, { "X-Customer-Id": randomUUID() });
assert.equal(portal.body.length, 0, "a portal caller sees only their own Invoices");
console.log("queries, text search and the Access-map filter work");

/* ─── The accounts Saga keeps the Customer's balance ─── */
// Invoiced 100 + 30 + 25, voided 25; paid 100 + 10.
const account = await eventually(
  async () => (await call<Customer>("GET", `/customers/${customerId}`)).body,
  (doc) => doc.paid === 110 && doc.invoiced === 130,
);
assert.equal(account.invoiced, 130);
assert.equal(account.paid, 110);
assert.equal(account.balance, 20);
console.log(`customer balance: ${account.balance}`);

/* ─── A refused charge: recorded as an Event, compensated by the Saga ─── */
const small = await call<Customer>("POST", "/customers", { name: "Small Ltd", creditLimit: 50 });
assert.equal(small.body.creditLimit, 50);
const tooBig = await issue({ customerId: small.body._id, debtor: "Small Ltd", amount: 80, dueDate: "2099-01-31" });
assert.equal(tooBig.status, 201, "issuing succeeds; the Customer refuses the charge later");
const refused = await eventually(
  async () => (await call("GET", `/invoices/${tooBig.body._id}`)).body,
  (doc) => doc.status === "void",
);
assert.equal(refused.voidReason, "Credit limit exceeded");
assert.equal((await call<Customer>("GET", `/customers/${small.body._id}`)).body.balance, 0);
console.log("charge over the credit limit refused; Invoice voided by the Saga");

/* ─── The reporting group, admin only ─── */
const day = new Date().toISOString().slice(0, 10);
assert.equal((await call("GET", `/reports/revenue/${day}`)).status, 403);
const revenue = await eventually(
  async () =>
    (await call<{ total: number; byMethod: Record<string, number> }>(
      "GET", `/reports/revenue/${day}`, undefined, admin,
    )).body,
  (doc) => (doc?.total ?? 0) >= 110,
);
assert.ok(revenue.total >= 110);
assert.ok((revenue.byMethod.card ?? 0) >= 40);
console.log(`revenue today: ${revenue.total}`);

/* ─── Decorated components: a Subscription bills a period, the Saga issues its Invoice ─── */
const subscriber = await call<Customer>("POST", "/customers", { name: "Subscriber Ltd" });
const plan = { customerId: subscriber.body._id, debtor: "Subscriber Ltd", plan: "pro", monthlyAmount: 30 };
const startsOn = new Date().toISOString().slice(0, 10);
assert.equal(
  (await call("POST", "/subscriptions", { ...plan, customerId: randomUUID(), startsOn })).status,
  422,
  "a Subscription needs an existing Customer",
);
const stranger = { "X-Customer-Id": randomUUID() };
assert.equal(
  (await call("POST", "/subscriptions", { ...plan, startsOn }, stranger)).status,
  403,
  "a portal caller subscribes only themselves",
);
const subscription = await call<Subscription>("POST", "/subscriptions", { ...plan, startsOn });
assert.equal(subscription.status, 201, JSON.stringify(subscription.body));
const subscriptionId = subscription.body._id;
assert.equal(subscription.body.periods, 1);
assert.deepEqual(subscription.body.invoices, [`${subscriptionId}-period-1`]);
const firstInvoice = await eventually(
  async () => (await call("GET", `/invoices/${subscriptionId}-period-1`)).body,
  (doc) => doc?.status === "open",
);
assert.equal(firstInvoice.amount, 30);
assert.equal((await call("GET", "/reports/plans/pro")).status, 403);
const pro = await eventually(
  async () => (await call<Plan>("GET", "/reports/plans/pro", undefined, admin)).body,
  (doc) => (doc?.active ?? 0) >= 1,
);
assert.ok(pro.monthlyRevenue >= 30);
assert.equal(
  (await call("POST", `/subscriptions/${subscriptionId}/cancel`, { reason: "smoke" }, stranger)).status,
  403,
  "only staff cancel a Subscription",
);
const ended = await call<Subscription>("POST", `/subscriptions/${subscriptionId}/cancel`, { reason: "smoke" });
assert.equal(ended.status, 200, JSON.stringify(ended.body));
assert.equal(ended.body.status, "cancelled");
const listed = await call<Subscription[]>("GET", `/customers/${plan.customerId}/subscriptions`);
assert.ok(listed.body.some((doc) => doc._id === subscriptionId && doc.status === "cancelled"));
assert.deepEqual(
  (await call<Subscription[]>("GET", `/customers/${plan.customerId}/subscriptions`, undefined, stranger)).body,
  [],
  "the Access map filters another customer's Subscriptions out for a portal caller",
);
console.log(`subscription ${subscriptionId} billed its first Invoice and was cancelled`);

/* ─── The audit plugin's route ─── */
const model = await call<{ sagas: string[] }>("GET", "/ops/model");
assert.deepEqual(model.body.sagas.sort(), ["accounts", "receipts", "renewals"]);

console.log(`statement: docker compose run --rm --no-deps app node_modules/event-fabric/dist/cli/main.js task dist/tasks/statement.js --config dist/event-fabric.config.js -- ${customerId}`);
console.log("smoke test passed");
