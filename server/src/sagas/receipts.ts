import type {
  EventsOf,
  MessagePayloads,
  ReactionApp,
  ReactionView,
  Reactions,
  RegisteredServices,
  ReplyOf,
  SagaDefinition,
  SagaMessageFunction,
} from "event-fabric";
import { domain } from "../domain/index.js";
import { receiptSender, sendReceipt } from "../workers/receipts.js";

/**
 * ─── Saga `receipts` ───────────────────────────────────────────────────────────
 * Asks for a receipt once an Invoice is settled. Reactions never call external
 * systems: they must be deterministic and may be retried. The receipt is a queued
 * Message, recorded in the Outbox in the same transaction as the Saga's state,
 * that the receipts Worker performs later and answers with a reply.
 */
type State = { invoiceId: string; settledAt: string; failure?: string };

/*
 * ─── The Worker's reply ───
 * `{ outcome: "ok", value }` once the receipt is sent, `value` typed from what the
 * Worker returns; `{ outcome: "failed", error, attempts }` once it is dead-lettered.
 * A reply may arrive twice: the confirmed instance is destroyed, so a repeat finds no
 * instance and is dropped.
 */
const receipt: SagaMessageFunction<ReplyOf<typeof receiptSender>, State> = (
  { payload },
  saga,
  app,
) => {
  if (payload.outcome === "failed") return saga.set("failure", payload.error);
  app.tell(domain.billing.invoice.confirmReceipt(saga.id, { reference: payload.value }));
  saga.destroy();
};
const messages = { receipt };

const reactions: Reactions<
  EventsOf<typeof domain>,
  ReactionView<State>,
  // The third argument types `replyTo`: only this Saga's own Saga Messages.
  ReactionApp<MessagePayloads, RegisteredServices, keyof typeof messages>
> = {
  [domain.billing.invoice.settled]: async (event, saga, app) => {
    /*
     * A cross-group read: this Saga declares `reads: ["billing"]`, so EventFabric
     * waits until the `billing` Readmodel group has processed this Event before
     * running the Reaction, and the document is never older than the Event.
     */
    const { document } = await app
      .getReadmodels()
      .billing.invoices(event.aggregate.id);

    // Use the Event's timestamp, never the clock: a retry must make the same decision.
    saga.set({ invoiceId: event.aggregate.id, settledAt: event.timestamp });
    app.queue(
      sendReceipt,
      {
        invoiceId: event.aggregate.id,
        debtor: document?.debtor ?? "",
        paid: event.payload.paid,
      },
      /*
       * The Worker's Idempotency key is `["saga:receipts", <instance id>, <Event id>,
       * "receipt"]`: stable across re-deliveries, Partitions and replicas.
       * `replyTo` names this Saga's Saga Message the Worker answers this instance with.
       */
      { suffix: "receipt", replyTo: "receipt" },
    );
  },
};

export const receipts = {
  reads: ["billing"],
  reactions,
  messages,
} satisfies SagaDefinition;
