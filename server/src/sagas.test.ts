/**
 * ─── Testing a Saga on its own ─────────────────────────────────────────────────
 * `processFixture` runs one Saga on the in-memory store with a virtual clock:
 * `given` and `when` record Events, send Saga Messages or let time pass, and the
 * expectations check what the last `when` told, queued and left behind.
 */
import { test } from "node:test";
import { event, processFixture, reply } from "event-fabric/testing";
import { domain } from "./domain/index.js";
import { customer } from "./domain/customer.js";
import { invoice } from "./domain/invoice.js";
import { PeriodBilled, RenewSubscription, SubscriptionAggregate } from "./domain/subscription.js";
import { billing } from "./readmodels/invoices.js";
import { accounts } from "./sagas/accounts.js";
import { receipts } from "./sagas/receipts.js";
import { Renewals } from "./sagas/renewals.js";
import { readmodelServices } from "./services/readmodel.js";
import { receiptSender, sendReceipt } from "./workers/receipts.js";

const issued = event("billing.invoice.issued", "inv-1", {
  customerId: "cus-1",
  debtor: "Example Debtor Ltd",
  amount: 100,
  dueDate: "2026-12-31",
});

test("accounts: an issued Invoice charges its Customer; a refused charge voids it without a reversal", async () => {
  await using saga = processFixture(accounts, { name: "accounts" });
  await saga
    .when(issued)
    .expectCommands([domain.billing.customer.chargeInvoice("cus-1", { invoiceId: "inv-1", amount: 100 })])
    .expectState({ customerId: "cus-1", amount: 100 })
    // A Customer Event: Identity routes it to the Invoice's instance.
    .when(event("billing.customer.chargeRefused", "cus-1", { invoiceId: "inv-1", amount: 100, reason: "credit-limit" }))
    .expectCommands([domain.billing.invoice.void("inv-1", { reason: "Credit limit exceeded" })])
    .expectState({ customerId: "cus-1", amount: 100, refused: true }, "inv-1")
    .when(event("billing.invoice.voided", "inv-1", { reason: "Credit limit exceeded" }))
    .expectCommands([])
    .expectState(null);
});

test("receipts: a settled Invoice queues its receipt; the Worker's reply confirms it or keeps the failure", async () => {
  await using saga = processFixture(receipts, {
    name: "receipts",
    now: "2026-10-15T12:00:00.000Z",
    // The Saga reads `billing`, so the fixture runs that group on the real Aggregates' Events.
    aggregates: [invoice, customer, SubscriptionAggregate],
    readmodels: { billing },
    readmodelServices,
    workers: { receipts: receiptSender },
  });
  await saga
    .given(issued)
    .when(event("billing.invoice.settled", "inv-1", { paid: 100 }))
    .expectQueued([
      {
        name: sendReceipt.name,
        payload: { invoiceId: "inv-1", debtor: "Example Debtor Ltd", paid: 100 },
      },
    ])
    .expectState({ invoiceId: "inv-1", settledAt: "2026-10-15T12:00:00.000Z" })
    // The Worker never runs here: `reply` answers the queued request as the Worker runtime would.
    .when(reply(sendReceipt, { outcome: "ok", value: "receipt-inv-1" }))
    .expectCommands([domain.billing.invoice.confirmReceipt("inv-1", { reference: "receipt-inv-1" })])
    .expectState(null, "inv-1")
    .given(
      event("billing.invoice.issued", "inv-2", { customerId: "cus-1", debtor: "Example Debtor Ltd", amount: 50, dueDate: "2026-12-31" }),
      event("billing.invoice.settled", "inv-2", { paid: 50 }),
    )
    .when(reply(sendReceipt, { outcome: "failed", error: "mailbox full", attempts: 5 }))
    .expectCommands([])
    .expectState({ invoiceId: "inv-2", settledAt: "2026-10-15T12:00:00.000Z", failure: "mailbox full" });
});

test("renewals (Decorated): a billed period issues its Invoice and schedules the next renewal", async () => {
  await using saga = processFixture(Renewals, { name: "renewals" });
  await saga
    .when(
      event(PeriodBilled, "sub-1", {
        period: 1,
        customerId: "cus-1",
        debtor: "Example Debtor Ltd",
        amount: 30,
        from: "2026-10-01",
        dueDate: "2026-10-15",
        nextRenewal: "2026-11-01",
      }),
    )
    .expectCommands([
      domain.billing.invoice.issue("sub-1-period-1", {
        customerId: "cus-1",
        debtor: "Example Debtor Ltd",
        amount: 30,
        dueDate: "2026-10-15",
      }),
      {
        ...RenewSubscription.to("sub-1", { period: 2 }),
        notBefore: "2026-11-01T00:00:00.000Z",
        replaceKey: "renew:sub-1",
      },
    ])
    .expectState({ invoices: ["sub-1-period-1"] });
});
