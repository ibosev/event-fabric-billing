/** Exercises the ordinary settings routes through a real Gateway and Postgres. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { createApplication, type Logger } from "event-fabric";
import { createInMemoryEventStore, createInMemoryTransport } from "event-fabric/testing";
import { api } from "./gateway/api.js";
import { readmodelServices } from "./services/readmodel.js";
import { setupServices } from "./services/setup.js";
import { settingsRoutes } from "./settings/routes.js";
import type { SettingResponse } from "./settings/dto.js";

const database = process.env.SETTINGS_TEST_DATABASE_URL;
if (!database) throw new Error("SETTINGS_TEST_DATABASE_URL must name a disposable Postgres database");
const pool = new Pool({ connectionString: database });
let base = "";
const logger: Logger = {
  debug() {}, warn() {}, error() {},
  info({ address }: { address?: { port: number } }) {
    if (address) base = `http://127.0.0.1:${address.port}`;
  },
  child() { return this; },
};
const store = createInMemoryEventStore();
const makeApplication = () => createApplication({
  name: "settings-test",
  store,
  transport: createInMemoryTransport(),
  setupServices: setupServices(database, 0),
  readmodelServices,
  gateways: { api: api({ port: 0, store }) },
  plugins: [settingsRoutes],
  logger,
});
let application = makeApplication();
before(async () => {
  await pool.query(await readFile(new URL("../database/settings.sql", import.meta.url), "utf8"));
  await application.start();
});
after(async () => {
  try {
    await application.close();
    await pool.query("DELETE FROM settings WHERE tenant = ANY($1::text[])", [[tenant, otherTenant]]);
  } finally {
    await pool.end();
  }
});

const tenant = randomUUID();
const otherTenant = randomUUID();
const call = async <T = SettingResponse>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Role": "admin", "X-Tenant": tenant, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: (response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text) as T };
};

test("an administrator creates a setting and reads it immediately", async () => {
  const created = await call("POST", "/settings", { key: "invoice.footer", value: "Thank you" });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.body, { key: "invoice.footer", value: "Thank you" });
  assert.equal(created.headers.get("Location"), "/settings/invoice.footer");
  assert.equal(created.headers.get("EventFabric-Position"), null);
  assert.equal(created.headers.get("EventFabric-Command-Id"), null);
  const read = await call("GET", "/settings/invoice.footer");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, created.body);
});

test("settings are listed by key, updated in place and deleted with an empty response", async () => {
  assert.equal((await call("POST", "/settings", { key: "app.language", value: "en" })).status, 201);
  const list = await call<SettingResponse[]>("GET", "/settings");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, [
    { key: "app.language", value: "en" },
    { key: "invoice.footer", value: "Thank you" },
  ]);
  const updated = await call("PUT", "/settings/app.language", { value: "" });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, { key: "app.language", value: "" });
  assert.deepEqual((await call("GET", "/settings/app.language")).body, updated.body);
  const deleted = await call("DELETE", "/settings/app.language");
  assert.equal(deleted.status, 204);
  assert.equal(deleted.text, "");
  assert.equal((await call("GET", "/settings/app.language")).status, 404);
  assert.equal((await call("PUT", "/settings/app.language", { value: "missing" })).status, 404);
  assert.equal((await call("DELETE", "/settings/app.language")).status, 404);
});

test("invalid DTOs and URL keys return 400 without changing stored settings", async () => {
  for (const body of [
    null, [], {}, { key: "valid", value: 7 }, { key: "", value: "x" },
    { key: "UPPER", value: "x" }, { key: "a".repeat(65), value: "x" },
    { key: "valid", value: "x".repeat(4097) }, { key: "valid", value: "\0" },
    { key: "valid", value: "x", tenant: "someone-else" },
  ]) assert.equal((await call("POST", "/settings", body)).status, 400, JSON.stringify(body));
  for (const body of [{}, { value: null }, { value: "changed", key: "renamed" }, { value: "x", tenant: "elsewhere" }])
    assert.equal((await call("PUT", "/settings/invoice.footer", body)).status, 400);
  for (const method of ["GET", "PUT", "DELETE"])
    assert.equal((await call(method, "/settings/bad%20key", method === "PUT" ? { value: "x" } : undefined)).status, 400);
  assert.deepEqual((await call("GET", "/settings/invoice.footer")).body, { key: "invoice.footer", value: "Thank you" });
});

test("clerks only read and every operation stays in the caller's tenant", async () => {
  const clerk = { "X-Role": "clerk" };
  assert.equal((await call("POST", "/settings", { key: "forbidden", value: "x" }, clerk)).status, 403);
  assert.equal((await call("PUT", "/settings/invoice.footer", { value: "changed" }, clerk)).status, 403);
  assert.equal((await call("DELETE", "/settings/invoice.footer", undefined, clerk)).status, 403);
  assert.equal((await call("GET", "/settings/invoice.footer", undefined, clerk)).status, 200);
  assert.equal((await call("GET", "/settings", undefined, clerk)).status, 200);
  const other = { "X-Tenant": otherTenant };
  assert.equal((await call("GET", "/settings/invoice.footer", undefined, other)).status, 404);
  assert.equal((await call("PUT", "/settings/invoice.footer", { value: "stolen" }, other)).status, 404);
  assert.equal((await call("DELETE", "/settings/invoice.footer", undefined, other)).status, 404);
  assert.deepEqual((await call("GET", "/settings", undefined, other)).body, []);
  assert.equal((await call("POST", "/settings", { key: "invoice.footer", value: "Other tenant" }, other)).status, 201);
  assert.equal((await call("POST", "/settings", { key: "invoicePrefix", value: "INV" }, other)).status, 201);
  assert.deepEqual((await call("GET", "/settings/invoice.footer")).body, { key: "invoice.footer", value: "Thank you" });
  assert.deepEqual((await call("GET", "/settings")).body, [{ key: "invoice.footer", value: "Thank you" }]);
});

test("a duplicate key returns 409, including concurrent creates", async () => {
  assert.equal((await call("POST", "/settings", { key: "invoice.footer", value: "replacement" })).status, 409);
  const responses = await Promise.all([
    call("POST", "/settings", { key: "race", value: "first" }),
    call("POST", "/settings", { key: "race", value: "second" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.deepEqual((await call("GET", "/settings/race")).body, responses.find((response) => response.status === 201)!.body);
  assert.deepEqual((await call("GET", "/settings/invoice.footer")).body, { key: "invoice.footer", value: "Thank you" });
});

test("settings survive recreating the Application and produce no Events or Outbox entries", async () => {
  assert.deepEqual(await store.readAll(), []);
  assert.equal((await store.outboxStats()).pending, 0);
  await application.close();
  application = makeApplication();
  await application.start();
  assert.deepEqual((await call("GET", "/settings/invoice.footer")).body, { key: "invoice.footer", value: "Thank you" });
  assert.deepEqual(await store.readAll(), []);
  assert.equal((await store.outboxStats()).pending, 0);
});
