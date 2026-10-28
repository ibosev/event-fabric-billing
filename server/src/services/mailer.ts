import type { Logger } from "event-fabric";

/**
 * ─── Service `mailer` ──────────────────────────────────────────────────────────
 * Application services are plain objects passed as `services` in the config. Workers
 * (`ctx.services`), Command Steps and Reactions (`app.getServices()`), Tasks and
 * plugins receive them. This one stands in for an email provider and only logs.
 */
export type Mailer = {
  sendReceipt(
    receipt: { invoiceId: string; debtor: string; paid: number },
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<string>;
  /** The dunning Workflow's payment reminder; returns the provider's reference. */
  sendReminder(
    reminder: { invoiceId: string; debtor: string; outstanding: number },
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<string>;
};

export const createMailer = (logger: Logger): Mailer => ({
  async sendReceipt(receipt, { idempotencyKey, signal }) {
    // A real provider call would pass `signal` to fetch so a timeout aborts it.
    signal.throwIfAborted();
    logger.info({ invoiceId: receipt.invoiceId, idempotencyKey }, "Mailing receipt");
    return `receipt-${receipt.invoiceId}`;
  },
  async sendReminder(reminder, { idempotencyKey, signal }) {
    signal.throwIfAborted();
    logger.info({ invoiceId: reminder.invoiceId, idempotencyKey }, "Mailing payment reminder");
    return `reminder-${reminder.invoiceId}`;
  },
});
