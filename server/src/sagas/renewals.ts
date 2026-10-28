import { Type, type ReactionApp } from "event-fabric";
import { Saga, SagaEventHandler, eventOf, type SagaOf } from "event-fabric/decorators";
import { customer } from "../domain/customer.js";
import { domain } from "../domain/index.js";
import {
  CancelSubscription,
  PeriodBilled,
  RenewSubscription,
  SubscriptionCancelled,
} from "../domain/subscription.js";
import { invoiceIdFor, subscriptionOf } from "../readmodels/subscriptions.js";

/*
 * `eventOf` gives an Event of an `aggregate()` Aggregate a class, so decorated
 * Readmodels and Sagas react to it like to their own: the bridge from the existing style.
 */
class ChargeRefused extends eventOf(customer, "chargeRefused") {}

const RenewalState = Type.Object({ invoices: Type.Array(Type.String()) });
type Renewal = SagaOf<typeof RenewalState>;


/**
 * ─── Saga `renewals` (decorated) ───────────────────────────────────────────────
 * Axon's `@Saga` with `@SagaEventHandler` methods; one instance per Subscription.
 * Everything it sends goes through the Outbox with its state, in one transaction.
 *
 * - A billed period issues an Invoice on the `aggregate()` Invoice (`invoice.ts`), with
 *   a stable id, and schedules the next `renew` for when the next period starts.
 * - A charge the Customer refused for one of its Invoices cancels the Subscription.
 *   `associationProperty` routes that Customer Event to this Subscription's instance;
 *   returning `null` skips Invoices that belong to no Subscription.
 */
@Saga()
export class Renewals {
  @SagaEventHandler(PeriodBilled)
  billed({ payload, aggregate }: PeriodBilled, saga: Renewal, app: ReactionApp) {
    const invoiceId = invoiceIdFor(aggregate.id, payload.period);
    saga.set("invoices", [...(saga.get("invoices") ?? []), invoiceId]);
    // Decorated Saga → `aggregate()` Aggregate: the domain Handle works as anywhere else.
    app.tell(
      domain.billing.invoice.issue(invoiceId, {
        customerId: payload.customerId,
        debtor: payload.debtor,
        amount: payload.amount,
        dueDate: payload.dueDate,
      }),
    );
    // A delayed Command: the Outbox holds it until `notBefore`, across restarts.
    app.tell({
      ...RenewSubscription.to(aggregate.id, { period: payload.period + 1 }),
      notBefore: `${payload.nextRenewal}T00:00:00.000Z`,
      replaceKey: `renew:${aggregate.id}`,
    });
  }

  @SagaEventHandler(ChargeRefused, {
    associationProperty: (event) => subscriptionOf(event.payload.invoiceId),
  })
  refused(_: ChargeRefused, saga: Renewal, app: ReactionApp) {
    app.tell(CancelSubscription.to(saga.id, { reason: "credit-limit" }));
  }

  /* A cancelled Subscription's instance is deleted; a pending `renew` records nothing. */
  @SagaEventHandler(SubscriptionCancelled)
  cancelled(_: SubscriptionCancelled, saga: Renewal) {
    saga.destroy();
  }
}
