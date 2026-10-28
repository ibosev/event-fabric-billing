/**
 * ─── Task `statement` ──────────────────────────────────────────────────────────
 * A one-off script run against the live Application from the CLI:
 *
 *   event-fabric task dist/tasks/statement.js --config dist/event-fabric.config.js -- <customer id>
 *
 * A Task module exports `run(ctx, args)`. Its context has `sendCommand`,
 * `awaitCorrelated`, `readmodels`, `services`, `logger`, `config`, and direct Event
 * store reads (`readStream`, `readAll`, `import`). A Task starts no consumers or
 * plugins, so it can run next to the deployed Application; `setupServices`, when the
 * config uses it, runs first and its cleanup runs after the Task.
 */
import type { Task } from "event-fabric";

/* `Task` types the context from `Register`: Readmodels, services and Event reads. */
export const run: Task = async (ctx, [customerId]) => {
  if (!customerId) throw new Error("Usage: task statement -- <customer id>");

  const { document: customer } = await ctx.readmodels.billing.customers(customerId);
  if (!customer) throw new Error(`No customer ${customerId}`);
  console.log(`${customer.name}: balance ${customer.balance}`);
  // `stream` reads page by page, so a Customer with thousands of Invoices never sits in memory at once.
  for await (const invoice of ctx.readmodels.billing.invoices.stream(
    { customerId },
    { sort: { dueDate: 1 } },
  )) {
    // The Invoice's Stream: every Event it recorded, oldest first, already upcast.
    const history = await ctx.readStream({
      context: "billing",
      aggregate: "invoice",
      id: invoice._id,
    });
    console.log(
      `  ${invoice._id}  due ${invoice.dueDate}  ${invoice.status.padEnd(8)}` +
        `  ${invoice.paid}/${invoice.amount}  ` +
        history.map((event) => `${event.revision}:${event.name}`).join(" → "),
    );
  }
};
