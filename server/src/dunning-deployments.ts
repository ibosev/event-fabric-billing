/**
 * ─── The dunning Workflow across deployments ───────────────────────────────────
 * The whole Application path on a real Event store: the Workflow consumer, the
 * reminders Worker answering `ctx.ask`, Commands through the Outbox. `dunning-stores.test.ts`
 * runs it on the in-memory store; EventFabric's `npm run test:integration` runs it on
 * Postgres (`test/integration/billing-dunning.test.ts`). Due dates in the past make the
 * waits time out at once, so no clock has to move: what matters here is restarts and
 * deployments, not days.
 */
import assert from "node:assert/strict";
import { createApplication, createLogger, type ApplicationConfig, type Persistence } from "event-fabric";
import { accepted, createInMemoryTransport, createMemoryReadmodelStore } from "event-fabric/testing";
import { signal, workflow } from "event-fabric/workflows";
import { customer } from "./domain/customer.js";
import { domain } from "./domain/index.js";
import { invoice, overdueAt } from "./domain/invoice.js";
import { StartSubscription, SubscriptionAggregate } from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { invoiceIdFor } from "./readmodels/subscriptions.js";
import type { Services } from "./services/index.js";
import { readmodelServices } from "./services/readmodel.js";
import { reminderSender } from "./workers/reminders.js";
import { dunning } from "./workflows/dunning.js";

const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const { settled } = domain.billing.invoice;

/*
 * A careless deployment: the same Workflow, version and first steps, then a new `sleep`
 * where the reminder was. An instance still in its first wait runs it; one that already
 * sent its reminder has drifted, since its journal records steps this code no longer reaches.
 */
const careless = workflow("dunning", {
  version: 1,
  domain,
  start: domain.billing.invoice.issued,
  id: (event) => event.aggregate.id,
  correlate: { [settled]: (event) => event.aggregate.id },
  signals: { promised: signal<{ until: string }>() },
  async run(ctx, event) {
    await ctx.set({ stage: "awaiting-payment", remindersSent: 0 });
    if (!(await ctx.waitFor(settled, { at: overdueAt(event.payload.dueDate) })).timedOut) return "settled";
    await ctx.sleep("grace", DAY);
    return "overdue";
  },
});

/**
 * Runs the dunning to the end, through a restart mid-wait, and through a careless deploy that
 * drifts only the instance it broke, on the store `store` (fresh, migrated) keeps.
 */
export async function dunningAcrossDeployments(store: Persistence) {
  const deployed: { close(): Promise<void> }[] = [];
  const readmodelStore = createMemoryReadmodelStore();
  const reminders: string[] = [];
  const deploy = async (workflows: ApplicationConfig["workflows"]) => {
    const app = createApplication({
      name: "billing-dunning",
      aggregates: [invoice, customer, SubscriptionAggregate],
      store,
      transport: createInMemoryTransport(),
      readmodelStore,
      readmodels: { billing },
      readmodelServices,
      workflows,
      workers: { reminders: reminderSender },
      services: {
        registry: { verify: async () => {} },
        mailer: {
          sendReceipt: async () => "receipt",
          sendReminder: async ({ invoiceId }) => {
            reminders.push(invoiceId);
            return `reminder-${invoiceId}`;
          },
        },
        get settings(): Services["settings"] {
          throw new Error("Settings are not used by this test");
        },
      },
      // Drifting and dead-lettering log warnings and errors this test expects.
      logger: createLogger({ level: process.env.LOG_LEVEL ?? "fatal" }),
      pollInterval: 10,
      leaseDuration: 300,
    });
    deployed.push(app);
    await app.start();
    return app;
  };
  type App = Awaited<ReturnType<typeof deploy>>;
  const eventually = async (read: () => Promise<unknown>, expected: unknown) => {
    let last: unknown;
    for (let i = 0; i < 300; i++) {
      last = await read();
      try {
        return assert.deepEqual(last, expected);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(last, expected);
  };
  const query = (app: App, id: string) => () => app.queryWorkflow(dunning, id);
  const issue = (app: App, id: string | undefined, dueDate: string) =>
    accepted(app.sendCommand(domain.billing.invoice.issue(id, { customerId, debtor: "Late Payer Ltd", amount: 40, dueDate })));

  let customerId = "";
  try {
    const first = await deploy({ dunning });
    const registered = await accepted(
      first.sendCommand(domain.billing.customer.register(undefined, { name: "Late Payer Ltd", creditLimit: 1000 })),
    );
    customerId = registered.events[0]!.stream.id;
    const started = await accepted(
      first.sendCommand(
        StartSubscription.to(undefined, { customerId, debtor: "Late Payer Ltd", plan: "pro", monthlyAmount: 40, startsOn: day(-90) }),
      ),
    );
    const subscription = started.events[0]!.stream.id;
    // Long overdue: reminded, marked overdue and its Subscription cancelled at once.
    const lapsed = invoiceIdFor(subscription, 1);
    await issue(first, lapsed, day(-30));
    // Ten days overdue: reminded, then waiting four more days.
    const late = invoiceIdFor(subscription, 2);
    await issue(first, late, day(-10));
    // Not yet due: waiting for its payment.
    const fresh = (await issue(first, undefined, day(30))).events[0]!.stream.id;

    await eventually(query(first, lapsed), { status: "completed", state: { stage: "overdue", remindersSent: 1 }, result: "overdue" });
    await eventually(query(first, late), { status: "running", state: { stage: "reminded", remindersSent: 1 } });
    await eventually(query(first, fresh), { status: "running", state: { stage: "awaiting-payment", remindersSent: 0 } });
    // The Workflow's last Commands leave through the Outbox after its instance committed.
    const lastEvent = async () =>
      (await store.readStream({ context: "billing", aggregate: "subscription", id: subscription })).at(-1)?.payload;
    await eventually(lastEvent, { reason: "unpaid-invoice", plan: "pro", monthlyAmount: 40 });

    // A restart mid-wait: the next process replays the journals and repeats no finished step.
    await first.close();
    const second = await deploy({ dunning });
    await accepted(second.sendCommand(domain.billing.invoice.recordPayment(fresh, { amount: 40 })));
    await eventually(query(second, fresh), { status: "completed", state: { stage: "settled", remindersSent: 0 }, result: "settled" });
    const waiting = (await issue(second, undefined, day(30))).events[0]!.stream.id;
    await eventually(query(second, waiting), { status: "running", state: { stage: "awaiting-payment", remindersSent: 0 } });
    assert.deepEqual(reminders.sort(), [lapsed, late].sort());

    // The careless deploy: the reminded instance drifts on its next wake and is parked
    // with that wake dead-lettered; the one still in its first wait runs on.
    await second.close();
    const third = await deploy({ dunning: careless });
    await third.sendSignal(late, dunning.signals.promised({ until: day(20) }));
    await accepted(third.sendCommand(domain.billing.invoice.recordPayment(waiting, { amount: 40 })));
    await eventually(query(third, waiting), { status: "completed", state: { stage: "awaiting-payment", remindersSent: 0 }, result: "settled" });
    await eventually(query(third, late), { status: "drifted", state: { stage: "reminded", remindersSent: 1 } });
    const letters = (await store.deadLetters()).filter((letter) => letter.error.startsWith("workflow-drifted"));
    assert.equal(letters.length, 1, JSON.stringify(letters));
    assert.deepEqual(reminders.sort(), [lapsed, late].sort());
  } finally {
    // Closing twice is a no-op, so a failed assertion still stops every deployment.
    await Promise.all(deployed.map((app) => app.close()));
  }
}
