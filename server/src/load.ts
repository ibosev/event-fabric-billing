/**
 * ─── Throughput test ───────────────────────────────────────────────────────────
 * `CONCURRENCY` clients loop for `DURATION_S` seconds through the load balancer,
 * each running register → issue → 2 payments on its own Customer. Every route that
 * answers with a document waits for the `billing` Readmodel group to catch up, so
 * latency includes that group's lag. Reports requests per second and latency per
 * kind. Run it with `REGISTRY_DELAY_MS=0` on the app, or registration dominates.
 *
 *   CONCURRENCY=50 DURATION_S=30 API_URL=http://lb
 */
const base = process.env.API_URL ?? "http://localhost:3300";
const concurrency = Number(process.env.CONCURRENCY ?? 50);
const duration = Number(process.env.DURATION_S ?? 30) * 1000;
const tenant = `load-${Date.now().toString(36)}`;

const latencies = new Map<string, number[]>();
const failures = new Map<string, number>();
const send = async (kind: string, path: string, body: unknown) => {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant": tenant, "X-User": "load" },
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

const started = Date.now();
const until = started + duration;
await Promise.all(
  Array.from({ length: concurrency }, async (_, worker) => {
    for (let i = 0; Date.now() < until; i++) {
      const customerId = await send("register", "/customers", { name: `Load ${worker}.${i}`, creditLimit: 1_000_000 });
      if (!customerId) continue;
      const invoiceId = await send("issue", "/invoices", { customerId, debtor: `Load ${worker}.${i}`, amount: 100, dueDate: "2099-12-31" });
      if (!invoiceId) continue;
      await send("payment", `/invoices/${invoiceId}/payments`, { amount: 40 });
      await send("payment", `/invoices/${invoiceId}/payments`, { amount: 60 });
    }
  }),
);
const elapsed = (Date.now() - started) / 1000;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const all = [...latencies.values()].flat();
console.log(`\n${concurrency} clients for ${elapsed.toFixed(1)} s: ${all.length} requests succeeded, ${(all.length / elapsed).toFixed(1)} req/s`);
console.log(`${"kind".padEnd(10)} ${"count".padStart(6)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)}  ms`);
for (const [kind, values] of [...latencies, ["all", all] as const]) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `${kind.padEnd(10)} ${String(sorted.length).padStart(6)} ${[0.5, 0.95, 0.99].map((p) => percentile(sorted, p).toFixed(0).padStart(7)).join(" ")}`,
  );
}
if (failures.size) {
  console.log("\nFailed:", Object.fromEntries(failures));
  process.exitCode = 1;
}
