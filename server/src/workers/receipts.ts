import { message, Type, worker } from "event-fabric";

/**
 * ─── Message `send-receipt` ────────────────────────────────────────────────────
 * A queued Message type: its name and payload schema. The receipts Saga queues it
 * with `app.queue(sendReceipt, payload)`, and the schema is checked then, before
 * the Saga's transaction commits, not when the Worker picks it up.
 */
export const sendReceipt = message(
  "send-receipt",
  Type.Object(
    { invoiceId: Type.String(), debtor: Type.String(), paid: Type.Number() },
    { additionalProperties: false },
  ),
);

/**
 * ─── Worker `receipts` ─────────────────────────────────────────────────────────
 * Performs queued `send-receipt` Messages, outside any Command or Reaction. This is
 * where external calls belong.
 *
 * - `concurrency`: Messages handled at once by this replica.
 * - `timeout`: aborts `ctx.signal` after this many milliseconds.
 * - `retry`: a thrown error schedules a durable retry with exponential backoff;
 *   after the last attempt the Message is dead-lettered (`event-fabric dead-letters`)
 *   and the Saga that asked gets `{ outcome: "failed", error, attempts }`.
 *   `throw permanent(error)` dead-letters at once, for errors a retry cannot fix.
 */
export const receiptSender = worker(sendReceipt, {
  concurrency: 4,
  timeout: 10_000,
  retry: { attempts: 5, baseDelay: 1_000, maxDelay: 30_000 },
  async execute({ payload }, ctx) {
    /*
     * `ctx.services` are the Application's `services` (see `event-fabric.config.ts`).
     * The Idempotency key is stable across retries of this Message: a provider that
     * honours it sends one receipt even if this Worker crashes after sending.
     */
    const mailer = ctx.services.mailer;
    const reference = await mailer.sendReceipt(
      { invoiceId: payload.invoiceId, debtor: payload.debtor, paid: payload.paid },
      { idempotencyKey: ctx.idempotencyKey, signal: ctx.signal },
    );
    ctx.logger.info(
      { invoiceId: payload.invoiceId, attempt: ctx.attempt },
      "Receipt sent",
    );
    /*
     * The return value is the reply: the receipts Saga queued this Message with
     * `replyTo`, so EventFabric sends it `{ outcome: "ok", value: reference }`, and
     * the Saga confirms the receipt on the Invoice.
     */
    return reference;
  },
});
