/**
 * ─── Types config ──────────────────────────────────────────────────────────────
 * Declarations only, so `event-fabric types` needs no Postgres or RabbitMQ. It writes
 * `src/event-fabric.generated.d.ts`, the Register that types string names: Access-map
 * keys, `readmodel("group", "model")`, `respondWith`, `app.getDomain()` and
 * `app.getReadmodels()`. `npm run check` fails while that file is stale.
 */
import { customer } from "./domain/customer.js";
import { invoice } from "./domain/invoice.js";
import { SubscriptionAggregate } from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { reporting } from "./readmodels/reporting.js";
import { receiptSender } from "./workers/receipts.js";
import { reminderSender } from "./workers/reminders.js";
import { dunning } from "./workflows/dunning.js";

export const config = {
  aggregates: [invoice, customer, SubscriptionAggregate],
  readmodels: { billing, reporting },
  workers: { receipts: receiptSender, reminders: reminderSender },
  workflows: { dunning },
  typesPath: "src/event-fabric.generated.d.ts",
};
