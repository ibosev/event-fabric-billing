/**
 * ─── The dunning Workflow across deployments, on Postgres ──────────────────────
 * `dunning-deployments.ts` on the Postgres Event store, in a schema of its own that is
 * dropped afterwards. `npm run test:postgres`; defaults to the compose Postgres.
 */
import { after, test } from "node:test";
import { Pool } from "pg";
import { createPostgresEventStore } from "event-fabric";
import { dunningAcrossDeployments } from "./dunning-deployments.js";

const pool = new Pool({
  connectionString: process.env.DUNNING_TEST_DATABASE_URL ?? "postgres://billing:billing@127.0.0.1:55432/billing",
});
const schema = `billing_dunning_${Date.now()}`;
after(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

test("dunning on Postgres: runs to the end, survives a restart mid-wait, and a careless deploy drifts only the instance it broke", { timeout: 60_000 }, async () => {
  // A shared pool: closing an Application leaves it open for the next deployment.
  const store = createPostgresEventStore({ pool, schema });
  await store.migrate();
  await dunningAcrossDeployments(store);
});
