/**
 * The shell. One justcore core runs every part of the CRM as a module with its own sandbox:
 * the navbar, sidebar and toasts for the whole session, and one page module at a time in
 * `#page`, chosen by the URL hash. Modules reach the server only through sandbox services
 * (`services/`), talk to each other only through messages, and keep their state in nanostores.
 */
import { Core } from "justcore";
import type { NotifyMessage, Route } from "./contracts.ts";
import { customer } from "./modules/customer.tsx";
import { customers } from "./modules/customers.tsx";
import { dashboard } from "./modules/dashboard.tsx";
import { events } from "./modules/events.tsx";
import { invoice } from "./modules/invoice.tsx";
import { invoices } from "./modules/invoices.tsx";
import { navbar } from "./modules/navbar.tsx";
import { notFound } from "./modules/not-found.tsx";
import { reports } from "./modules/reports.tsx";
import { settings } from "./modules/settings.tsx";
import { sidebar } from "./modules/sidebar.tsx";
import { toasts } from "./modules/toasts.tsx";
import { services } from "./services/index.ts";
import "./app.css";

const core = new Core();
core.use([services]);

const region = (id: string) => document.getElementById(id)!;
const pages: Record<string, jc.ModuleFactory> = {
  dashboard, customers, customer, invoices, invoice, reports, settings, events, "not-found": notFound,
};

core.init(() => {
  core.addModule("navbar", navbar);
  core.addModule("sidebar", sidebar);
  core.addModule("toasts", toasts);
  for (const [id, factory] of Object.entries(pages)) core.addModule(id, factory);

  void core.startModule("toasts", { props: { root: region("toasts") } });
  void core.startModule("navbar", { props: { root: region("navbar") } });
  void core.startModule("sidebar", { props: { root: region("sidebar") } });

  // A fresh page instance per route and per caller: stopping one aborts its requests and feeds.
  let shown: string | undefined;
  let queue = Promise.resolve();
  const show = (route: Route) =>
    (queue = queue.then(async () => {
      if (shown) await core.stopModule(shown);
      shown = route.module;
      await core.startModule(route.module, { props: { root: region("page"), params: route.params } }).catch((error: unknown) => {
        shown = undefined;
        core.publishAsync<NotifyMessage>({ type: "notify", tone: "error", text: `The ${route.module} page failed: ${error}` });
      });
    }));
  const router = core.serviceLocator.getService("router");
  router.$route.subscribe(show);
  core.serviceLocator.getService("session").$session.listen(() => show(router.$route.get()));
});
