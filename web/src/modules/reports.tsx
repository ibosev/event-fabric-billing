import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Show } from "solid-js";
import type { Plan, Revenue } from "../contracts.ts";
import { page, resource } from "../lib/module.ts";
import { ApiError } from "../services/api.ts";
import { Alert, Card, Empty, Icon, PageHeader, Progress, Skeleton, Stat, Table, cell, date, dateTime, input, money, num, row } from "../lib/ui.tsx";

const missing = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * The `reporting` Readmodel group (admin only): revenue per day, kept with a custom
 * Identity, and active Subscriptions and monthly revenue per plan.
 */
export const reports = page((sandbox) => {
  const api = sandbox.getService("api");
  const admin = sandbox.getService("session").$session.get().role === "admin";
  const $day = atom(new Date().toISOString().slice(0, 10));
  // A clerk gets 403 from both; they are not asked at all.
  const revenue = resource(async (s) => admin ? api.get<Revenue>(`/reports/revenue/${$day.get()}`, s).catch((e) => (missing(e) ? undefined : Promise.reject(e))) : undefined, sandbox.signal);
  sandbox.signal.addEventListener("abort", $day.listen(() => void revenue.reload()), { once: true });
  const plans = resource((s) => Promise.all((admin ? ["basic", "pro"] : []).map((plan) =>
    api.get<Plan>(`/reports/plans/${plan}`, s).catch((e) => (missing(e) ? { _id: plan, active: 0, monthlyRevenue: 0 } : Promise.reject(e))))), sandbox.signal);

  return () => {
    const day = useStore($day);
    const state = useStore(revenue.$state);
    const planState = useStore(plans.$state);
    const methods = () => Object.entries(state().data?.byMethod ?? {});
    const mrr = () => (planState().data ?? []).reduce((t, p) => t + p.monthlyRevenue, 0);
    return (
      <>
        <PageHeader title="Reports" subtitle="The reporting Readmodels: revenue per day and per plan. Admin only." crumbs={[["Reports", "#/reports"]]}
          actions={admin && <input type="date" class={`${input} w-auto`} value={day()} aria-label="Day" onChange={(e) => $day.set(e.currentTarget.value)} />} />
        <Show when={admin} fallback={<Card><Empty icon="chart" title="Reports are for admins">The reporting Readmodels answer 403 to a clerk. Switch role in your menu, top right.</Empty></Card>}>
        <Show when={state().error ?? planState().error}>{(error) => <div class="mb-4"><Alert tone="danger">{error()}</Alert></div>}</Show>
        <div class="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label={`Revenue on ${date(day())}`} icon="cash" tone="success" value={money.format(state().data?.total ?? 0)} />
          <Stat label="Payments" icon="check" tone="brand" value={state().data?.payments ?? 0} />
          <Stat label="Last payment" icon="clock" tone="neutral" value={state().data ? dateTime(state().data!.lastPaymentAt) : "—"} />
        </div>
        <div class="grid items-start gap-6 lg:grid-cols-2">
          <Card title="By payment method" subtitle={`Share of ${money.format(state().data?.total ?? 0)}`}>
            <Show when={methods().length} fallback={state().loading && !state().data ? <Skeleton rows={2} /> : <Empty icon="chart" title="No payments on this day">Pick another day above.</Empty>}>
              <ul class="space-y-5 p-5">
                <For each={methods()}>
                  {([method, amount]) => (
                    <li>
                      <div class="mb-1.5 flex items-center justify-between text-sm">
                        <span class="inline-flex items-center gap-2 font-medium text-heading"><Icon name={method === "card" ? "card" : "cash"} class="size-4 text-body" />{method === "card" ? "Card" : "Bank transfer"}</span>
                        <span class="tabular-nums"><span class="font-semibold text-heading">{money.format(amount)}</span> · {Math.round((amount / (state().data!.total || 1)) * 100)}%</span>
                      </div>
                      <Progress value={amount / (state().data!.total || 1)} />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Card>
          <Card title="Plans" subtitle={`${money.format(mrr())} recurring per month`}>
            <Show when={planState().data} fallback={planState().error ? <Empty icon="chart">Could not load the plans.</Empty> : <Skeleton rows={2} />}>
              <Table head={["Plan", ["Active", "right"], ["Monthly revenue", "right"], "Share"]}>
                <For each={planState().data ?? []}>
                  {(plan) => (
                    <tr class={row}>
                      <th scope="row" class={`${cell} font-medium text-heading capitalize`}>{plan._id}</th>
                      <td class={num}>{plan.active}</td>
                      <td class={`${num} font-medium text-heading`}>{money.format(plan.monthlyRevenue)}</td>
                      <td class={`${cell} w-32`}><Progress value={plan.monthlyRevenue / (mrr() || 1)} /></td>
                    </tr>
                  )}
                </For>
              </Table>
            </Show>
          </Card>
        </div>
        </Show>
      </>
    );
  };
});
