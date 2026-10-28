import {
  DateTime,
  Type,
  type Document,
  type EventsOf,
  type Identities,
  type ReactionView,
  type ReadmodelApp,
  type ReadmodelGroupConfig,
  type Reactions,
} from "event-fabric";
import { domain } from "../domain/index.js";
import { Plans } from "./subscriptions.js";

/**
 * ─── Readmodel `reporting.revenue` ─────────────────────────────────────────────
 * Payments received per day, in a second Readmodel group. A separate group has its
 * own Checkpoint, so it can be rebuilt (`event-fabric rebuild reporting`) or
 * deployed (`--only readmodels:reporting`) without touching `billing`.
 */
const Revenue = Type.Object({
  total: Type.Number(),
  payments: Type.Number(),
  // `"x-store": "json"` stores the field as one JSON value instead of columns:
  // the way to keep a map with keys not known in advance.
  byMethod: Type.Record(Type.String(), Type.Number(), { "x-store": "json" }),
  lastPaymentAt: DateTime(),
});
export type Revenue = Document<typeof Revenue>;

/*
 * Identity maps an Event to the document(s) it updates. By default that is the
 * Stream id; here a payment updates the document of the day it was recorded, so many
 * Invoices feed one document. An Identity may also return several ids, `null` to
 * skip the Event, or a filter object that selects existing documents.
 */
const identity: Identities<EventsOf<typeof domain>> = {
  [domain.billing.invoice.paymentRecorded]: (event) => event.timestamp.slice(0, 10),
};

/* `initialState` is the document a Reaction starts from when none exists yet. */
const initialState = { total: 0, payments: 0, byMethod: {} };

// With `ReadmodelApp`, `app.getServices()` is the Readmodel helpers (`readmodelServices`), not the services.
const reactions: Reactions<EventsOf<typeof domain>, ReactionView<Revenue>, ReadmodelApp> = {
  [domain.billing.invoice.paymentRecorded]: ({ payload, timestamp }, vm, app) => {
    const byMethod = vm.get("byMethod"),
      { addMoney } = app.getServices();
    vm.set({
      total: addMoney(vm.get("total"), payload.amount),
      payments: vm.get("payments") + 1,
      byMethod: {
        ...byMethod,
        [payload.method]: addMoney(byMethod[payload.method] ?? 0, payload.amount),
      },
      lastPaymentAt: new Date(timestamp),
    });
  },
};

/** The Readmodel group `reporting`. */
export const reporting = {
  models: {
    revenue: { schema: Revenue, initialState, identity, reactions },
    plans: Plans,
  },
} satisfies ReadmodelGroupConfig;
