/**
 * ─── Import test ───────────────────────────────────────────────────────────────
 * Plays a bulk import through the load balancer: `CUSTOMERS` Customers, each with
 * `INVOICES` Invoices, run by `CONCURRENCY` workers. Per Customer it registers,
 * issues its Invoices in order with the returned id, then pays them: per 10 Invoices,
 * 3 stay unpaid, 3 are paid in part, 3 in full and 1 in two halves (0.8 payments per
 * Invoice). Existing data is kept, so repeated runs build up the Event log. Run it
 * with `REGISTRY_DELAY_MS=0` on the app, or registration dominates.
 *
 *   CUSTOMERS=2000 INVOICES=5 CONCURRENCY=50 API_URL=http://lb
 */
const base = process.env.API_URL ?? "http://localhost:3300";
const customers = Number(process.env.CUSTOMERS ?? 2000);
const invoicesPerCustomer = Number(process.env.INVOICES ?? 5);
const concurrency = Number(process.env.CONCURRENCY ?? 50);
const batch = `import-${Date.now().toString(36)}`;

const latencies = new Map<string, number[]>();
const failures = new Map<string, number>();
const send = async (kind: string, path: string, body: unknown) => {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant": batch, "X-User": "import" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  const json = (await response?.json().catch(() => ({}))) as any;
  const ok = response && response.status < 300;
  if (ok) {
    let samples = latencies.get(kind);
    if (!samples) latencies.set(kind, (samples = []));
    samples.push(performance.now() - started);
  } else {
    const key = `${kind} ${response?.status ?? 0}${json?.code ? `/${json.code}` : ""}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  return ok ? (json?._id ?? json?.events?.at(-1)?.stream?.id) : undefined;
};

/** Payments for the nth Invoice of an amount: none, part, full, or two halves. */
const plan = (n: number, amount: number) =>
  [[], [], [], [amount * 0.4], [amount * 0.4], [amount * 0.4], [amount], [amount], [amount], [amount / 2, amount / 2]][n % 10]!;

const started = Date.now();
let next = 0;
const progress = setInterval(
  () => console.log(`${((Date.now() - started) / 1000).toFixed(0)} s: ${next}/${customers} Customers started`),
  10_000,
);
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let c = next++; c < customers; c = next++) {
      const name = `${batch} ${c}`;
      const customerId = await send("register", "/customers", { name, creditLimit: 1_000_000 });
      if (!customerId) continue;
      const invoices: { id: string; amount: number; n: number }[] = [];
      for (let i = 0; i < invoicesPerCustomer; i++) {
        const amount = 100 + ((c * 7 + i * 13) % 900);
        const id = await send("issue", "/invoices", { customerId, debtor: name, amount, dueDate: "2099-12-31" });
        if (id) invoices.push({ id, amount, n: c * invoicesPerCustomer + i });
      }
      for (const { id, amount, n } of invoices)
        for (const part of plan(n, amount))
          await send("payment", `/invoices/${id}/payments`, { amount: part, method: n % 2 ? "card" : "bank-transfer" });
    }
  }),
);
clearInterval(progress);
const elapsed = (Date.now() - started) / 1000;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const all = [...latencies.values()].flat();
console.log(`\nImported ${customers} Customers × ${invoicesPerCustomer} Invoices with ${concurrency} workers in ${elapsed.toFixed(1)} s: ${all.length} requests, ${(all.length / elapsed).toFixed(1)} req/s`);
console.log(`${"kind".padEnd(10)} ${"count".padStart(6)} ${"per s".padStart(7)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)}  ms`);
for (const [kind, values] of [...latencies, ["all", all] as const]) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `${kind.padEnd(10)} ${String(sorted.length).padStart(6)} ${(sorted.length / elapsed).toFixed(1).padStart(7)} ${[0.5, 0.95, 0.99].map((p) => percentile(sorted, p).toFixed(0).padStart(7)).join(" ")}`,
  );
}
if (failures.size) {
  console.log("\nFailed:", Object.fromEntries(failures));
  process.exitCode = 1;
}
