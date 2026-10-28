import { only, Type, type Document } from "event-fabric";
import { EventHandler, Readmodel, type DocumentOf } from "event-fabric/decorators";
import {
  PeriodBilled,
  SubscriptionCancelled,
  SubscriptionStarted,
} from "../domain/subscription.js";

const Subscription = Type.Object({
  customerId: Type.String(),
  plan: Type.String(),
  monthlyAmount: Type.Number(),
  status: Type.Union([Type.Literal("active"), Type.Literal("cancelled")]),
  periods: Type.Integer(),
  // An array of strings: on Postgres, a child table of `subscriptions`.
  invoices: Type.Array(Type.String()),
  nextRenewal: Type.Union([Type.String(), Type.Null()]),
  cancelReason: Type.Optional(Type.String()),
});
/** A document of the Readmodel `billing.subscriptions`, as stores return it. */
export type Subscription = Document<typeof Subscription>;
type View = DocumentOf<typeof Subscription>;

/** The Invoice the renewals Saga issues for a billed period: a stable id, so a retry finds it. */
export const invoiceIdFor = (subscriptionId: string, period: number) =>
  `${subscriptionId}-period-${period}`;
/** Which Subscription an Invoice belongs to: `null` for Invoices issued by hand. */
export const subscriptionOf = (invoiceId: string) => /^(.+)-period-\d+$/.exec(invoiceId)?.[1] ?? null;

/**
 * ─── Readmodel `billing.subscriptions` (decorated) ─────────────────────────────
 * `@Readmodel` declares the schema and indexes; each `@EventHandler` method updates
 * the document of the Event's Stream id, here the Subscription id. It is listed in
 * the `billing` group next to object Readmodels (`invoices.ts`), and the key there,
 * `subscriptions`, is its permanent name: renaming the class changes nothing stored.
 * Handlers must be deterministic, like every Reaction.
 */
@Readmodel({ schema: Subscription, indexes: [{ fields: ["customerId"] }] })
export class Subscriptions {
  @EventHandler(SubscriptionStarted, { before: [only.ifNotExists()] })
  started({ payload }: SubscriptionStarted, view: View) {
    view.set({
      customerId: payload.customerId,
      plan: payload.plan,
      monthlyAmount: payload.monthlyAmount,
      status: "active",
      periods: 0,
      invoices: [],
      nextRenewal: null,
    });
  }

  @EventHandler(PeriodBilled)
  billed({ payload, aggregate }: PeriodBilled, view: View) {
    view.set({
      periods: payload.period,
      invoices: [...view.get("invoices"), invoiceIdFor(aggregate.id, payload.period)],
      nextRenewal: payload.nextRenewal,
    });
  }

  @EventHandler(SubscriptionCancelled)
  cancelled({ payload }: SubscriptionCancelled, view: View) {
    view.set({ status: "cancelled", nextRenewal: null, cancelReason: payload.reason });
  }
}

const Plan = Type.Object({ active: Type.Integer(), monthlyRevenue: Type.Number() });
export type Plan = Document<typeof Plan>;

/**
 * ─── Readmodel `reporting.plans` (decorated) ───────────────────────────────────
 * Monthly recurring revenue per plan. `associationProperty: "plan"` is the decorated
 * form of an `identity`: the payload's `plan` names the document, so every
 * Subscription of a plan updates one document. `initialState` is where it starts.
 */
@Readmodel({ schema: Plan, initialState: { active: 0, monthlyRevenue: 0 } })
export class Plans {
  @EventHandler(SubscriptionStarted, { associationProperty: "plan" })
  started({ payload }: SubscriptionStarted, view: DocumentOf<typeof Plan>) {
    view.set({
      active: view.get("active") + 1,
      monthlyRevenue: view.get("monthlyRevenue") + payload.monthlyAmount,
    });
  }

  @EventHandler(SubscriptionCancelled, { associationProperty: "plan" })
  cancelled({ payload }: SubscriptionCancelled, view: DocumentOf<typeof Plan>) {
    view.set({
      active: view.get("active") - 1,
      monthlyRevenue: view.get("monthlyRevenue") - payload.monthlyAmount,
    });
  }
}
