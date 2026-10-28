import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePositions } from "./lib/position.ts";
import { errorOf } from "./services/api.ts";
import { matchRoute } from "./services/router.ts";

const token = (tx: number, seq: number) => Buffer.from(`${tx}:${seq}`).toString("base64url");

test("routes map hash paths to page modules and their params", () => {
  assert.deepEqual(matchRoute(""), { path: "/", module: "dashboard", params: {} });
  assert.deepEqual(matchRoute("#/customers/a%20b").params, { id: "a b" });
  assert.equal(matchRoute("#/invoices").module, "invoices");
  assert.deepEqual(matchRoute("#/events/billing/invoice/42").params, { context: "billing", aggregate: "invoice", id: "42" });
  assert.deepEqual(matchRoute("#/events").params, {});
  assert.equal(matchRoute("#/nope/x/y").module, "not-found");
  assert.deepEqual(matchRoute("#/invoices?q=acme%20ltd&status=open"), { path: "/invoices", module: "invoices", params: { q: "acme ltd", status: "open" } });
});

test("positions order by transaction, then sequence, beyond Number precision", () => {
  assert.equal(comparePositions(token(2, 0), token(1, 9)), 1);
  assert.equal(comparePositions(token(1, 3), token(1, 10)), -1);
  assert.equal(comparePositions(token(5, 5), token(5, 5)), 0);
  const big = Buffer.from("9007199254740993:1").toString("base64url");
  const bigger = Buffer.from("9007199254740993:2").toString("base64url");
  assert.equal(comparePositions(bigger, big), 1);
});

test("a Rejection's message and code reach the user", () => {
  const rejected = errorOf(409, { status: "rejected", error: { code: "already-settled", message: "Invoice is settled" } });
  assert.equal(rejected.message, "Invoice is settled");
  assert.equal(rejected.code, "already-settled");
  assert.equal(errorOf(403, { code: "forbidden", message: "Forbidden" }).message, "Forbidden");
  assert.equal(errorOf(502, null).message, "Request failed (HTTP 502)");
});
