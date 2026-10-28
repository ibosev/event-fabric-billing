import {
  createLogger,
  createPostgresEventStore,
  Type,
  type ApplicationConfig,
} from "event-fabric";
import { createMongoReadmodelStore } from "event-fabric/mongo";
import { createPostgresReadmodelStore } from "event-fabric/postgres";
import { createRabbitMQTransport } from "event-fabric/rabbitmq";
import { MongoClient } from "mongodb";
import { customer } from "./domain/customer.js";
import { invoice } from "./domain/invoice.js";
import { SubscriptionAggregate } from "./domain/subscription.js";
import { api } from "./gateway/api.js";
import { audit } from "./plugins/audit.js";
import { devtools } from "./plugins/devtools.js";
import { billing } from "./readmodels/invoices.js";
import { reporting } from "./readmodels/reporting.js";
import { accounts } from "./sagas/accounts.js";
import { receipts } from "./sagas/receipts.js";
import { Renewals } from "./sagas/renewals.js";
import { readmodelServices } from "./services/readmodel.js";
import { setupServices } from "./services/setup.js";
import { settingsRoutes } from "./settings/routes.js";
import { receiptSender } from "./workers/receipts.js";
import { reminderSender } from "./workers/reminders.js";
import { dunning } from "./workflows/dunning.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/**
 * ─── Metadata ──────────────────────────────────────────────────────────────────
 * The Application's own data carried with every Command, Event and Message and
 * inherited down each chain. EventFabric checks it against this schema on arrival
 * and on every write, and caps its size. It is never erased: ids, not personal data.
 */
const metadataSchema = Type.Object(
  {
    actor: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    customerId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const metadataMaxBytes = 2048;

/**
 * ─── Application `billing` ─────────────────────────────────────────────────────
 * The composition root. `main.ts` starts the Application from it; the CLI
 * (`event-fabric migrate|task|rebuild|consumers|dead-letters --config
 * dist/event-fabric.config.js`) and rebuild worker threads load this named export.
 */
export const config = async (): Promise<ApplicationConfig> => {
  const database = required("DATABASE_URL");
  const settingsDatabase = required("SETTINGS_DATABASE_URL");
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? "info" });
  const partitions = Number(process.env.PARTITIONS ?? 1);
  /*
   * The Event log, Outbox, Leases, Checkpoints and Saga state live in Postgres.
   * `metadataIndexes` indexes a Metadata path for `readAll` and operators;
   * `migrate` builds it concurrently, so appends keep running.
   */
  const store = createPostgresEventStore({
    connectionString: database,
    // Every Consumer group, the Outbox and Command handling of a replica share these.
    poolOptions: { max: Number(process.env.PG_POOL_MAX ?? 20) },
    schema: "billing_events",
    metadataIndexes: ["customerId"],
    metadataSchema,
    metadataMaxBytes,
  });
  /*
   * `BILLING_STORE=mongo` keeps the `billing` group in Mongo (a replica set) while the
   * Event log stays in Postgres. The client is the Application's, so it closes it.
   */
  const mongo = process.env.BILLING_STORE === "mongo" ? new MongoClient(required("MONGO_URL")) : undefined;
  const billingStore =
    mongo && Object.assign(createMongoReadmodelStore({ client: mongo, database: "billing" }), { close: () => mongo.close() });
  return {
    name: "billing",
    logger,
    // `aggregate()` declarations and decorated classes (`@Aggregate`) mix freely.
    aggregates: [invoice, customer, SubscriptionAggregate],

    store,
    metadataSchema,
    metadataMaxBytes,

    /* The default store of every Readmodel group; a group may set its own `store`. */
    readmodelStore: createPostgresReadmodelStore({
      connectionString: database,
      schema: "billing_readmodels",
    }),

    /*
     * Carries Commands to their Aggregate's Partition, Worker Messages, and
     * Notifications. RabbitMQ here; an in-memory transport for tests and one process.
     * Each replica subscribes to every Command queue with a priority derived from its
     * `instance` (a fresh id per process), so the Command Partitions spread over the
     * replicas and move within seconds when one stops (ADR-0015).
     * It connects when the Application starts, so `migrate` and rebuild workers need no broker.
     */
    transport: await createRabbitMQTransport({
      url: required("AMQP_URL"),
      application: "billing",
    }),

    /*
     * `partitions` runs a group as N Partitions spread over the replicas. Each document
     * (or Saga instance) belongs to one Partition and still sees every Event that
     * touches it in log order; changing N hands over at one Position, nothing lost.
     */
    /*
     * A pending rebuild records a fingerprint of the group's Reactions and schemas and only
     * resumes or swaps under the same one. Function source cannot show a helper change, so
     * bump `rebuildVersion` when `readmodelServices.addMoney` changes. It never rebuilds
     * active documents by itself: run `rebuild reporting` for that.
     */
    readmodels: { billing: { ...billing, partitions, store: billingStore }, reporting: { ...reporting, rebuildVersion: "1" } },
    sagas: {
      accounts: { ...accounts, partitions },
      // One Partition tops out near 150 settled Invoices/s: each needs a Readmodel read.
      receipts: { ...receipts, partitions },
      renewals: Renewals,
    },
    /*
     * A Workflow is one function that waits, run as Consumer group `workflow:dunning` with
     * Partitions and Leases like a Saga; its journal and state commit with the Outbox.
     */
    workflows: { dunning },
    workers: { receipts: receiptSender, reminders: reminderSender },
    gateways: {
      api: api({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST, store }),
    },
    setupServices: setupServices(settingsDatabase, Number(process.env.REGISTRY_DELAY_MS ?? 0)),
    /* Readmodel Reactions get these helpers instead of `services`, so a rebuild cannot send mail. */
    readmodelServices,
    /* `devtools` exposes the whole Event log, so only a local run turns it on. */
    plugins: process.env.DEVTOOLS === "1" ? [settingsRoutes, audit, devtools] : [settingsRoutes, audit],

    /* Drain requests and consumers for up to this long on shutdown. */
    shutdownTimeout: 10_000,
  };
};
