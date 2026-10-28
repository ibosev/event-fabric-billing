import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Show } from "solid-js";
import type { Customer } from "../contracts.ts";
import { actions, fields, messageOf, page } from "../lib/module.ts";
import { comparePositions } from "../lib/position.ts";
import { ApiError } from "../services/api.ts";
import { Alert, Avatar, Card, Drawer, Empty, Field, Icon, LiveDot, PageHeader, Progress, Skeleton, Table, button, cell, clickRow, input, money, num, secondary, small, type Tone } from "../lib/ui.tsx";

type CustomerPage = { items: Customer[]; nextCursor: string | null };

/**
 * Customers, newest first, 20 per page (`GET /customers`, cursor pagination). The
 * `/customers/live` feed only hints that something changed: the page re-reads, with
 * `minPosition` never older than the newest hint, so a replica that is behind answers 503
 * and the page retries instead of showing stale data.
 */
export const customers = page((sandbox) => {
  const api = sandbox.getService("api");
  const router = sandbox.getService("router");
  const { signal } = sandbox;
  const { $busy, run } = actions(sandbox);
  const $cursors = atom<(string | undefined)[]>([undefined]);
  const $page = atom<CustomerPage>({ items: [], nextCursor: null });
  const $loading = atom(true);
  const $error = atom("");
  const $registering = atom(false);

  let minimum: string | undefined;
  let loading = false;
  let queued = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(retry), { once: true });
  const load = async (position?: string) => {
    if (position && (!minimum || comparePositions(position, minimum) > 0)) minimum = position;
    queued = true;
    if (loading) return;
    loading = true;
    clearTimeout(retry);
    $loading.set(true);
    try {
      do {
        queued = false;
        const query = new URLSearchParams();
        const before = $cursors.get().at(-1);
        if (before) query.set("before", before);
        if (minimum) query.set("minPosition", minimum);
        $page.set(await api.get<CustomerPage>(`/customers?${query}`, signal));
        $error.set("");
      } while (queued && !signal.aborted);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === 503) {
        retry = setTimeout(() => void load(), 1000);
        $error.set("The customer list is catching up…");
      } else $error.set(messageOf(error));
    } finally {
      loading = false;
      $loading.set(false);
    }
  };
  const $live = sandbox.getService("live").open("/api/customers/live", {
    snapshot: () => void load(),
    changed: ({ position }: { position: string }) => void load(position),
  }, signal);
  $cursors.listen(() => void load());

  const register = (event: SubmitEvent) => {
    const { values, reset } = fields(event);
    void run(async () => {
      const customer = await api.post<Customer>("/customers", {
        name: values.name,
        ...(values.creditLimit && { creditLimit: Number(values.creditLimit) }),
      });
      reset();
      $registering.set(false);
      router.navigate(`/customers/${customer._id}`);
    }, `Registered ${values.name}`);
  };

  const usage = (c: Customer) => c.balance / Math.max(c.creditLimit, 1);
  const usageTone = (value: number): Tone => (value >= 0.9 ? "danger" : value >= 0.6 ? "warning" : "success");

  return () => {
    const list = useStore($page);
    const isLoading = useStore($loading);
    const error = useStore($error);
    const live = useStore($live);
    const cursors = useStore($cursors);
    const busy = useStore($busy);
    const registering = useStore($registering);
    return (
      <>
        <PageHeader title="Customers" subtitle="Everyone you bill, newest registrations first." crumbs={[["Customers", "#/customers"]]}
          actions={<button class={button} onClick={() => $registering.set(true)}><Icon name="plus" class="size-4" />Register customer</button>} />
        <Show when={error()}><div class="mb-4"><Alert>{error()}</Alert></div></Show>
        <Card title="All customers" subtitle="Updates as other people register and pay" actions={<LiveDot on={live()} />}>
          <Show when={list().items.length} fallback={isLoading() ? <Skeleton rows={6} /> : <Empty icon="users" title="No customers yet">Register your first customer to start invoicing.</Empty>}>
            <Table head={["Customer", ["Invoices", "right"], ["Invoiced", "right"], ["Paid", "right"], "Credit used", ["Balance", "right"]]}>
              <For each={list().items}>
                {(customer) => (
                  <tr class={clickRow} onClick={() => router.navigate(`/customers/${customer._id}`)}>
                    <th scope="row" class={cell}>
                      <div class="flex items-center gap-3">
                        <Avatar name={customer.name} />
                        <div class="min-w-0">
                          <a href={`#/customers/${customer._id}`} class="block truncate font-semibold text-heading hover:text-fg-brand" onClick={(e) => e.stopPropagation()}>{customer.name}</a>
                          <span class="text-xs font-normal text-body">{customer.contacts.length ? customer.contacts[0]!.email : "No contact yet"}</span>
                        </div>
                      </div>
                    </th>
                    <td class={num}>{customer.invoices.length}</td>
                    <td class={num}>{money.format(customer.invoiced)}</td>
                    <td class={num}>{money.format(customer.paid)}</td>
                    <td class={`${cell} w-48`}>
                      <div class="flex items-center gap-2">
                        <div class="flex-1"><Progress value={usage(customer)} tone={usageTone(usage(customer))} /></div>
                        <span class="w-9 text-right text-xs tabular-nums">{Math.round(usage(customer) * 100)}%</span>
                      </div>
                      <span class="text-xs text-body-subtle">of {money.format(customer.creditLimit)}</span>
                    </td>
                    <td class={`${num} font-semibold text-heading`}>{money.format(customer.balance)}</td>
                  </tr>
                )}
              </For>
            </Table>
          </Show>
          <footer class="flex items-center justify-between border-t border-default bg-neutral-secondary-soft px-4 py-2.5">
            <span class="text-xs text-body">Page {cursors().length} · 20 per page</span>
            <nav aria-label="Customer pages" class="flex gap-2">
              <button class={secondary + small} disabled={isLoading() || cursors().length === 1} onClick={() => $cursors.set(cursors().slice(0, -1))}>Newer</button>
              <button class={secondary + small} disabled={isLoading() || !list().nextCursor} onClick={() => $cursors.set([...cursors(), list().nextCursor!])}>Older</button>
            </nav>
          </footer>
        </Card>
        <Drawer open={registering()} title="Register customer" subtitle="The server checks a registry first, so this can take a moment." onClose={() => $registering.set(false)}>
          <form onSubmit={register} class="space-y-5">
            <Field label="Name" for="customer-name">
              <input id="customer-name" name="name" required class={input} placeholder="Example Debtor Ltd" />
            </Field>
            <Field label="Credit limit (EUR)" for="customer-limit" hint="Charges that would push the balance past it are refused. Empty uses the server default.">
              <input id="customer-limit" name="creditLimit" type="number" min="0" class={input} placeholder="1000" />
            </Field>
            <button disabled={busy()} class={`${button} w-full`}>{busy() ? "Registering…" : "Register customer"}</button>
          </form>
        </Drawer>
      </>
    );
  };
});
