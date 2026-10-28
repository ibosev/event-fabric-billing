import {
  Type,
  type Document,
  type EventsOf,
  type ReactionView,
  type Reactions,
} from "event-fabric";
import { DEFAULT_CREDIT_LIMIT } from "../domain/customer.js";
import { domain } from "../domain/index.js";

const Customer = Type.Object({
  name: Type.String(),
  creditLimit: Type.Number(),
  invoiced: Type.Number(),
  paid: Type.Number(),
  balance: Type.Number(),
  invoices: Type.Array(Type.String()),
  // An array of objects: on Postgres, a child table of `customers`.
  contacts: Type.Array(
    Type.Object({ contactId: Type.String(), name: Type.String(), email: Type.String() }),
  ),
});
/** A document of the Readmodel `billing.customers`, as stores return it. */
export type Customer = Document<typeof Customer>;

/**
 * ─── Readmodel `billing.customers` ─────────────────────────────────────────────
 * Built from the Customer's own Events, which the accounts Saga causes. A second
 * model in the `billing` group: both share one Checkpoint and commit together.
 */
const reactions: Reactions<
  EventsOf<typeof domain>,
  ReactionView<Customer>
> = {
  [domain.billing.customer.registered]: ({ payload }, vm) =>
    vm.set({
      name: payload.name,
      creditLimit: payload.creditLimit ?? DEFAULT_CREDIT_LIMIT,
      invoiced: 0,
      paid: 0,
      balance: 0,
      invoices: [],
      contacts: [],
    }),
  [domain.billing.customer.contactAdded]: ({ payload }, vm) =>
    vm.set("contacts", [...vm.get("contacts"), payload]),
  [domain.billing.customer.invoiceCharged]: ({ payload }, vm) =>
    vm.set({
      invoiced: vm.get("invoiced") + payload.amount,
      balance: vm.get("balance") + payload.amount,
      invoices: [...vm.get("invoices"), payload.invoiceId],
    }),
  [domain.billing.customer.paymentCredited]: ({ payload }, vm) =>
    vm.set({
      paid: vm.get("paid") + payload.amount,
      balance: vm.get("balance") - payload.amount,
    }),
  [domain.billing.customer.chargeReversed]: ({ payload }, vm) =>
    vm.set({
      invoiced: vm.get("invoiced") - payload.amount,
      balance: vm.get("balance") - payload.amount,
    }),
};

/** The Readmodel `billing.customers`. */
export const customers = { schema: Customer, reactions };
