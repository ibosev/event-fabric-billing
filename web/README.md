# Billing CRM

The frontend of the billing server: a CRM where staff register Customers, issue Invoices, take payments, run Subscriptions, follow each Invoice's dunning, read revenue reports, keep tenant settings and inspect the Event log. It talks only to the server's Gateway, through `/api`.

- **justcore** runs every part as a module with its own sandbox, following Zakas's *Scalable JavaScript Application Architecture*. Modules know only their sandbox; they never import each other.
- **SolidJS** renders each module into the element the shell gives it.
- **nanostores** holds all state: services expose stores, each module keeps its own, and Solid reads them through `@nanostores/solid`.
- **Flowbite** (default theme, Tailwind CSS v4) gives the CRM look: its sidebar-and-navbar layout, cards, tables, badges, drawers and toasts as plain markup. Flowbite's JavaScript is not loaded.

## Run

The server must be up (see [`../server`](../server/README.md)); justcore must be built in `../../justcore`.

```sh
npm install
npm run dev     # http://localhost:5173; /api goes to API_URL, default http://127.0.0.1:3300
npm test        # routing, Position ordering, error messages (node --test)
npm run check   # TypeScript
npm run build   # static files in dist/
```

`API_URL=http://127.0.0.1:3000 npm run dev` uses a server started with `npm start` instead of the Docker load balancer.

## How it fits together

| File | Role |
| --- | --- |
| `src/main.ts` | The shell: one `Core`, the `services` extension, session-wide modules (`navbar`, `sidebar`, `toasts`) and one page module in `#page`, chosen by the URL hash. Every route and every change of caller starts a fresh page instance, so stopping it aborts its requests and live feeds through the sandbox `signal`. |
| `src/contracts.ts` | The only thing modules share: server document types, the services' interfaces (typed `getService`), and the messages. |
| `src/services/` | A justcore extension that puts `session`, `api`, `router` and `live` into the core's service locator. |
| `src/lib/module.ts` | `mount` (Solid view tied to the sandbox), `page` (a page module), `actions` (`$busy` and error toasts for Commands), `resource` (a request as a store). |
| `src/lib/ui.tsx` | Flowbite components: buttons, inputs, cards, tables, badges, drawer, stats, icons. |
| `src/modules/` | One file per module. |

Messages on the bus:

| Message | Sent by | Handled by |
| --- | --- | --- |
| `notify` `{ tone, text }` | any module (a Command's result or Rejection) | `toasts` |
| `sidebar.toggle` | `navbar` (menu button on small screens) | `sidebar` |

Shared state is the URL (`router.$route`) and the caller (`session.$session`).

| Page | Route | Server features |
| --- | --- | --- |
| Dashboard | `#/` | Invoice queries by status, revenue and plans (admin), newest Customers |
| Customers | `#/customers` | cursor pages, `/customers/live` change hints with `minPosition`, 503 retry while catching up, registration |
| Customer | `#/customers/:id` | live Invoices, payments with `Idempotency-Key`, settle via `awaitCorrelated`, Subscriptions (decorated Aggregate), contacts |
| Invoices | `#/invoices` | status filter, `elemMatch` on payment method, text search `q` |
| Invoice | `#/invoices/:id` | payments, receipt, dunning Workflow (`queryWorkflow`), promise-to-pay Signal, admin-only void |
| Reports | `#/reports` | `reporting` Readmodels (admin) |
| Settings | `#/settings` | ordinary CRUD per tenant, admin writes |
| Event log | `#/events[/:context/:aggregate/:id]` | the devtools plugin: live Event log, Stream time machine, Correlation trace; the audit plugin's model |

## Who you are

The server trusts headers instead of a token, so the navbar's menu sets them: `X-User`, `X-Role` (`clerk` or `admin`), `X-Tenant`, and `X-Customer-Id` for the customer portal, where the Access map filters Invoices and Subscriptions to that Customer. The choice is remembered in the browser.

`EventSource` cannot send headers, so live feeds run as the default caller; they only carry change hints, and every document is re-read over HTTP with the caller's headers.
