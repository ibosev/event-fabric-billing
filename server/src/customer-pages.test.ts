import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication, encodePosition, type Logger } from "event-fabric";
import { createInMemoryEventStore, createInMemoryTransport, createMemoryReadmodelStore } from "event-fabric/testing";
import { customer } from "./domain/customer.js";
import { domain } from "./domain/index.js";
import { api } from "./gateway/api.js";
import { customers, type Customer } from "./readmodels/customers.js";
import type { Services } from "./services/index.js";
import { readmodelServices } from "./services/readmodel.js";

let base = "";
const logger: Logger = {
  debug() {}, warn() {}, error() {},
  info({ address }: { address?: { port: number } }) {
    if (address) base = `http://127.0.0.1:${address.port}`;
  },
  child() { return this; },
};
const store = createInMemoryEventStore();
const application = createApplication({
  name: "customer-pages-test", logger,
  store, transport: createInMemoryTransport(),
  aggregates: [customer], readmodelStore: createMemoryReadmodelStore(),
  // Two Partitions: the SSE feed still announces registrations from either one.
  readmodels: { billing: { models: { customers }, partitions: 2 } },
  gateways: { api: api({ port: 0, store }) }, pollInterval: 10,
  services: {
    registry: { verify: async () => {} }, mailer: { sendReceipt: async () => "unused", sendReminder: async () => "unused" },
    get settings(): Services["settings"] { throw new Error("Settings are not used by this test"); },
  },
  readmodelServices,
  // Equal timestamps prove paging uses registration order, not random Customer ids.
  clock: () => new Date("2026-10-19T10:00:00Z"),
});
const ids: string[] = [];
before(async () => {
  await application.start();
  for (let i = 0; i < 25; i++) {
    const outcome = await application.sendCommand(domain.billing.customer.register(undefined, { name: `Customer ${i}` }));
    assert.equal(outcome.status, "accepted");
    ids.push(outcome.events[0]!.stream.id);
  }
});
after(() => application.close());
type Page = { items: Customer[]; nextCursor: string | null };
const page = async (query = ""): Promise<Page> => {
  const response = await fetch(`${base}/customers${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test("customer pages contain the latest 20 and a stable next page when a registration arrives", async () => {
  const first = await page();
  assert.deepEqual(first.items.map(({ _id }) => _id), ids.slice(5).reverse());
  assert.ok(first.nextCursor);
  const response = await fetch(`${base}/customers`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Newest customer" }),
  });
  assert.equal(response.status, 201);
  const added: Customer = await response.json();
  const next = await page(`?before=${first.nextCursor}`);
  assert.deepEqual(next.items.map(({ _id }) => _id), ids.slice(0, 5).reverse());
  assert.equal(next.nextCursor, null);
  const latest = await page();
  assert.equal(latest.items.length, 20);
  assert.equal(latest.items[0]!._id, added._id);
  assert.deepEqual(await page(`?before=${encodePosition({ transactionId: "0", sequence: "0" })}`), { items: [], nextCursor: null });
});

test("customer pagination rejects malformed cursors", async () => {
  for (const query of ["?before=bad!", "?before=", "?before=a&before=b", "?minPosition=invalid", `?before=${"a".repeat(129)}`])
    assert.equal((await fetch(`${base}/customers${query}`)).status, 400);
});

test("the customer SSE feed opens without documents and announces registrations for a page refresh", async () => {
  const response = await fetch(`${base}/customers/live`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  try {
    let text = "";
    while (!text.includes("event: snapshot\ndata: []\n\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(text.length < 100);
    const created = await fetch(`${base}/customers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Live customer" }),
    });
    assert.equal(created.status, 201);
    const customer: Customer = await created.json();
    while (!text.includes("event: changed\n") || !text.endsWith("\n\n"))
      text += new TextDecoder().decode((await reader.read()).value);
    const changed = text.split("\n\n").find((frame) => frame.startsWith("event: changed\n"))!;
    const notification: { ids: string[]; position: string } = JSON.parse(changed.split("\ndata: ")[1]!);
    assert.deepEqual(notification.ids, [customer._id]);
    assert.equal((await page(`?minPosition=${notification.position}`)).items[0]!._id, customer._id);
  } finally {
    await reader.cancel();
  }
});
