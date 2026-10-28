/**
 * ─── Import scenario ───────────────────────────────────────────────────────────
 * Plays a third-party provider importing history through the load balancer, to
 * every replica. Ids are EventFabric's: each step waits for the id the previous one
 * returned, so the chain for one Customer is
 *
 *   register (slow: the registry check) → id
 *     ├─ 3 contacts, in parallel
 *     └─ 2 Invoices for that id, in parallel → ids
 *          ├─ first:  4 payments at once (the 4th overpays)
 *          └─ second: a void racing a payment
 *
 * Many chains run at once (`CONCURRENCY`), so different Customers never wait for
 * each other. A request whose outcome is unknown (504, or no answer) is resent under
 * the same Idempotency-Key, so it never runs twice. Then the scenario waits for the
 * Readmodels to settle and checks that every account agrees with its Invoices.
 *
 *   CUSTOMERS=20 CONCURRENCY=20 API_URL=http://lb
 */
import type { Customer } from "./readmodels/customers.js";
import type { Invoice } from "./readmodels/invoices.js";

const base = process.env.API_URL ?? "http://localhost:3300";
const customers = Number(process.env.CUSTOMERS ?? 20);
const concurrency = Number(process.env.CONCURRENCY ?? 20);
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Result = { kind: string; status: number; code?: string; instance?: string; attempts: number };
const results: Result[] = [];
let keys = 0;

/** Sends one request, resending an unknown outcome with the same key; returns the body. */
const send = async (kind: string, method: string, path: string, body: unknown, admin = false) => {
  const key = `${run}:${keys++}`;
  for (let attempts = 1; ; attempts++) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Tenant": `import-${run}`,
        "X-User": "provider",
        "Idempotency-Key": key,
        ...(admin ? { "X-Role": "admin" } : {}),
      },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const status = response?.status ?? 0;
    const json = (await response?.json().catch(() => ({}))) as any;
    if ((status === 0 || status === 502 || status === 504) && attempts < 8) {
      await sleep(Math.min(100 * 2 ** attempts, 3_000));
      continue;
    }
    results.push({ kind, status, code: json?.code ?? json?.error?.code, instance: response?.headers.get("X-Instance") ?? undefined, attempts });
    return { status, json };
  }
};
/** A created document's id: from the document (201), or from the accepted Events (202). */
const createdId = ({ json }: { json: any }): string | undefined =>
  json?._id ?? json?.events?.at(-1)?.stream?.id;

/* ─── One Customer's chain ─── */
type Created = { customerId?: string; invoices: (string | undefined)[] };
const chain = async (i: number): Promise<Created> => {
  const customerId = createdId(
    await send("register", "POST", "/customers", { name: `Debtor ${i}`, creditLimit: 10_000 }),
  );
  if (!customerId) return { invoices: [] };
  const contacts = [0, 1, 2].map((n) =>
    send("contact", "POST", `/customers/${customerId}/contacts`, {
      contactId: `p${n}`,
      name: `Person ${n}`,
      email: `person${n}@debtor${i}.example`,
    }),
  );
  const invoices = await Promise.all(
    [300, 200].map(async (amount) =>
      createdId(
        await send("issue", "POST", "/invoices", {
          customerId,
          debtor: `Debtor ${i}`,
          amount,
          dueDate: "2099-12-31",
        }),
      ),
    ),
  );
  const [first, second] = invoices;
  await Promise.all([
    ...contacts,
    ...(first
      ? [0, 1, 2, 3].map(() => send("payment", "POST", `/invoices/${first}/payments`, { amount: 100 }))
      : []),
    ...(second
      ? [
          send("void", "POST", `/invoices/${second}/void`, { reason: "Imported as cancelled" }, true),
          send("payment", "POST", `/invoices/${second}/payments`, { amount: 50 }),
        ]
      : []),
  ]);
  return { customerId, invoices };
};

const started = Date.now();
const created: Created[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < customers) {
      const i = next++;
      created[i] = await chain(i);
    }
  }),
);
const elapsed = Date.now() - started;

/* ─── Waiting for the Readmodels to settle ─── */
const read = async <T>(path: string) => {
  const response = await fetch(`${base}${path}`, { headers: { "X-Role": "admin" } });
  return response.status === 200 ? ((await response.json()) as T) : undefined;
};
const snapshot = async () =>
  Promise.all(
    created.map(async ({ customerId, invoices }) => ({
      customer: customerId ? await read<Customer>(`/customers/${customerId}`) : undefined,
      invoices: await Promise.all(
        invoices.map((id) => (id ? read<Invoice>(`/invoices/${id}`) : undefined)),
      ),
    })),
  );
let state = await snapshot();
for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
  await sleep(3_000);
  const again = await snapshot();
  const settled = JSON.stringify(again) === JSON.stringify(state);
  state = again;
  if (settled) break;
}

/* ─── Report ─── */
const tally = (key: (r: Result) => string) =>
  results.reduce<Record<string, number>>((all, r) => ({ ...all, [key(r)]: (all[key(r)] ?? 0) + 1 }), {});
console.log(`\nImport of ${results.length} requests for ${customers} Customers in ${elapsed} ms`);
console.log("\nOutcomes by request kind (status/code):");
for (const [kind, count] of Object.entries(tally((r) => `${r.kind} ${r.status}${r.code ? `/${r.code}` : ""}`)).sort())
  console.log(`  ${kind.padEnd(36)} ${count}`);
console.log("\nRequests answered per replica:");
for (const [instance, count] of Object.entries(tally((r) => r.instance ?? "none")))
  console.log(`  ${instance.padEnd(36)} ${count}`);
const resent = results.filter((r) => r.attempts > 1);
console.log(
  `\nResent requests (unknown outcome): ${resent.length}`,
  resent.length ? tally.call(null, (r) => (r.attempts > 1 ? r.kind : "first try")) : "",
);

const problems: string[] = [];
state.forEach(({ customer, invoices }, i) => {
  const { customerId } = created[i]!;
  if (!customerId || !customer) return problems.push(`Customer ${i}: missing`);
  if (customer.contacts.length !== 3)
    problems.push(`${customerId}: ${customer.contacts.length} of 3 contacts`);
  let invoiced = 0,
    paid = 0;
  invoices.forEach((invoice, n) => {
    const id = created[i]!.invoices[n];
    if (!id || !invoice) return problems.push(`${customerId}: Invoice ${n} missing`);
    if (invoice.paid > invoice.amount) problems.push(`${id}: paid ${invoice.paid} > ${invoice.amount}`);
    if ((invoice.status === "settled") !== (invoice.paid === invoice.amount))
      problems.push(`${id}: status ${invoice.status} with ${invoice.paid}/${invoice.amount} paid`);
    if (invoice.status !== "void") invoiced += invoice.amount;
    paid += invoice.paid;
  });
  if (customer.invoiced !== invoiced || customer.paid !== paid || customer.balance !== invoiced - paid)
    problems.push(
      `${customerId}: account says invoiced ${customer.invoiced}, paid ${customer.paid}, balance ${customer.balance}; Invoices say ${invoiced}, ${paid}, ${invoiced - paid}`,
    );
});
console.log(
  problems.length
    ? `\n${problems.length} inconsistencies after the Readmodels settled:\n  ${problems.join("\n  ")}`
    : "\nEvery Customer's account agrees with its Invoices.",
);
console.log(
  "\nRejected Saga Commands are dead letters: docker compose run --rm --no-deps app node_modules/event-fabric/dist/cli/main.js dead-letters list --config dist/event-fabric.config.js",
);
