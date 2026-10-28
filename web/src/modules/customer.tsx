import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Match, Show, Switch } from "solid-js";
import type { Customer, Invoice, Subscription } from "../contracts.ts";
import { actions, fields, inDays, page, resource } from "../lib/module.ts";
import {
  Alert, Avatar, Badge, Card, Drawer, Due, Empty, Field, Icon, InvoiceBadge, LiveDot, PageHeader, Progress, Skeleton, Stat, Table,
  button, cell, clickRow, danger, date, input, money, num, secondary, shortId, small, type Tone,
} from "../lib/ui.tsx";

type Panel =
  | { kind: "invoice" | "subscription" | "contact" }
  | { kind: "pay"; invoice: Invoice }
  | { kind: "cancel"; subscription: Subscription };

const titles = { invoice: "Issue invoice", subscription: "Start subscription", contact: "Add contact", pay: "Record payment", cancel: "Cancel subscription" };

/**
 * One Customer: profile, contacts, Invoices and Subscriptions. The Invoices come over
 * `/customers/:id/invoices/live`: a `snapshot`, then `changed` hints whose documents are
 * re-read with `minPosition`, so a payment's receipt (Saga → Worker → Command) shows up by itself.
 */
export const customer = page((sandbox, { id }) => {
  const api = sandbox.getService("api");
  const live = sandbox.getService("live");
  const router = sandbox.getService("router");
  const { signal } = sandbox;
  const { $busy, run } = actions(sandbox);
  const $panel = atom<Panel | undefined>();
  const close = () => $panel.set(undefined);

  const profile = resource((s) => api.get<Customer>(`/customers/${id}`, s), signal);
  const subscriptions = resource((s) => api.get<Subscription[]>(`/customers/${id}/subscriptions`, s), signal);
  const $invoices = atom<Record<string, Invoice>>({});
  const $loaded = atom(false);
  const $invoicesLive = live.open(`/api/customers/${id}/invoices/live`, {
    snapshot: (list: Invoice[]) => {
      $invoices.set(Object.fromEntries(list.map((doc) => [doc._id, doc])));
      $loaded.set(true);
    },
    changed: async ({ ids, position }: { ids: string[]; position: string }) => {
      for (const invoiceId of ids) {
        const doc = await api.get<Invoice>(`/invoices/${invoiceId}?minPosition=${encodeURIComponent(position)}`, signal).catch(() => undefined);
        if (doc) $invoices.set({ ...$invoices.get(), [doc._id]: doc });
      }
      // Payments move the balance; renewals issue Invoices.
      void profile.reload();
      void subscriptions.reload();
    },
  }, signal);
  live.open("/api/customers/live", {
    changed: ({ ids }: { ids: string[] }) => ids.includes(id) && void profile.reload(),
  }, signal);

  const issue = (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => {
      await api.post("/invoices", { customerId: id, debtor: profile.$state.get().data!.name, amount: Number(values.amount), dueDate: values.dueDate });
      close();
    }, "Invoice issued");
  };
  const pay = (invoice: Invoice) => (event: SubmitEvent) => {
    const { values } = fields(event);
    // A retry with the same key is a Duplicate Command: answered again, never paid twice.
    void run(async () => {
      await api.post(`/invoices/${invoice._id}/payments`, { amount: Number(values.amount), method: values.method }, { "Idempotency-Key": crypto.randomUUID() });
      close();
    }, "Payment recorded");
  };
  const settle = (invoice: Invoice) =>
    run(async () => {
      await api.post<{ receipt: string }>(`/invoices/${invoice._id}/settle`, {});
    }, `Invoice ${shortId(invoice._id)} is paid and its receipt was sent`);
  const start = (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => {
      await api.post("/subscriptions", { customerId: id, debtor: profile.$state.get().data!.name, plan: values.plan, monthlyAmount: Number(values.monthlyAmount), startsOn: values.startsOn });
      close();
      void subscriptions.reload();
    }, "Subscription started; its first invoice is on the way");
  };
  const cancel = (subscription: Subscription) => (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => {
      await api.post(`/subscriptions/${subscription._id}/cancel`, { reason: values.reason });
      close();
      void subscriptions.reload();
    }, "Subscription cancelled");
  };
  const addContact = (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => {
      await api.post(`/customers/${id}/contacts`, { contactId: crypto.randomUUID(), name: values.name, email: values.email });
      close();
      void profile.reload();
    }, "Contact added");
  };

  return () => {
    const state = useStore(profile.$state);
    const subs = useStore(subscriptions.$state);
    const invoices = useStore($invoices);
    const loaded = useStore($loaded);
    const invoicesLive = useStore($invoicesLive);
    const panel = useStore($panel);
    const busy = useStore($busy);
    const sorted = () => Object.values(invoices()).sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    const outstanding = () => sorted().filter((i) => i.status === "open" || i.status === "overdue");
    return (
      <Show when={state().data} fallback={state().error ? <Alert tone="danger">{state().error}</Alert> : <Card><Skeleton rows={5} /></Card>}>
        {(customer) => {
          const usage = () => customer().balance / Math.max(customer().creditLimit, 1);
          const usageTone = (): Tone => (usage() >= 0.9 ? "danger" : usage() >= 0.6 ? "warning" : "success");
          return (
            <>
              <PageHeader
                leading={<Avatar name={customer().name} size="lg" />}
                title={customer().name}
                subtitle={<span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="font-mono text-xs">{shortId(id)}</span>
                  <span aria-hidden="true">·</span>
                  {customer().contacts.length} contact(s)
                  <span aria-hidden="true">·</span>
                  <Badge dot tone={usageTone()}>{usage() >= 0.9 ? "Near credit limit" : "In good standing"}</Badge>
                </span>}
                crumbs={[["Customers", "#/customers"], [customer().name, `#/customers/${id}`]]}
                actions={<>
                  <a href={`#/events/billing/customer/${id}`} class={secondary} title="This customer's Events"><Icon name="code" class="size-4" />Events</a>
                  <button class={secondary} onClick={() => $panel.set({ kind: "contact" })}><Icon name="mail" class="size-4" />Add contact</button>
                  <button class={secondary} onClick={() => $panel.set({ kind: "subscription" })}><Icon name="repeat" class="size-4" />Subscribe</button>
                  <button class={button} onClick={() => $panel.set({ kind: "invoice" })}><Icon name="plus" class="size-4" />Issue invoice</button>
                </>} />

              <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Balance" icon="cash" tone={usageTone()} value={money.format(customer().balance)} progress={usage()}
                  hint={`${Math.round(usage() * 100)}% of the ${money.format(customer().creditLimit)} credit limit`} />
                <Stat label="Outstanding" icon="invoice" tone="brand" value={outstanding().length}
                  hint={`${money.format(outstanding().reduce((t, i) => t + i.amount - i.paid, 0))} to collect`} />
                <Stat label="Invoiced" icon="chart" tone="neutral" value={money.format(customer().invoiced)} hint={`${customer().invoices.length} invoice(s) in total`} />
                <Stat label="Paid" icon="check" tone="success" value={money.format(customer().paid)}
                  hint={customer().invoiced ? `${Math.round((customer().paid / customer().invoiced) * 100)}% of what was invoiced` : "Nothing invoiced yet"} />
              </div>

              <div class="grid gap-6 xl:grid-cols-3">
                <Card title="Invoices" subtitle="Newest due date first" class="xl:col-span-2" actions={<LiveDot on={invoicesLive()} />}>
                  <Show when={sorted().length} fallback={loaded() ? (
                    <Empty icon="invoice" title="No invoices yet">
                      <button class={`${button}${small} mt-3`} onClick={() => $panel.set({ kind: "invoice" })}>Issue the first invoice</button>
                    </Empty>
                  ) : <Skeleton rows={3} />}>
                    <Table head={["Invoice", "Due", "Collected", "Status", ""]}>
                      <For each={sorted()}>
                        {(invoice) => {
                          const open = () => invoice.status === "open" || invoice.status === "overdue";
                          return (
                            <tr class={clickRow} onClick={() => router.navigate(`/invoices/${invoice._id}`)}>
                              <td class={cell}>
                                <a href={`#/invoices/${invoice._id}`} class="font-mono text-xs font-semibold text-heading hover:text-fg-brand" onClick={(e) => e.stopPropagation()}>{shortId(invoice._id)}</a>
                                <p class="text-xs text-body">
                                  {money.format(invoice.amount)}
                                  <Show when={invoice.receipt}> · <span class="text-fg-success">receipt sent</span></Show>
                                  <Show when={invoice._id.includes("-period-")}> · subscription</Show>
                                </p>
                              </td>
                              <td class={cell}><Due date={invoice.dueDate} open={open()} /></td>
                              <td class={`${cell} w-44`}>
                                <div class="mb-1 flex justify-between text-xs tabular-nums">
                                  <span class="font-medium text-heading">{money.format(invoice.paid)}</span>
                                  <span>{Math.round((invoice.paid / invoice.amount) * 100)}%</span>
                                </div>
                                <Progress value={invoice.paid / invoice.amount} tone={invoice.status === "void" ? "neutral" : "success"} />
                              </td>
                              <td class={cell}><InvoiceBadge status={invoice.status} /></td>
                              <td class={`${cell} text-right whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                                <Show when={open()}>
                                  <div class="inline-flex gap-1.5">
                                    <button class={secondary + small} disabled={busy()} onClick={() => $panel.set({ kind: "pay", invoice })}>Pay</button>
                                    <button class={secondary + small} disabled={busy()} title="Pays what is left and waits for the receipt" onClick={() => void settle(invoice)}>Settle</button>
                                  </div>
                                </Show>
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </Table>
                  </Show>
                </Card>

                <div class="grid items-start content-start gap-6 md:grid-cols-2 xl:grid-cols-1">
                  <Card title="Subscriptions" actions={<button class={secondary + small} onClick={() => $panel.set({ kind: "subscription" })}><Icon name="plus" class="size-3.5" />New</button>}>
                    <Show when={(subs().data ?? []).length} fallback={subs().loading && !subs().data ? <Skeleton rows={1} /> : <Empty icon="repeat">{subs().error ?? "No subscriptions."}</Empty>}>
                      <ul class="divide-y divide-default">
                        <For each={subs().data}>
                          {(subscription) => (
                            <li class="flex items-start gap-3 px-4 py-3">
                              <span class={`grid size-9 shrink-0 place-items-center rounded-base ${subscription.status === "active" ? "bg-brand-softer text-fg-brand" : "bg-neutral-secondary-medium text-body"}`}><Icon name="repeat" class="size-4.5" /></span>
                              <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-2">
                                  <p class="text-sm font-semibold text-heading"><span class="capitalize">{subscription.plan}</span> plan</p>
                                  <Badge dot tone={subscription.status === "active" ? "success" : "neutral"}>{subscription.status === "active" ? "Active" : "Cancelled"}</Badge>
                                </div>
                                <p class="text-sm tabular-nums text-heading">{money.format(subscription.monthlyAmount)}<span class="text-body"> / month</span></p>
                                <p class="mt-0.5 text-xs text-body">
                                  {subscription.periods} period(s) billed
                                  {subscription.nextRenewal ? ` · renews ${date(subscription.nextRenewal)}` : ""}
                                  {subscription.cancelReason ? ` · “${subscription.cancelReason}”` : ""}
                                </p>
                                <div class="mt-1.5 flex gap-3 text-xs font-medium">
                                  <a href={`#/events/billing/subscription/${subscription._id}`} class="text-fg-brand hover:underline">Events</a>
                                  <Show when={subscription.status === "active"}>
                                    <button class="text-fg-danger hover:underline" onClick={() => $panel.set({ kind: "cancel", subscription })}>Cancel</button>
                                  </Show>
                                </div>
                              </div>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Card>
                  <Card title="Contacts" actions={<button class={secondary + small} onClick={() => $panel.set({ kind: "contact" })}><Icon name="plus" class="size-3.5" />Add</button>}>
                    <Show when={customer().contacts.length} fallback={<Empty icon="mail">No contacts yet.</Empty>}>
                      <ul class="divide-y divide-default">
                        <For each={customer().contacts}>
                          {(contact) => (
                            <li class="flex items-center gap-3 px-4 py-3">
                              <Avatar name={contact.name} />
                              <div class="min-w-0">
                                <p class="truncate text-sm font-medium text-heading">{contact.name}</p>
                                <a href={`mailto:${contact.email}`} class="block truncate text-xs text-body hover:text-fg-brand">{contact.email}</a>
                              </div>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Card>
                </div>
              </div>

              <Drawer open={!!panel()} title={titles[panel()?.kind ?? "invoice"]} subtitle={customer().name} onClose={close}>
                <Switch>
                  <Match when={panel()?.kind === "invoice"}>
                    <form onSubmit={issue} class="space-y-5">
                      <Field label="Amount (EUR)" for="invoice-amount">
                        <input id="invoice-amount" name="amount" type="number" step="0.01" min="0.01" required class={input} placeholder="0.00" />
                      </Field>
                      <Field label="Due date" for="invoice-due">
                        <input id="invoice-due" name="dueDate" type="date" required value={inDays(30)} class={input} />
                      </Field>
                      <Alert tone="brand">The accounts Saga charges it against the {money.format(customer().creditLimit - customer().balance)} of credit left; a refused charge voids the invoice.</Alert>
                      <button disabled={busy()} class={`${button} w-full`}>Issue invoice</button>
                    </form>
                  </Match>
                  <Match when={panel()?.kind === "subscription"}>
                    <form onSubmit={start} class="space-y-5">
                      <fieldset>
                        <legend class="mb-1.5 text-sm font-medium text-heading">Plan</legend>
                        <div class="grid grid-cols-2 gap-2">
                          <For each={["basic", "pro"]}>
                            {(plan, i) => (
                              <label class="cursor-pointer rounded-base border border-default p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-softer">
                                <input type="radio" name="plan" value={plan} checked={i() === 0} class="sr-only" />
                                <span class="block text-sm font-semibold capitalize text-heading">{plan}</span>
                                <span class="text-xs text-body">{plan === "basic" ? "Essentials" : "Everything"}</span>
                              </label>
                            )}
                          </For>
                        </div>
                      </fieldset>
                      <Field label="Monthly amount (EUR)" for="sub-amount">
                        <input id="sub-amount" name="monthlyAmount" type="number" step="0.01" min="0.01" required value="30" class={input} />
                      </Field>
                      <Field label="Starts on" for="sub-start" hint="The first month is billed at once; the renewals Saga bills each next one.">
                        <input id="sub-start" name="startsOn" type="date" required value={inDays(0)} class={input} />
                      </Field>
                      <button disabled={busy()} class={`${button} w-full`}>Start subscription</button>
                    </form>
                  </Match>
                  <Match when={panel()?.kind === "contact"}>
                    <form onSubmit={addContact} class="space-y-5">
                      <Field label="Name" for="contact-name"><input id="contact-name" name="name" required class={input} placeholder="Dana Accounts" /></Field>
                      <Field label="Email" for="contact-email"><input id="contact-email" name="email" type="email" required class={input} placeholder="accounts@example.com" /></Field>
                      <button disabled={busy()} class={`${button} w-full`}>Add contact</button>
                    </form>
                  </Match>
                  <Match when={panel()?.kind === "pay" && (panel() as { invoice: Invoice }).invoice}>
                    {(invoice) => (
                      <form onSubmit={pay(invoice())} class="space-y-5">
                        <div class="rounded-base border border-default bg-neutral-secondary-soft p-4">
                          <p class="text-xs text-body">Invoice {shortId(invoice()._id)} · due {date(invoice().dueDate)}</p>
                          <p class="mt-1 text-2xl font-bold tabular-nums text-heading">{money.format(invoice().amount - invoice().paid)}</p>
                          <p class="text-xs text-body">outstanding of {money.format(invoice().amount)}</p>
                        </div>
                        <Field label="Amount (EUR)" for="pay-amount">
                          <input id="pay-amount" name="amount" type="number" step="0.01" min="0.01" required value={invoice().amount - invoice().paid} class={input} />
                        </Field>
                        <Field label="Method" for="pay-method">
                          <select id="pay-method" name="method" class={input}><option value="bank-transfer">Bank transfer</option><option value="card">Card</option></select>
                        </Field>
                        <button disabled={busy()} class={`${button} w-full`}>Record payment</button>
                      </form>
                    )}
                  </Match>
                  <Match when={panel()?.kind === "cancel" && (panel() as { subscription: Subscription }).subscription}>
                    {(subscription) => (
                      <form onSubmit={cancel(subscription())} class="space-y-5">
                        <Alert>Cancelling stops renewals of the <span class="font-semibold capitalize">{subscription().plan}</span> plan. Only staff may cancel.</Alert>
                        <Field label="Reason" for="cancel-reason"><input id="cancel-reason" name="reason" required class={input} placeholder="Moving to another provider" /></Field>
                        <button disabled={busy()} class={`${danger} w-full`}>Cancel subscription</button>
                      </form>
                    )}
                  </Match>
                </Switch>
              </Drawer>
            </>
          );
        }}
      </Show>
    );
  };
});
