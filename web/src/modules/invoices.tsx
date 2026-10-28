import { useStore } from "@nanostores/solid";
import { atom, computed } from "nanostores";
import { For, Show } from "solid-js";
import type { Invoice, InvoiceStatus } from "../contracts.ts";
import { page, resource } from "../lib/module.ts";
import { Alert, Avatar, Card, Due, Empty, Icon, InvoiceBadge, PageHeader, Progress, Skeleton, Table, cell, clickRow, input, money, num, secondary, shortId } from "../lib/ui.tsx";

const statuses: [InvoiceStatus | "", string][] = [["", "All"], ["open", "Open"], ["overdue", "Overdue"], ["settled", "Paid"], ["void", "Void"]];

/**
 * Invoices across Customers (`GET /invoices`): a status filter on its index, `method` as an
 * `elemMatch` over the payments child table, and `q`, a text search over debtors
 * (quoted phrases, `-term` excludes). A customer-portal caller sees only their own.
 * `#/invoices?q=…&status=…` (the navbar search) seeds the filters.
 */
export const invoices = page((sandbox, params) => {
  const api = sandbox.getService("api");
  const router = sandbox.getService("router");
  const $status = atom(params.status ?? "");
  const $method = atom("");
  const $q = atom(params.q ?? "");
  const $query = computed([$status, $method, $q], (status, method, q) =>
    new URLSearchParams(Object.entries({ status, method, q }).filter(([, value]) => value)).toString());
  const list = resource((s) => api.get<Invoice[]>(`/invoices?${$query.get()}`, s), sandbox.signal);
  let typing: ReturnType<typeof setTimeout> | undefined;
  sandbox.signal.addEventListener("abort", $query.listen(() => {
    clearTimeout(typing);
    typing = setTimeout(() => void list.reload(), 250);
  }), { once: true });

  return () => {
    const state = useStore(list.$state);
    const status = useStore($status);
    const method = useStore($method);
    const q = useStore($q);
    const rows = () => state().data ?? [];
    const outstanding = () => rows().filter((i) => i.status === "open" || i.status === "overdue").reduce((t, i) => t + i.amount - i.paid, 0);
    return (
      <>
        <PageHeader title="Invoices" subtitle="Every invoice you can see, soonest due first." crumbs={[["Invoices", "#/invoices"]]}
          actions={<button class={secondary} disabled={state().loading} onClick={() => void list.reload()}><Icon name="refresh" class={`size-4 ${state().loading ? "animate-spin" : ""}`} />Refresh</button>} />
        <Card>
          <div class="flex flex-col gap-3 border-b border-default p-4 lg:flex-row lg:items-center">
            <div role="radiogroup" aria-label="Status" class="inline-flex shrink-0 overflow-x-auto rounded-base border border-default bg-neutral-secondary-soft p-0.5">
              <For each={statuses}>
                {([value, text]) => (
                  <button role="radio" aria-checked={status() === value} onClick={() => $status.set(value)}
                    class={`rounded-[calc(var(--radius-base)-2px)] px-3 py-1.5 text-sm font-medium whitespace-nowrap ${status() === value ? "bg-neutral-primary-soft text-heading shadow-xs" : "text-body hover:text-heading"}`}>
                    {text}
                  </button>
                )}
              </For>
            </div>
            <div class="relative flex-1">
              <Icon name="search" class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-body" />
              <input type="search" class={`${input} pl-9`} placeholder='Search debtors: example, "debtor ltd", -retry' aria-label="Search debtors"
                value={q()} onInput={(e) => $q.set(e.currentTarget.value)} />
            </div>
            <select class={`${input} lg:w-52`} aria-label="Paid by" value={method()} onChange={(e) => $method.set(e.currentTarget.value)}>
              <option value="">Any payment method</option>
              <option value="card">Paid by card</option>
              <option value="bank-transfer">Paid by bank transfer</option>
            </select>
          </div>
          <Show when={state().error}><div class="p-4"><Alert tone="danger">{state().error}</Alert></div></Show>
          <Show when={rows().length} fallback={state().loading && !state().data ? <Skeleton rows={6} /> : <Empty icon="invoice" title="No invoices match">Try another status or search.</Empty>}>
            <Table head={["Invoice", "Debtor", "Due", ["Amount", "right"], "Collected", "Status"]}>
              <For each={rows()}>
                {(invoice) => (
                  <tr class={clickRow} onClick={() => router.navigate(`/invoices/${invoice._id}`)}>
                    <td class={cell}>
                      <a href={`#/invoices/${invoice._id}`} class="font-mono text-xs font-semibold text-heading hover:text-fg-brand" onClick={(e) => e.stopPropagation()}>{shortId(invoice._id)}</a>
                      <Show when={invoice._id.includes("-period-")}><p class="text-xs text-body">subscription</p></Show>
                    </td>
                    <td class={cell}>
                      <a href={`#/customers/${invoice.customerId}`} class="flex items-center gap-2.5 font-medium whitespace-nowrap text-heading hover:text-fg-brand" onClick={(e) => e.stopPropagation()}>
                        <Avatar name={invoice.debtor} />{invoice.debtor}
                      </a>
                    </td>
                    <td class={cell}><Due date={invoice.dueDate} open={invoice.status === "open" || invoice.status === "overdue"} /></td>
                    <td class={`${num} font-medium text-heading`}>{money.format(invoice.amount)}</td>
                    <td class={`${cell} w-40`}>
                      <div class="mb-1 text-right text-xs tabular-nums">{Math.round((invoice.paid / invoice.amount) * 100)}%</div>
                      <Progress value={invoice.paid / invoice.amount} tone={invoice.status === "void" ? "neutral" : "success"} />
                    </td>
                    <td class={cell}><InvoiceBadge status={invoice.status} /></td>
                  </tr>
                )}
              </For>
            </Table>
            <footer class="flex items-center justify-between border-t border-default bg-neutral-secondary-soft px-4 py-2.5 text-xs text-body">
              <span>{rows().length} invoice(s) · at most 50</span>
              <span>Outstanding <span class="font-semibold tabular-nums text-heading">{money.format(outstanding())}</span></span>
            </footer>
          </Show>
        </Card>
      </>
    );
  };
});
