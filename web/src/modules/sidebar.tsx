import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For } from "solid-js";
import { mount } from "../lib/module.ts";
import { Icon, type IconName } from "../lib/ui.tsx";

const sections: { title: string; items: { href: string; module: string; text: string; icon: IconName }[] }[] = [
  {
    title: "Workspace",
    items: [
      { href: "#/", module: "dashboard", text: "Dashboard", icon: "home" },
      { href: "#/customers", module: "customer", text: "Customers", icon: "users" },
      { href: "#/invoices", module: "invoice", text: "Invoices", icon: "invoice" },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "#/reports", module: "reports", text: "Reports", icon: "chart" },
      { href: "#/settings", module: "settings", text: "Settings", icon: "settings" },
    ],
  },
  { title: "Developer", items: [{ href: "#/events", module: "events", text: "Event log", icon: "code" }] },
];

/** Navigation; highlights the routed page and slides in on small screens on `sidebar.toggle`. */
export const sidebar: jc.ModuleFactory = (sandbox) => {
  const $open = atom(false);
  return {
    sandbox,
    init(props?: { root: HTMLElement }) {
      const router = sandbox.getService("router");
      // Navigating closes the slide-in sidebar.
      sandbox.signal.addEventListener("abort", router.$route.listen(() => $open.set(false)), { once: true });
      mount(sandbox, props?.root, () => {
        const route = useStore(router.$route);
        const open = useStore($open);
        // `customer` and `customers` both light up Customers.
        const active = (module: string) => route().module.startsWith(module);
        return (
          <>
            <div class={`fixed inset-0 z-30 bg-dark-backdrop/50 sm:hidden ${open() ? "" : "hidden"}`} onClick={() => $open.set(false)} />
            <aside aria-label="Sidebar"
              class={`fixed top-0 left-0 z-40 flex h-screen w-64 flex-col border-e border-default bg-neutral-primary-soft pt-16 transition-transform sm:translate-x-0 ${open() ? "translate-x-0" : "-translate-x-full"}`}>
              <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-5">
                <For each={sections}>
                  {(section) => (
                    <div>
                      <p class="mb-2 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-body-subtle">{section.title}</p>
                      <ul class="space-y-0.5">
                        <For each={section.items}>
                          {(item) => (
                            <li>
                              <a href={item.href} aria-current={active(item.module) ? "page" : undefined}
                                class={`group flex items-center gap-3 rounded-base px-2.5 py-2 text-sm font-medium transition-colors ${active(item.module) ? "bg-brand-softer text-fg-brand-strong" : "text-body hover:bg-neutral-secondary-medium hover:text-heading"}`}>
                                <Icon name={item.icon} class={`size-5 ${active(item.module) ? "text-fg-brand" : "text-body-subtle group-hover:text-heading"}`} />
                                {item.text}
                              </a>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              </nav>
              <div class="m-3 rounded-base border border-default bg-neutral-secondary-soft p-3">
                <p class="text-xs font-semibold text-heading">EventFabric example</p>
                <p class="mt-0.5 text-xs text-body">justcore modules · SolidJS · nanostores</p>
              </div>
            </aside>
          </>
        );
      });
    },
    moduleWillSubscribe: () => ["sidebar.toggle"],
    moduleDidReceiveMessage: () => $open.set(!$open.get()),
    destroy() {},
  };
};
