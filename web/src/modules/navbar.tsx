import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Show } from "solid-js";
import type { Session } from "../contracts.ts";
import { mount } from "../lib/module.ts";
import { Avatar, Field, Icon, button, input } from "../lib/ui.tsx";

const roles: { role: Session["role"]; text: string; hint: string }[] = [
  { role: "clerk", text: "Clerk", hint: "Customers, invoices, payments" },
  { role: "admin", text: "Admin", hint: "Also voids, reports and settings" },
];

/**
 * Top bar: opens the sidebar on small screens (a `sidebar.toggle` message, since the sidebar
 * is another module), searches invoices by debtor, and switches who the browser plays.
 */
export const navbar: jc.ModuleFactory = (sandbox) => ({
  sandbox,
  init(props?: { root: HTMLElement }) {
    const session = sandbox.getService("session");
    const router = sandbox.getService("router");
    const $open = atom(false);
    mount(sandbox, props?.root, () => {
      const current = useStore(session.$session);
      const open = useStore($open);
      const set = (patch: Partial<Session>) => session.update(patch);
      const search = (event: SubmitEvent) => {
        event.preventDefault();
        const q = String(new FormData(event.currentTarget as HTMLFormElement).get("q") ?? "").trim();
        router.navigate(q ? `/invoices?q=${encodeURIComponent(q)}` : "/invoices");
      };
      return (
        <nav class="fixed top-0 z-50 w-full border-b border-default bg-neutral-primary-soft/95 backdrop-blur">
          <div class="flex h-16 items-center justify-between gap-4 px-3 lg:px-5">
            <div class="flex items-center gap-2 sm:w-60">
              <button type="button" class="rounded-base p-2 text-body hover:bg-neutral-tertiary sm:hidden" aria-label="Open sidebar"
                onClick={() => sandbox.publishAsync({ type: "sidebar.toggle" })}>
                <Icon name="menu" />
              </button>
              <a href="#/" class="flex items-center gap-2.5">
                <span class="grid size-8 place-items-center rounded-base bg-brand text-white shadow-xs"><Icon name="bolt" class="size-4.5" /></span>
                <span class="text-base font-bold tracking-tight text-heading whitespace-nowrap">Billing<span class="text-fg-brand">CRM</span></span>
              </a>
            </div>
            <form role="search" class="hidden max-w-md flex-1 md:block" onSubmit={search}>
              <label class="relative block">
                <span class="sr-only">Search invoices by debtor</span>
                <Icon name="search" class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-body-subtle" />
                <input name="q" type="search" placeholder="Search invoices by debtor…" class={`${input} ps-9`} />
              </label>
            </form>
            <div class="relative">
              <button type="button" class="flex items-center gap-2.5 rounded-base py-1 ps-1 pe-2 hover:bg-neutral-tertiary" aria-haspopup="dialog" aria-expanded={open()} onClick={() => $open.set(!open())}>
                <Avatar name={current().user} />
                <span class="hidden text-left sm:block">
                  <span class="block text-sm font-semibold leading-tight text-heading">{current().user}</span>
                  <span class="block text-xs leading-tight text-body">{current().customerId ? "Customer portal" : roles.find((r) => r.role === current().role)!.text} · {current().tenant}</span>
                </span>
                <Icon name="down" class="hidden size-4 text-body sm:block" />
              </button>
              <Show when={open()}>
                <div class="fixed inset-0 z-40" onClick={() => $open.set(false)} />
                <form class="absolute right-0 z-50 mt-2 w-80 rounded-base border border-default bg-neutral-primary-soft shadow-xl" onSubmit={(e) => { e.preventDefault(); $open.set(false); }}>
                  <div class="border-b border-default px-4 py-3">
                    <p class="text-sm font-semibold text-heading">Acting as</p>
                    <p class="text-xs text-body">The example server trusts these headers instead of a token.</p>
                  </div>
                  <div class="space-y-4 p-4">
                    <fieldset>
                      <legend class="mb-1.5 text-sm font-medium text-heading">Role</legend>
                      <div class="grid grid-cols-2 gap-2">
                        <For each={roles}>
                          {(option) => (
                            <label class={`relative cursor-pointer rounded-base border p-2.5 ${current().role === option.role ? "border-brand bg-brand-softer" : "border-default hover:bg-neutral-secondary-soft"}`}>
                              <input type="radio" name="role" class="sr-only" checked={current().role === option.role} onChange={() => set({ role: option.role })} />
                              <span class="block text-sm font-semibold text-heading">{option.text}</span>
                              <span class="block text-xs text-body">{option.hint}</span>
                            </label>
                          )}
                        </For>
                      </div>
                    </fieldset>
                    <div class="grid grid-cols-2 gap-3">
                      <Field label="User" for="session-user">
                        <input id="session-user" class={input} value={current().user} onChange={(e) => set({ user: e.currentTarget.value || "web" })} />
                      </Field>
                      <Field label="Tenant" for="session-tenant">
                        <input id="session-tenant" class={input} value={current().tenant} onChange={(e) => set({ tenant: e.currentTarget.value || "demo" })} />
                      </Field>
                    </div>
                    <Field label="Customer portal" for="session-customer" hint="A customer id limits invoices and subscriptions to that customer. Empty means staff.">
                      <input id="session-customer" class={input} placeholder="Customer id" value={current().customerId ?? ""}
                        onChange={(e) => set({ customerId: e.currentTarget.value.trim() || undefined })} />
                    </Field>
                  </div>
                  <div class="border-t border-default p-3"><button class={`${button} w-full`}>Done</button></div>
                </form>
              </Show>
            </div>
          </div>
        </nav>
      );
    });
  },
  destroy() {},
});
