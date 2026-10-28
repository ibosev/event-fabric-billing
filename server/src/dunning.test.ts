/**
 * ─── Testing the dunning Workflow ──────────────────────────────────────────────
 * `processFixture` runs one Workflow on the in-memory store with a virtual clock, as it
 * runs a Saga: `start`, `signal`, `event`, `reply` and `timePasses` drive an instance,
 * `expectStatus`, `expectState` and `expectResult` read what `queryWorkflow` would.
 * `start`, `signal` and `expectResult` are typed by the Workflow, and `workflowStep` names
 * the step a Deadline or a Worker's request belongs to.
 */
import { test } from "node:test";
import { event, processFixture, reply, signal, timePasses, workflowStep } from "event-fabric/testing";
import { customer } from "./domain/customer.js";
import { domain } from "./domain/index.js";
import { invoice } from "./domain/invoice.js";
import { CancelSubscription, SubscriptionAggregate } from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { readmodelServices } from "./services/readmodel.js";
import { reminderSender, sendReminder } from "./workers/reminders.js";
import { dunning } from "./workflows/dunning.js";

const DAY = 86_400_000;
const { settled } = domain.billing.invoice;
const id = "sub-1-period-1";
const issued = event("billing.invoice.issued", id, {
  customerId: "cus-1",
  debtor: "Example Debtor Ltd",
  amount: 100,
  dueDate: "2026-11-14",
});
const fixture = () =>
  // Runs under the Workflow's own name, `dunning`.
  processFixture(dunning, {
    now: "2026-11-01T08:00:00.000Z",
    // The Workflow reads `billing`, so the fixture runs that group on the real Aggregates' Events.
    aggregates: [invoice, customer, SubscriptionAggregate],
    readmodels: { billing },
    readmodelServices,
    workers: { reminders: reminderSender },
  });

test("dunning: an Invoice paid before it falls due ends the instance without a reminder", async () => {
  await using flow = fixture();
  await flow
    .when(issued)
    .expectStatus("running")
    .expectState({ stage: "awaiting-payment", remindersSent: 0 })
    // The end of the due date, in UTC: when the Invoice falls overdue.
    .expectDeadline(workflowStep.waitFor(settled, 0), "2026-11-15T00:00:00.000Z")
    .when(event(settled, id, { paid: 100 }))
    .expectQueued([])
    .expectStatus("completed")
    .expectState({ stage: "settled", remindersSent: 0 })
    .expectResult("settled");
});

test("dunning: an unpaid Invoice gets a reminder, then is marked overdue and its Subscription cancelled", async () => {
  await using flow = fixture();
  await flow
    .given(issued)
    .when(timePasses(14 * DAY))
    .expectQueued([
      {
        name: sendReminder.name,
        payload: { invoiceId: id, debtor: "Example Debtor Ltd", outstanding: 100 },
        replyTo: { workflow: dunning.name, instance: id, step: workflowStep.ask(reminderSender) },
      },
    ])
    // The Worker never runs here: `reply` answers the request as the Worker runtime would.
    .when(reply(sendReminder, { outcome: "ok", value: `reminder-${id}` }))
    .expectState({ stage: "reminded", remindersSent: 1 })
    .expectDeadline(workflowStep.waitFor(settled, 1), "2026-11-29T00:00:00.000Z")
    .when(timePasses(14 * DAY))
    .expectCommands([
      domain.billing.invoice.markOverdue(id, {}),
      CancelSubscription.to("sub-1", { reason: "unpaid-invoice" }),
    ])
    .expectStatus("completed")
    .expectState({ stage: "overdue", remindersSent: 1 })
    .expectResult("overdue");
});

test("dunning: a promise to pay extends the last wait once, and the payment ends it", async () => {
  await using flow = fixture();
  await flow
    .given(issued, timePasses(14 * DAY), reply(sendReminder, { outcome: "ok", value: `reminder-${id}` }))
    .when(signal(id, dunning.signals.promised({ until: "2026-12-10" })))
    .expectCommands([])
    .when(timePasses(14 * DAY))
    .expectCommands([])
    .expectState({ stage: "promised", remindersSent: 1 })
    .expectDeadline(workflowStep.waitFor(settled, 2), "2026-12-11T00:00:00.000Z")
    .when(event(settled, id, { paid: 100 }))
    .expectStatus("completed")
    .expectResult("settled");
});

test("dunning: a voided Invoice gets no reminder and cancels nothing", async () => {
  await using flow = fixture();
  await flow
    .given(issued, event("billing.invoice.voided", id, { reason: "duplicate" }))
    .when(timePasses(14 * DAY))
    .expectQueued([])
    .expectCommands([])
    .expectStatus("completed")
    .expectState({ stage: "void", remindersSent: 0 })
    .expectResult("void");
});
