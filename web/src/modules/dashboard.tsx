import { useStore } from "@nanostores/solid";
import { For, Show } from "solid-js";
import type { Customer, Invoice, Plan, Revenue } from "../contracts.ts";
import { page, resource } from "../lib/module.ts";
import { ApiError } from "../services/api.ts";
import { Avatar, Card, Due, Empty, InvoiceBadge, PageHeader, Skeleton, Stat, Table, cell, clickRow, link, money, num, shortId } from "../lib/ui.tsx";

const today = () => new Date().toISOString().slice(0, 10);
const sum = (list: Invoice[]) => list.reduce((total, i) => total + i.amount - i.paid, 0);
/** A missing report document is a day or plan with nothing in it yet. */
const orEmpty = <T,>(read: Promise<T>, empty: T) =>
  read.catch((error) => (error instanceof ApiError && error.status === 404 ? empty : Promise.reject(error)));

/** Overview: outstanding and overdue Invoices, today's revenue and plans (admin), newest Customers. */
export const dashboard = page((sandbox) => {
  const api = sandbox.getService("api");
  const router = sandbox.getService("router");
  const { signal } = sandbox;
  const admin = sandbox.getService("session").$session.get().role === "admin";
  // The Gateway answers at most 50 per query; enough for an overview.
  const open = resource((s) => api.get<Invoice[]>("/invoices?status=open", s), signal);
  const overdue = resource((s) => api.get<Invoice[]>("/invoices?status=overdue", s), signal);
  const newest = resource((s) => api.get<{ items: Customer[] }>("/customers", s), signal);
  const revenue = admin ? resource((s) => orEmpty(api.get<Revenue>(`/reports/revenue/${today()}`, s), undefined), signal) : undefined;
  const plans = admin
    ? resource((s) => Promise.all(["basic", "pro"].map((plan) => orEmpty(api.get<Plan>(`/reports/plans/${plan}`, s), { _id: plan, active: 0, monthlyRevenue: 0 }))), signal)
    : undefined;

  return () => {
    const openList = useStore(open.$state);
    const overdueList = useStore(overdue.$state);
    const customers = useStore(newest.$state);
    const day = revenue && useStore(revenue.$state);
    const planList = plans && useStore(plans.$state);
    const count = (list?: Invoice[]) => (list ? `${list.length}${list.length === 50 ? "+" : ""}` : "…");
    const adminOnly = "Admin only: switch role in your menu";
    const due = () => [...(overdueList().data ?? []), ...(openList().data ?? [])].slice(0, 8);
    const name = sandbox.getService("session").$session.get().user;
    return (
      <>
        <PageHeader title={`Welcome back, ${name}`} subtitle="What needs collecting, and who joined lately." />
        <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Open invoices" icon="invoice" tone="brand" value={count(openList().data)} hint={`${money.format(sum(openList().data ?? []))} outstanding`} />
          <Stat label="Overdue" icon="alarm" tone={(overdueList().data ?? []).length ? "danger" : "success"} value={count(overdueList().data)} hint={`${money.format(sum(overdueList().data ?? []))} past due`} />
          <Stat label="Revenue today" icon="cash" tone="success" value={day ? money.format(day().data?.total ?? 0) : "—"} hint={day ? `${day().data?.payments ?? 0} payment(s)` : adminOnly} />
          <Stat label="Recurring / month" icon="repeat" tone="neutral" value={planList ? money.format((planList().data ?? []).reduce((t, p) => t + p.monthlyRevenue, 0)) : "—"}
            hint={planList ? (planList().data ?? []).map((p) => `${p._id} ${p.active}`).join(" · ") + " active" : adminOnly} />
        </div>
        <div class="grid items-start gap-6 xl:grid-cols-3">
          <Card title="Due next" subtitle="Overdue first, then soonest due" class="xl:col-span-2" actions={<a href="#/invoices" class={`${link} text-sm`}>All invoices</a>}>
            <Show when={due().length} fallback={openList().loading && !openList().data ? <Skeleton rows={4} /> : <Empty icon="check" title="All caught up">No open invoices.</Empty>}>
              <Table head={["Debtor", "Invoice", "Due", ["Outstanding", "right"], "Status"]}>
                <For each={due()}>
                  {(invoice) => (
                    <tr class={clickRow} onClick={() => router.navigate(`/invoices/${invoice._id}`)}>
                      <td class={cell}><span class="flex items-center gap-2.5 font-medium text-heading"><Avatar name={invoice.debtor} />{invoice.debtor}</span></td>
                      <td class={`${cell} font-mono text-xs`}>{shortId(invoice._id)}</td>
                      <td class={cell}><Due date={invoice.dueDate} open /></td>
                      <td class={`${num} font-medium text-heading`}>{money.format(invoice.amount - invoice.paid)}</td>
                      <td class={cell}><InvoiceBadge status={invoice.status} /></td>
                    </tr>
                  )}
                </For>
              </Table>
            </Show>
          </Card>
          <Card title="Newest customers" actions={<a href="#/customers" class={`${link} text-sm`}>All</a>}>
            <Show when={(customers().data?.items ?? []).length} fallback={customers().loading ? <Skeleton rows={4} /> : <Empty icon="users">No customers yet.</Empty>}>
              <ul class="divide-y divide-default">
                <For each={(customers().data?.items ?? []).slice(0, 6)}>
                  {(customer) => (
                    <li>
                      <a href={`#/customers/${customer._id}`} class="flex items-center gap-3 px-4 py-3 hover:bg-neutral-secondary-soft">
                        <Avatar name={customer.name} />
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium text-heading">{customer.name}</span>
                          <span class="text-xs text-body">{customer.invoices.length} invoice(s)</span>
                        </span>
                        <span class="text-sm font-medium tabular-nums text-heading">{money.format(customer.balance)}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Card>
        </div>
      </>
    );
  };
});
