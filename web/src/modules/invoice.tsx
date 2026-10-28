import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Show } from "solid-js";
import type { Dunning, Invoice } from "../contracts.ts";
import { actions, fields, inDays, page, resource } from "../lib/module.ts";
import { ApiError } from "../services/api.ts";
import {
  Alert, Avatar, Badge, Card, Due, Empty, Field, Icon, InvoiceBadge, LiveDot, PageHeader, Skeleton, Stat, Table,
  button, cell, danger, date, dateTime, input, money, num, row, secondary, shortId, small,
} from "../lib/ui.tsx";

/** The dunning stages in order; an instance ends in `settled`, `void` or `overdue`. */
const steps = [["awaiting-payment", "Awaiting payment"], ["reminded", "Reminder sent"], ["promised", "Promised to pay"]] as const;
const outcomes: Record<string, [string, "success" | "neutral" | "danger"]> = { settled: ["Settled", "success"], void: ["Voided", "neutral"], overdue: ["Gave up: overdue", "danger"] };

/** Where the dunning stands, as a vertical stepper: done steps, the current one, what is left. */
function Stepper(props: { stage: string; reminders: number }) {
  const ended = () => outcomes[props.stage];
  const reached = (index: number) => {
    if (ended()) return index === 0 || (index === 1 && props.reminders > 0);
    return steps.findIndex(([key]) => key === props.stage) >= index;
  };
  const current = (key: string) => key === props.stage;
  return (
    <ol class="relative space-y-4 border-s border-default ps-6">
      <For each={steps}>
        {([key, text], i) => (
          <Show when={key !== "promised" || current(key)}>
            <li class="relative">
              <span class={`absolute -start-[2.03rem] grid size-5 place-items-center rounded-full ring-4 ring-neutral-primary-soft ${
                current(key) ? "bg-brand text-white" : reached(i()) ? "bg-success text-white" : "bg-neutral-secondary-medium text-body"}`}>
                <Show when={reached(i()) && !current(key)} fallback={<span class="size-1.5 rounded-full bg-current" />}><Icon name="check" class="size-3" /></Show>
              </span>
              <p class={`text-sm font-medium ${reached(i()) ? "text-heading" : "text-body"}`}>{text}</p>
              <Show when={key === "reminded"}><p class="text-xs text-body">{props.reminders ? `${props.reminders} reminder(s) emailed` : ended() ? "Not needed" : "After the due date"}</p></Show>
              <Show when={current(key)}><p class="text-xs text-fg-brand">Waiting here now</p></Show>
            </li>
          </Show>
        )}
      </For>
      <li class="relative">
        <span class={`absolute -start-[2.03rem] grid size-5 place-items-center rounded-full ring-4 ring-neutral-primary-soft ${
          ended() ? (ended()![1] === "danger" ? "bg-danger text-white" : ended()![1] === "success" ? "bg-success text-white" : "bg-neutral-tertiary text-white") : "bg-neutral-secondary-medium text-body"}`}>
          <Icon name={ended()?.[1] === "danger" ? "alarm" : "check"} class="size-3" />
        </span>
        <p class={`text-sm font-medium ${ended() ? "text-heading" : "text-body"}`}>{ended()?.[0] ?? "Paid, voided or overdue"}</p>
        <Show when={!ended()}><p class="text-xs text-body">Ends the Workflow</p></Show>
      </li>
    </ol>
  );
}

/**
 * One Invoice: its payments, the receipt the receipts Saga and Worker produce, and its
 * dunning Workflow (`queryWorkflow`): the stage it waits in and the reminders it sent.
 * A debtor's promise to pay is a Signal that extends the Workflow's last wait once.
 */
export const invoice = page((sandbox, { id }) => {
  const api = sandbox.getService("api");
  const { signal } = sandbox;
  const { $busy, run } = actions(sandbox);
  const doc = resource((s) => api.get<Invoice>(`/invoices/${id}`, s), signal);
  // Staff only; a portal caller gets 403, an Invoice without dunning 404.
  const dunning = resource((s) => api.get<Dunning>(`/invoices/${id}/dunning`, s).catch((error) =>
    error instanceof ApiError && [403, 404].includes(error.status) ? undefined : Promise.reject(error)), signal);
  const refresh = () => { void doc.reload(); void dunning.reload(); };

  // The customer's feed tells when this Invoice changes, e.g. when the receipt arrives.
  const $live = atom(false);
  let opened = false;
  const unbind = doc.$state.listen(({ data }) => {
    if (!data || opened) return;
    opened = true;
    sandbox.getService("live").open(`/api/customers/${data.customerId}/invoices/live`, {
      changed: ({ ids }: { ids: string[] }) => ids.includes(id) && refresh(),
    }, signal).subscribe((on) => $live.set(on));
  });
  signal.addEventListener("abort", unbind, { once: true });

  const pay = (event: SubmitEvent) => {
    const { values, reset } = fields(event);
    void run(async () => {
      await api.post(`/invoices/${id}/payments`, { amount: Number(values.amount), method: values.method }, { "Idempotency-Key": crypto.randomUUID() });
      reset();
      refresh();
    }, "Payment recorded");
  };
  const settle = () => run(async () => {
    const { receipt } = await api.post<{ receipt: string }>(`/invoices/${id}/settle`, {});
    refresh();
    return receipt;
  }, "Settled; the receipt arrived");
  const voidIt = (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => { await api.post(`/invoices/${id}/void`, { reason: values.reason }); refresh(); }, "Invoice voided");
  };
  const promise = (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => { await api.post(`/invoices/${id}/promise`, { until: values.until }); setTimeout(refresh, 500); }, "Promise to pay sent to the dunning Workflow");
  };

  return () => {
    const state = useStore(doc.$state);
    const flow = useStore(dunning.$state);
    const busy = useStore($busy);
    const live = useStore($live);
    return (
      <Show when={state().data} fallback={state().error ? <Alert tone="danger">{state().error}</Alert> : <Card><Skeleton rows={5} /></Card>}>
        {(invoice) => {
          const open = () => invoice().status === "open" || invoice().status === "overdue";
          const left = () => invoice().amount - invoice().paid;
          return (
            <>
              <PageHeader
                leading={<span class="grid size-14 place-items-center rounded-base bg-brand-softer text-fg-brand"><Icon name="invoice" class="size-7" /></span>}
                title={<span class="flex flex-wrap items-center gap-3">Invoice <span class="font-mono">{shortId(id)}</span><InvoiceBadge status={invoice().status} /></span>}
                subtitle={<span class="inline-flex flex-wrap items-center gap-x-2">
                  <a href={`#/customers/${invoice().customerId}`} class="font-medium text-heading hover:text-fg-brand">{invoice().debtor}</a>
                  <span aria-hidden="true">·</span>due {date(invoice().dueDate)}
                  <Show when={id.includes("-period-")}><span aria-hidden="true">·</span>subscription</Show>
                </span>}
                crumbs={[["Invoices", "#/invoices"], [shortId(id), `#/invoices/${id}`]]}
                actions={<>
                  <a href={`#/events/billing/invoice/${id}`} class={secondary}><Icon name="code" class="size-4" />Events</a>
                  <Show when={open()}>
                    <button disabled={busy()} class={button} title="Pays what is left and waits for the receipt, four hops away" onClick={() => void settle()}>
                      <Icon name="check" class="size-4" />Settle {money.format(left())}
                    </button>
                  </Show>
                </>} />

              <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Amount" icon="invoice" tone="brand" value={money.format(invoice().amount)} hint={<Due date={invoice().dueDate} open={open()} />} />
                <Stat label="Collected" icon="cash" tone="success" value={money.format(invoice().paid)} progress={invoice().paid / invoice().amount}
                  hint={`${invoice().payments.length} payment(s)`} />
                <Stat label="Outstanding" icon="clock" tone={invoice().status === "overdue" ? "danger" : "warning"} value={money.format(open() ? left() : 0)}
                  hint={open() ? "Still to collect" : invoice().status === "void" ? "Nothing to collect" : "Fully paid"} />
                <Stat label="Receipt" icon="mail" tone="neutral" value={invoice().receipt ? "Sent" : invoice().status === "void" ? "—" : "Pending"}
                  hint={invoice().receipt ? <span class="block truncate font-mono" title={invoice().receipt!}>{invoice().receipt}</span> : invoice().voidReason ? `Voided: ${invoice().voidReason}` : "Emailed once paid"} />
              </div>

              <div class="grid gap-6 xl:grid-cols-3">
                <Card title="Payments" subtitle="Each one is a Command with an Idempotency-Key" class="xl:col-span-2" actions={<LiveDot on={live()} />}>
                  <Show when={invoice().payments.length} fallback={<Empty icon="cash" title="No payments yet">{open() ? "Record one below, or settle the whole amount." : ""}</Empty>}>
                    <Table head={["When", "Method", ["Amount", "right"]]}>
                      <For each={invoice().payments}>
                        {(payment) => (
                          <tr class={row}>
                            <td class={cell}>{dateTime(payment.at)}</td>
                            <td class={cell}>
                              <span class="inline-flex items-center gap-2"><Icon name={payment.method === "card" ? "card" : "cash"} class="size-4 text-body" />{payment.method === "card" ? "Card" : "Bank transfer"}</span>
                            </td>
                            <td class={`${num} font-medium text-heading`}>{money.format(payment.amount)}</td>
                          </tr>
                        )}
                      </For>
                    </Table>
                  </Show>
                  <Show when={open()}>
                    <form onSubmit={pay} class="grid items-end gap-3 border-t border-default bg-neutral-secondary-soft p-4 sm:grid-cols-[1fr_1fr_auto]">
                      <Field label="Amount (EUR)" for="pay-amount">
                        <input id="pay-amount" name="amount" type="number" step="0.01" min="0.01" required placeholder={left().toFixed(2)} class={input} />
                      </Field>
                      <Field label="Method" for="pay-method">
                        <select id="pay-method" name="method" class={input}>
                          <option value="bank-transfer">Bank transfer</option>
                          <option value="card">Card</option>
                        </select>
                      </Field>
                      <button disabled={busy()} class={button}>Record payment</button>
                    </form>
                  </Show>
                </Card>

                <div class="grid items-start content-start gap-6 md:grid-cols-2 xl:grid-cols-1">
                  <Card title="Dunning" subtitle="The Workflow that chases this invoice"
                    actions={<Show when={flow().data}>{(d) => <Badge dot tone={d().status === "running" ? "brand" : "neutral"}>{d().status === "running" ? "Running" : "Finished"}</Badge>}</Show>}>
                    <Show when={flow().data} fallback={flow().loading && !flow().data ? <Skeleton rows={2} /> : <Empty icon="alarm">{flow().error ?? "No dunning Workflow visible to this caller."}</Empty>}>
                      {(d) => <div class="px-5 py-4 ps-7"><Stepper stage={d().state?.stage ?? "awaiting-payment"} reminders={d().state?.remindersSent ?? 0} /></div>}
                    </Show>
                    <Show when={open() && flow().data?.status === "running"}>
                      <form onSubmit={promise} class="space-y-3 border-t border-default bg-neutral-secondary-soft p-4">
                        <Field label="Debtor promises to pay by" for="promise-until" hint="A Signal: extends the last wait once.">
                          <input id="promise-until" name="until" type="date" required value={inDays(14)} class={input} />
                        </Field>
                        <button disabled={busy()} class={`${secondary}${small} w-full`}>Send promise</button>
                      </form>
                    </Show>
                  </Card>
                  <Show when={open()}>
                    <Card title="Void invoice" subtitle="Admin only, and not after a payment">
                      <form onSubmit={voidIt} class="space-y-3 p-4">
                        <input name="reason" required placeholder="Reason, e.g. duplicate" aria-label="Void reason" class={input} />
                        <button disabled={busy()} class={`${danger}${small} w-full`}>Void invoice</button>
                      </form>
                    </Card>
                  </Show>
                  <Card title="Customer">
                    <a href={`#/customers/${invoice().customerId}`} class="flex items-center gap-3 px-4 py-3 hover:bg-neutral-secondary-soft">
                      <Avatar name={invoice().debtor} />
                      <span class="min-w-0 flex-1 truncate text-sm font-medium text-heading">{invoice().debtor}</span>
                      <Icon name="chevron" class="size-4 text-body" />
                    </a>
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Show>
    );
  };
});
