import { Type, type Static } from "event-fabric";
import { signal, workflow } from "event-fabric/workflows";
import { domain } from "../domain/index.js";
import { overdueAt } from "../domain/invoice.js";
import { CancelSubscription } from "../domain/subscription.js";
import { subscriptionOf } from "../readmodels/subscriptions.js";
import { reminderSender } from "../workers/reminders.js";

const DAY = 86_400_000;
/** How long the dunning waits after the reminder before it gives up on the Invoice. */
const reminderPeriod = 14 * DAY;
const { issued, settled } = domain.billing.invoice;

/** What `queryWorkflow(dunning, id)` reports as `state`: where the dunning stands. */
const Dunning = Type.Object({
  stage: Type.Union([
    Type.Literal("awaiting-payment"),
    Type.Literal("reminded"),
    Type.Literal("promised"),
    Type.Literal("settled"),
    Type.Literal("void"),
    Type.Literal("overdue"),
  ]),
  remindersSent: Type.Integer({ minimum: 0 }),
});
/** The stages an instance ends in, and returns as its result. */
type Outcome = Extract<Static<typeof Dunning>["stage"], "settled" | "void" | "overdue">;

/**
 * ─── Workflow `dunning` ────────────────────────────────────────────────────────
 * Chases one unpaid Invoice, written as one function that waits (ADR-0021), where the
 * `accounts` and `receipts` Sagas react Event by Event. One instance per Invoice:
 *
 * 1. waits for `settled` until the Invoice falls overdue (14 days for a Subscription's),
 * 2. asks the `reminders` Worker for a reminder and waits another 14 days,
 * 3. a debtor's `promised` Signal extends that wait once, to the promised date,
 * 4. then marks the Invoice overdue and cancels the Subscription it bills.
 *
 * Every `ctx` call is a durable step. After each wake (an Event, a Signal, a Deadline, a
 * Worker's reply) or a restart the body runs again from the top, and finished steps
 * return what they recorded. So the body awaits only `ctx` calls and takes time from
 * `ctx.now()`; the `determinism` lint rule checks it. Changing the order or names of
 * steps for running instances drifts them: register the new code as `version: 2` next
 * to this one (`versions: [v1, v2]`) until the old instances finish.
 */
export const dunning = workflow("dunning", {
  version: 1,
  domain,
  // An issued Invoice starts its instance, with the Event as the input.
  start: issued,
  id: (event) => event.aggregate.id,
  // Routes each Invoice's payment to its instance, for `ctx.waitFor(settled)`.
  correlate: { [settled]: (event) => event.aggregate.id },
  signals: { promised: signal(Type.Object({ until: Type.String({ format: "date" }) }, { additionalProperties: false })) },
  state: Dunning,
  // `ctx.read` reads documents of these groups, recorded in the journal.
  reads: ["billing"],
  async run(ctx, event) {
    // Waits end at absolute times (`at`), as Saga Deadlines do; a time already past times out at once.
    const overdue = overdueAt(event.payload.dueDate);
    // The Invoice as the `billing` Readmodel has it: a voided one is no longer chased.
    const current = () => ctx.read("billing", "invoices", ctx.id);
    let remindersSent = 0;
    const end = async (stage: Outcome) => {
      await ctx.set({ stage, remindersSent });
      return stage;
    };

    await ctx.set({ stage: "awaiting-payment", remindersSent });
    if (!(await ctx.waitFor(settled, { at: overdue })).timedOut) return end("settled");
    const invoice = await current();
    if (invoice?.status === "void") return end("void");
    const reply = await ctx.ask(reminderSender, {
      invoiceId: ctx.id,
      debtor: event.payload.debtor,
      outstanding: invoice ? invoice.amount - invoice.paid : event.payload.amount,
    });
    // A dead-lettered reminder replies `failed`; the dunning goes on without it.
    if (reply.outcome === "ok") remindersSent += 1;
    await ctx.set({ stage: "reminded", remindersSent });

    let paid = await ctx.waitFor(settled, { at: new Date(Date.parse(overdue) + reminderPeriod) });
    if (paid.timedOut) {
      // A zero timeout takes a promise that already arrived, and waits for none.
      const promise = await ctx.waitFor(ctx.signals.promised, { timeout: 0 });
      if (!promise.timedOut) {
        await ctx.set({ stage: "promised", remindersSent });
        paid = await ctx.waitFor(settled, { at: overdueAt(promise.value.until) });
      }
    }
    if (!paid.timedOut) return end("settled");
    if ((await current())?.status === "void") return end("void");

    // Records nothing when the Invoice's `overdue` Schedule has marked it already.
    await ctx.tell(domain.billing.invoice.markOverdue(ctx.id, {}));
    const subscription = subscriptionOf(ctx.id);
    if (subscription) await ctx.tell(CancelSubscription.to(subscription, { reason: "unpaid-invoice" }));
    return end("overdue");
  },
});
