/**
 * ─── The dunning Workflow across deployments, in memory ────────────────────────
 * `dunning-deployments.ts` on the in-memory store; `dunning-postgres.integration.ts`
 * runs the same scenario on Postgres.
 */
import { test } from "node:test";
import { createInMemoryEventStore } from "event-fabric/testing";
import { dunningAcrossDeployments } from "./dunning-deployments.js";

test("dunning on the memory store: runs to the end, survives a restart mid-wait, and a careless deploy drifts only the instance it broke", () =>
  dunningAcrossDeployments(createInMemoryEventStore()));
