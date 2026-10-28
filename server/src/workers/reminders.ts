import { message, Type, worker } from "event-fabric";

/**
 * ─── Message `send-reminder` ───────────────────────────────────────────────────
 * The payment reminder the dunning Workflow asks for (`ctx.ask`). Its schema is checked
 * when the Workflow's wake commits, before the Worker sees it.
 */
export const sendReminder = message(
  "send-reminder",
  Type.Object(
    { invoiceId: Type.String(), debtor: Type.String(), outstanding: Type.Number() },
    { additionalProperties: false },
  ),
);

/**
 * ─── Worker `reminders` ────────────────────────────────────────────────────────
 * Mails one reminder. Its return value is the reply `ctx.ask` resolves with:
 * `{ outcome: "ok", value: reference }`, or `{ outcome: "failed", error, attempts }`
 * once the retries are spent and the Message is dead-lettered.
 */
export const reminderSender = worker(sendReminder, {
  concurrency: 4,
  timeout: 10_000,
  retry: { attempts: 5, baseDelay: 1_000, maxDelay: 30_000 },
  async execute({ payload }, ctx) {
    // `ask` is at-least-once: the Idempotency key lets the provider drop a repeat.
    const reference = await ctx.services.mailer.sendReminder(payload, {
      idempotencyKey: ctx.idempotencyKey,
      signal: ctx.signal,
    });
    ctx.logger.info({ invoiceId: payload.invoiceId, attempt: ctx.attempt }, "Reminder sent");
    return reference;
  },
});
