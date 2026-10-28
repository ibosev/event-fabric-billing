/**
 * ─── Operating across deployments ──────────────────────────────────────────────
 * Several Applications on one Event store, as successive deployments or replicas
 * would run: a Saga deployed after the Events it reacts to, a rejected Outbox
 * Command an operator must see, stable Worker Idempotency keys, a Saga group a
 * deployment dropped, and Command handlers selected by Context.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication, type ApplicationConfig } from "event-fabric";
import {
  createInMemoryEventStore,
  createInMemoryTransport,
  createMemoryReadmodelStore,
  accepted,
} from "event-fabric/testing";
import { customer } from "./domain/customer.js";
import { domain } from "./domain/index.js";
import { invoice } from "./domain/invoice.js";
import { SubscriptionAggregate } from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { accounts } from "./sagas/accounts.js";
import { receipts } from "./sagas/receipts.js";
import type { Services } from "./services/index.js";
import { readmodelServices } from "./services/readmodel.js";
import { receiptSender } from "./workers/receipts.js";

const store = createInMemoryEventStore();
const keys: string[] = [];
const base = {
  aggregates: [invoice, customer, SubscriptionAggregate],
  store,
  transport: createInMemoryTransport(),
  services: {
    registry: { verify: async () => {} },
    mailer: {
      sendReceipt: async ({ invoiceId }: { invoiceId: string }, { idempotencyKey }: { idempotencyKey: string }) => {
        keys.push(idempotencyKey);
        return `receipt-${invoiceId}`;
      },
      sendReminder: async () => "reminder",
    },
    get settings(): Services["settings"] { throw new Error("Settings are not used by this test"); },
  },
  readmodelServices,
  // Replicas list their groups every third of a Lease, so a stopped one is forgotten quickly.
  leaseDuration: 300,
  pollInterval: 10,
} satisfies Omit<ApplicationConfig, "name">;

/* The first deployment: Commands only, plus a throwaway Saga a later deployment drops. */
const first = createApplication({
  ...base,
  name: "billing-first",
  sagas: { trial: { reactions: { [domain.billing.invoice.issued]: () => {} } } },
});
/* The next deployment: the accounts and receipts Sagas, the Readmodels they read, the Worker. */
const next = createApplication({
  ...base,
  name: "billing-next",
  readmodelStore: createMemoryReadmodelStore(),
  readmodels: { billing },
  // New Sagas start at now; these handle the Invoice the first deployment recorded.
  sagas: { accounts: { ...accounts, from: "beginning" }, receipts: { ...receipts, from: "beginning" } },
  workers: { receipts: receiptSender },
});
const status = async (group: string) =>
  (await next.consumerStatus()).find((entry) => entry.group === group)?.state;
let refused = "";
before(async () => {
  await first.start();
  // Before any Saga runs: an Invoice over the credit limit, already part paid.
  const registered = await accepted(first.sendCommand(domain.billing.customer.register(undefined, { name: "Small Ltd", creditLimit: 50 })));
  const issued = await accepted(first.sendCommand(domain.billing.invoice.issue(undefined, {
    customerId: registered.events[0]!.stream.id, debtor: "Small Ltd", amount: 80, dueDate: "2026-12-31",
  })));
  refused = issued.events[0]!.stream.id;
  await accepted(first.sendCommand(domain.billing.invoice.recordPayment(refused, { amount: 10 })));
  for (let i = 0; i < 100 && !(await store.consumers()).some((entry) => entry.group === "saga:trial"); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await first.stop();
  await next.start();
});
after(async () => {
  await next.close();
  await first.close();
});

const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  let value = await read();
  for (let i = 0; i < 150 && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
};

test("Saga Commands the Aggregates reject are dead-lettered with their Rejections", async () => {
  /*
   * The accounts Saga, deployed later, charges the Customer, who refuses. Voiding the
   * part-paid Invoice is then rejected, and so is crediting its payment to a balance the
   * refused charge never raised. Both wait for an operator: `event-fabric dead-letters
   * list`, then `replay <id>` once the data is fixed.
   */
  const letters = await eventually(
    () => store.deadLetters(),
    (entries) => entries.filter((entry) => entry.kind === "outbox-rejected").length === 2,
  );
  const rejected = letters
    .filter((entry) => entry.kind === "outbox-rejected")
    .map((entry) => [entry.message?.message.name, entry.rejection?.code])
    .sort();
  assert.deepEqual(rejected, [["creditPayment", "rule"], ["void", "has-payments"]]);
  assert.ok(letters.every((entry) => entry.kind !== "outbox-rejected" || entry.correlationId));
  const voiding = letters.find((entry) => entry.rejection?.code === "has-payments")?.message?.message;
  assert.equal(voiding && "stream" in voiding && voiding.stream.id, refused);
});

test("a receipt's Idempotency key names the Saga, its instance, the Event and the suffix", async () => {
  const registered = await accepted(next.sendCommand(domain.billing.customer.register(undefined, { name: "Payer Ltd" })));
  const customerId = registered.events[0]!.stream.id;
  const issued = await accepted(next.sendCommand(domain.billing.invoice.issue(undefined, {
    customerId, debtor: "Payer Ltd", amount: 20, dueDate: "2026-12-31",
  })));
  const id = issued.events[0]!.stream.id;
  const settled = await next.sendCommand(domain.billing.invoice.recordPayment(id, { amount: 20 }))
    .await(domain.billing.invoice.settled);
  // Stable across re-deliveries, Partitions and replicas, so the provider sends one receipt.
  const expected = JSON.stringify(["saga:receipts", id, settled.id, "receipt"]);
  assert.deepEqual(await eventually(async () => keys, (seen) => seen.includes(expected)), [expected]);
});

test("163: the receipts Worker replies to the Saga instance, which confirms the receipt", async () => {
  const registered = await accepted(next.sendCommand(domain.billing.customer.register(undefined, { name: "Payer Ltd" })));
  const customerId = registered.events[0]!.stream.id;
  const issued = await accepted(next.sendCommand(domain.billing.invoice.issue(undefined, {
    customerId, debtor: "Payer Ltd", amount: 20, dueDate: "2026-12-31",
  })));
  const id = issued.events[0]!.stream.id;
  await next.sendCommand(domain.billing.invoice.recordPayment(id, { amount: 20 }));
  const events = await eventually(
    () => store.readStream({ context: "billing", aggregate: "invoice", id }),
    (events) => events.some((event) => event.name === "receiptSent"),
  );
  assert.deepEqual(events.find((event) => event.name === "receiptSent")?.payload, { reference: `receipt-${id}` });
});

test("a Saga group no deployment declares is marked undeclared and can be retired", async () => {
  assert.equal(await eventually(() => status("saga:trial"), (state) => state === "undeclared"), "undeclared");
  assert.equal(await status("saga:accounts"), "running");
  await assert.rejects(next.retireConsumer("saga:accounts"), /still declared/);
  // `event-fabric consumers retire saga:trial` does the same from the CLI.
  await next.retireConsumer("saga:trial");
  assert.equal(await status("saga:trial"), undefined);
});

test("`only` selects Command handlers by Context and refuses an unknown one", async () => {
  const selective = createApplication({ ...base, name: "billing-commands", store: createInMemoryEventStore() });
  try {
    await assert.rejects(selective.start({ only: ["commands:billing-commands/sales"] }), /Unknown component selector/);
  } finally {
    await selective.close();
  }
});
