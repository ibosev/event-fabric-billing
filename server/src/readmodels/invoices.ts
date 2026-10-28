import {
  DateTime,
  Type,
  type Document,
  type EventsOf,
  type ReactionView,
  type ReadmodelGroupConfig,
  type Reactions,
} from "event-fabric";
import { domain } from "../domain/index.js";
import { customers } from "./customers.js";
import { Subscriptions } from "./subscriptions.js";

/**
 * ─── Readmodel `billing.invoices` ──────────────────────────────────────────────
 * A queryable collection of documents, one per Invoice, kept up to date by reacting
 * to Events. The schema decides the storage: on Postgres each scalar field is a typed
 * column and `payments`, an array of objects, gets its own child table.
 */
const Invoice = Type.Object({
  customerId: Type.String(),
  debtor: Type.String(),
  amount: Type.Number(),
  paid: Type.Number(),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("overdue"),
    Type.Literal("settled"),
    Type.Literal("void"),
  ]),
  dueDate: Type.String(),
  payments: Type.Array(
    Type.Object({
      amount: Type.Number(),
      method: Type.String(),
      // A date-time field: stored as a timestamp, read back as a `Date`.
      at: DateTime(),
    }),
  ),
  receipt: Type.Union([Type.String(), Type.Null()]),
  // Optional: absent until the Invoice is voided, and read back as `null`.
  voidReason: Type.Optional(Type.String()),
});
/** A document of the Readmodel `billing.invoices`, as stores return it. */
export type Invoice = Document<typeof Invoice>;

/*
 * Reactions are keyed by qualified Event names from the domain, so each payload is
 * typed by its Event. With no `identity`, an Event updates the document whose id is
 * its Stream id, here the Invoice id. Reactions must be deterministic: dates come
 * from the Event's `timestamp`.
 */
const reactions: Reactions<EventsOf<typeof domain>, ReactionView<Invoice>> = {
  [domain.billing.invoice.issued]: ({ payload }, vm) =>
    vm.set({
      customerId: payload.customerId,
      debtor: payload.debtor,
      amount: payload.amount,
      paid: 0,
      status: "open",
      dueDate: payload.dueDate,
      payments: [],
      receipt: null,
    }),
  [domain.billing.invoice.paymentRecorded]: ({ payload, timestamp }, vm) =>
    vm.set({
      paid: vm.get("paid") + payload.amount,
      payments: [
        ...vm.get("payments"),
        { amount: payload.amount, method: payload.method, at: new Date(timestamp) },
      ],
    }),
  [domain.billing.invoice.settled]: (_, vm) => vm.set("status", "settled"),
  [domain.billing.invoice.dueDateChanged]: ({ payload }, vm) => vm.set("dueDate", payload.dueDate),
  [domain.billing.invoice.becameOverdue]: (_, vm) => vm.set("status", "overdue"),
  [domain.billing.invoice.voided]: ({ payload }, vm) =>
    vm.set({ status: "void", voidReason: payload.reason }),
  [domain.billing.invoice.receiptSent]: ({ payload }, vm) =>
    vm.set("receipt", payload.reference),
};

/**
 * ─── Readmodel group `billing` ─────────────────────────────────────────────────
 * Readmodels deployed and Checkpointed together. Each group processes the Event log
 * in order and commits its documents and Checkpoint atomically. With no `store`, the
 * group uses the Application's `readmodelStore`; a group may set its own.
 *
 * Changing a schema is safe: the store notices the new schema hash and rebuilds a
 * shadow generation from the Event log in the background, then swaps it in. The
 * replica starts and serves everything else at once; reads of this group answer 503
 * until the swap, and `health().rebuilding` names it. `migrations` can
 * instead upgrade a known hash in place.
 */
export const billing = {
  models: {
    invoices: {
      schema: Invoice,
      indexes: [
        { fields: ["status"] },
        { fields: ["customerId", "dueDate"] },
        // A text index enables `q` searches: `GET /invoices?q=debtor`.
        { fields: ["debtor"], text: true },
      ],
      reactions,
    },
    customers,
    // A decorated Readmodel (`@Readmodel` class) sits in the same group and Checkpoint.
    subscriptions: Subscriptions,
  },
} satisfies ReadmodelGroupConfig;
