import type {
  EventsOf,
  Identities,
  ReactionApp,
  ReactionView,
  Reactions,
  SagaDefinition,
} from "event-fabric";
import { domain } from "../domain/index.js";

/**
 * ─── Saga `accounts` ───────────────────────────────────────────────────────────
 * Keeps each Customer's account in step with their Invoices. A Saga is a
 * long-running Reaction with its own state; it changes Aggregates only by sending
 * Commands.
 *
 * There is one Saga instance per Invoice: by default an Event goes to the instance
 * named by its Stream id, which for Invoice Events is the Invoice id. The instance
 * remembers the customer, because only `issued` names it, and the amount, to reverse
 * the charge if the Invoice is voided.
 */
type State = { customerId: string; amount: number; refused?: boolean };

/*
 * `chargeRefused` is a Customer Event, so its Stream id is the Customer id. Identity
 * routes it to the instance of the Invoice it names instead.
 */
const identity: Identities<EventsOf<typeof domain>> = {
  [domain.billing.customer.chargeRefused]: ({ payload }) => payload.invoiceId,
};

/*
 * `app.tell(command)` records the Command in the Outbox, in the same transaction as
 * this Saga's state and Checkpoint; EventFabric delivers it after the commit, at
 * least once. It inherits the Event's Metadata and Correlation id, and a re-delivery
 * keeps its Command id, so the Customer accepts it once (a Duplicate Command).
 */
const reactions: Reactions<
  EventsOf<typeof domain>,
  ReactionView<State>,
  ReactionApp
> = {
  [domain.billing.invoice.issued]: ({ aggregate, payload }, saga, app) => {
    saga.set({ customerId: payload.customerId, amount: payload.amount });
    app.tell(
      domain.billing.customer.chargeInvoice(payload.customerId, {
        invoiceId: aggregate.id,
        amount: payload.amount,
      }),
    );
  },
  [domain.billing.invoice.paymentRecorded]: ({ aggregate, payload }, saga, app) =>
    app.tell(
      domain.billing.customer.creditPayment(saga.get("customerId"), {
        invoiceId: aggregate.id,
        amount: payload.amount,
      }),
    ),

  /*
   * ─── Compensation ───
   * The Customer refused the charge and recorded why. The Saga undoes the step that
   * started the process: it voids the Invoice. Commands from a Saga bypass the
   * Gateway's Access map, so the admin-only `void` is allowed here.
   *
   * If a payment lands before the void, `void` is rejected (`has-payments`). The Outbox
   * dead-letters it as `outbox-rejected` and counts `eventfabric.outbox.rejected`, so an
   * operator sees it; `dead-letters replay` re-sends it once the data is fixed.
   */
  [domain.billing.customer.chargeRefused]: ({ payload }, saga, app) => {
    saga.set("refused", true);
    app.tell(
      domain.billing.invoice.void(payload.invoiceId, { reason: "Credit limit exceeded" }),
    );
  },

  [domain.billing.invoice.voided]: ({ aggregate }, saga, app) => {
    // A refused charge was never made, so there is nothing to reverse.
    if (!saga.get("refused"))
      app.tell(
        domain.billing.customer.reverseCharge(saga.get("customerId"), {
          invoiceId: aggregate.id,
          amount: saga.get("amount"),
        }),
      );
    saga.destroy();
  },
  /* `destroy()` deletes this instance's state; Commands it already told are still sent. */
  [domain.billing.invoice.settled]: (_, saga) => saga.destroy(),
};

export const accounts = { identity, reactions } satisfies SagaDefinition;
