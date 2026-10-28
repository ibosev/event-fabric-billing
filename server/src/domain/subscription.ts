import { randomUUID } from "node:crypto";
import { only, Rejection, Type } from "event-fabric";
import {
  Aggregate,
  CommandHandler,
  EventSourcingHandler,
  command,
  event,
  type AggregateOf,
  type StateOf,
} from "event-fabric/decorators";

/*
 * ─── Decorated authoring (`event-fabric/decorators`) ───────────────────────────
 * The same framework, written the way Axon Framework writes it: Commands and Events
 * are classes, and an Aggregate is a class whose methods are marked
 * `@CommandHandler` and `@EventSourcingHandler`. It compiles to exactly what
 * `aggregate()` produces (see `invoice.ts`), so both styles share one Application,
 * one Event log and one set of guarantees. Pick per Aggregate.
 *
 * Decorated source must be compiled (`tsc`); Node cannot strip decorators. Methods
 * hold no state: the class is never constructed, `this` is undefined, and the State
 * arrives as an argument, exactly as in `aggregate()`.
 */

const Plan = Type.Union([Type.Literal("basic"), Type.Literal("pro")]);
const Started = Type.Object(
  {
    customerId: Type.String({ minLength: 1 }),
    debtor: Type.String({ minLength: 1 }),
    plan: Plan,
    monthlyAmount: Type.Number({ exclusiveMinimum: 0 }),
    startsOn: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);
/** One billed period: what the renewals Saga turns into an Invoice. */
const Billed = Type.Object(
  {
    period: Type.Integer({ minimum: 1 }),
    customerId: Type.String(),
    debtor: Type.String(),
    amount: Type.Number({ exclusiveMinimum: 0 }),
    from: Type.String({ format: "date" }),
    dueDate: Type.String({ format: "date" }),
    nextRenewal: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);
const Cancelled = Type.Object(
  { reason: Type.String({ minLength: 1 }), plan: Plan, monthlyAmount: Type.Number() },
  { additionalProperties: false },
);

/*
 * ─── Messages ───
 * Each class names its message `<context>.<aggregate>.<name>` and carries its TypeBox
 * schema. The class is the decorator argument and the parameter type, and its `to()`
 * builds the Command to send: `StartSubscription.to(undefined, { ... })`.
 */
export class StartSubscription extends command("billing.subscription.start", Started) {}
/** Bills `period`; the renewals Saga names the next one, so a repeat records nothing. */
export class RenewSubscription extends command(
  "billing.subscription.renew",
  Type.Object({ period: Type.Integer({ minimum: 2 }) }, { additionalProperties: false }),
) {}
export class CancelSubscription extends command(
  "billing.subscription.cancel",
  Type.Object({ reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
) {}
export class SubscriptionStarted extends event("billing.subscription.started", Started) {}
export class PeriodBilled extends event("billing.subscription.periodBilled", Billed) {}
export class SubscriptionCancelled extends event("billing.subscription.cancelled", Cancelled) {}

export const subscriptionRejections = {
  notDue: "not-due",
  unknownCustomer: "unknown-customer",
} as const;

const DAY = 86_400_000;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
/** The first day of period `n` (1-based): one calendar month per period, in UTC. */
const periodStart = (startsOn: string, n: number) => {
  const start = new Date(`${startsOn}T00:00:00Z`);
  return date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n - 1, start.getUTCDate()));
};
/** Bills period `n`: an Invoice due two weeks after the period starts. */
const billing = (
  state: { customerId: string; debtor: string; monthlyAmount: number; startsOn: string },
  n: number,
) => {
  const from = periodStart(state.startsOn, n);
  return {
    period: n,
    customerId: state.customerId,
    debtor: state.debtor,
    amount: state.monthlyAmount,
    from,
    dueDate: date(Date.parse(from) + 14 * DAY),
    nextRenewal: periodStart(state.startsOn, n + 1),
  };
};

const SubscriptionState = Type.Object({
  customerId: Type.String(),
  debtor: Type.String(),
  plan: Plan,
  monthlyAmount: Type.Number(),
  startsOn: Type.String(),
  periods: Type.Integer(),
  status: Type.Union([Type.Literal("active"), Type.Literal("cancelled")]),
});
type Subscription = AggregateOf<typeof SubscriptionState>;
type State = StateOf<typeof SubscriptionState>;

/**
 * ─── Aggregate `billing.subscription` ──────────────────────────────────────────
 * A monthly plan for a Customer. Starting bills the first period at once; the
 * renewals Saga (`sagas/renewals.ts`) issues an Invoice for each billed period and
 * schedules the next `renew` for when that period ends.
 *
 * Context and name come from the messages it handles. `idGenerator` and
 * `eventEnricher` work as in `aggregate()`.
 */
@Aggregate({
  state: SubscriptionState,
  initialState: {
    customerId: "",
    debtor: "",
    plan: "basic",
    monthlyAmount: 0,
    startsOn: "",
    periods: 0,
    status: "active",
  },
  idGenerator: () => randomUUID(),
  // Every Subscription Event carries its customer, like the Invoice's.
  eventEnricher: (_event, state) => ({ customerId: state.get("customerId") }),
})
export class SubscriptionAggregate {
  /*
   * `before` runs in order ahead of the method: `only.*` checks, then Steps. A Step
   * that throws is a Precondition. This one checks the Customer exists, like `issue`.
   */
  @CommandHandler(StartSubscription, {
    before: [
      only.ifNotExists(),
      async (command: StartSubscription, _: Subscription, app) => {
        const customer = await app.getDomain().billing.customer(command.payload.customerId).load();
        if (customer.revision === 0)
          throw new Rejection(
            "precondition",
            "Customer does not exist",
            { customerId: command.payload.customerId },
            subscriptionRejections.unknownCustomer,
          );
      },
    ],
  })
  start(command: StartSubscription, subscription: Subscription) {
    subscription.apply(SubscriptionStarted, command.payload);
    // `apply` folds at once, so the second Event sees the started State.
    subscription.apply(PeriodBilled, billing(subscription.get(), 1));
  }

  /*
   * Sent by the renewals Saga, delayed until the period starts. A cancelled
   * Subscription, or a period already billed, accepts it and records nothing: the Saga
   * cannot recall a delayed Command, and a resend must be harmless. `command.now` is
   * the Command's time; Event handlers never read the clock.
   */
  @CommandHandler(RenewSubscription, { before: [only.ifExists()] })
  renew(command: RenewSubscription, subscription: Subscription) {
    const { period } = command.payload;
    if (subscription.get("status") === "cancelled" || period <= subscription.get("periods")) return;
    if (period > subscription.get("periods") + 1)
      throw new Rejection("precondition", "Periods are billed in order", { period });
    const next = billing(subscription.get(), period);
    if (command.now.toISOString().slice(0, 10) < next.from)
      throw new Rejection(
        "precondition",
        "The next period has not started",
        { from: next.from },
        subscriptionRejections.notDue,
      );
    subscription.apply(PeriodBilled, next);
  }

  @CommandHandler(CancelSubscription, { before: [only.ifExists()] })
  cancel(command: CancelSubscription, subscription: Subscription) {
    if (subscription.get("status") === "cancelled") return;
    subscription.apply(SubscriptionCancelled, {
      reason: command.payload.reason,
      plan: subscription.get("plan"),
      monthlyAmount: subscription.get("monthlyAmount"),
    });
  }

  /* ─── Events: folded on apply and on every load. Deterministic: no clock, no I/O. ─── */
  @EventSourcingHandler(SubscriptionStarted)
  started({ payload }: SubscriptionStarted, state: State) {
    state.set({ ...payload, status: "active" });
  }

  @EventSourcingHandler(PeriodBilled)
  billed({ payload }: PeriodBilled, state: State) {
    state.set("periods", payload.period);
  }

  @EventSourcingHandler(SubscriptionCancelled)
  cancelled(_: SubscriptionCancelled, state: State) {
    state.set("status", "cancelled");
  }
}
