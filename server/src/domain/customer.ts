import { randomUUID } from "node:crypto";
import { aggregate, only, Rejection, Type } from "event-fabric";

export const Registered = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    // How much the Customer may owe at once; `DEFAULT_CREDIT_LIMIT` when absent.
    creditLimit: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export const DEFAULT_CREDIT_LIMIT = 1_000;
/** One line of a Customer's account: which Invoice, and how much. */
const Entry = Type.Object(
  { invoiceId: Type.String(), amount: Type.Number({ exclusiveMinimum: 0 }) },
  { additionalProperties: false },
);
/** Someone to talk to at the Customer. The payload holds personal data; Metadata never does. */
export const Contact = Type.Object(
  {
    contactId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    email: Type.String({ format: "email" }),
  },
  { additionalProperties: false },
);
const Refused = Type.Object(
  {
    invoiceId: Type.String(),
    amount: Type.Number({ exclusiveMinimum: 0 }),
    reason: Type.Literal("credit-limit"),
  },
  { additionalProperties: false },
);

/**
 * ─── Aggregate `billing.customer` ──────────────────────────────────────────────
 * A second Aggregate in the same Context. It never reads an Invoice: Aggregates are
 * separate consistency units, and the accounts Saga (`sagas/accounts.ts`) carries
 * each Invoice's charges and payments here as Commands.
 */
export const customer = aggregate("billing", "customer", {
  state: Type.Object({
    name: Type.String(),
    balance: Type.Number(),
    creditLimit: Type.Number(),
    contacts: Type.Array(Type.String()),
  }),
  initialState: {
    name: "",
    balance: 0,
    creditLimit: DEFAULT_CREDIT_LIMIT,
    contacts: [],
  },
  idGenerator: () => randomUUID(),

  /*
   * Aggregate-wide Rules run after the Steps of every Command, not just one. This
   * invariant holds whichever Command changes the balance.
   */
  rules: [
    (current) => {
      if (current.get("balance") < 0)
        throw new Rejection("rule", "A Customer's balance cannot go negative");
    },
  ],

  commands: {
    /*
     * Registration checks the Customer with an outside registry first, which takes a
     * while (`REGISTRY_DELAY_MS`). A Step may call services; Event handlers never may.
     */
    register: {
      schema: Registered,
      steps: [
        only.ifNotExists(),
        async (command, customer, app) => {
          await app.getServices().registry.verify(command.payload.name, {
            signal: app.signal,
          });
          customer.apply.registered(command.payload);
        },
      ],
    },
    /* Adding a contact the Customer already has records nothing, so a resend is harmless. */
    addContact: {
      schema: Contact,
      steps: [
        only.ifExists(),
        (command, customer) => {
          if (!customer.get("contacts").includes(command.payload.contactId))
            customer.apply.contactAdded(command.payload);
        },
      ],
    },
    /* Sent by the accounts Saga only; the Gateway's Access map does not expose them. */

    /*
     * ─── A refusal recorded as an Event ───
     * This Command comes from a Saga, through the Outbox, after the HTTP request that
     * issued the Invoice has been answered. A Rejection here would reach no caller: the
     * Outbox dead-letters a rejected Command for an operator (`dead-letters list`), and
     * the Saga is never told.
     *
     * Going over the credit limit is a business outcome someone must act on, so the
     * Command is accepted and records `chargeRefused`. The accounts Saga reacts to that
     * Event and voids the Invoice. Throw a Rejection only where the caller can see it.
     */
    chargeInvoice: {
      schema: Entry,
      steps: [
        only.ifExists(),
        (command, customer) => {
          const { invoiceId, amount } = command.payload;
          if (customer.get("balance") + amount > customer.get("creditLimit"))
            customer.apply.chargeRefused({ invoiceId, amount, reason: "credit-limit" });
          else customer.apply.invoiceCharged(command.payload);
        },
      ],
    },
    creditPayment: {
      schema: Entry,
      steps: [
        only.ifExists(),
        (command, customer) => customer.apply.paymentCredited(command.payload),
      ],
    },
    reverseCharge: {
      schema: Entry,
      steps: [
        only.ifExists(),
        (command, customer) => customer.apply.chargeReversed(command.payload),
      ],
    },
  },

  events: {
    registered: {
      schema: Registered,
      handler: ({ payload }, state) =>
        state.set({
          name: payload.name,
          creditLimit: payload.creditLimit ?? DEFAULT_CREDIT_LIMIT,
        }),
    },
    contactAdded: {
      schema: Contact,
      handler: ({ payload }, state) =>
        state.set("contacts", [...state.get("contacts"), payload.contactId]),
    },
    invoiceCharged: {
      schema: Entry,
      handler: ({ payload }, state) =>
        state.set("balance", state.get("balance") + payload.amount),
    },
    /* Changes no state: the balance stays as it was. It exists to be reacted to. */
    chargeRefused: {
      schema: Refused,
      handler: () => {},
    },
    paymentCredited: {
      schema: Entry,
      handler: ({ payload }, state) =>
        state.set("balance", state.get("balance") - payload.amount),
    },
    chargeReversed: {
      schema: Entry,
      handler: ({ payload }, state) =>
        state.set("balance", state.get("balance") - payload.amount),
    },
  },
});
