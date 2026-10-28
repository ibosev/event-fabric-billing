# Billing server

A small EventFabric Application in TypeScript, shaped like a production one and built to show every part of the framework. Everything runs in Docker on official images; you need nothing installed but Docker. Each file opens with a block comment that explains what it demonstrates.

| Piece                                              | What it shows                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Aggregate `billing.invoice` (`src/domain`)         | Steps and Preconditions, a Rule with `locals`, `command.now`, a Schema version 2 Event with an Upcaster, a retired Event, `eventEnricher`, `idGenerator` |
| Aggregate `billing.customer` (`src/domain`)        | An Aggregate-wide Rule; a credit limit refused by recording `chargeRefused`, not by a Rejection                |
| Aggregate `billing.subscription` (`src/domain/subscription.ts`) | **Decorated** (`event-fabric/decorators`, Axon style): Command and Event classes, `@Aggregate` with `idGenerator` and `eventEnricher`, `@CommandHandler` with `before` Steps, `@EventSourcingHandler`, an idempotent delayed `renew` |
| Readmodel group `billing` (`src/readmodels`)       | `invoices` (child table, `DateTime`, optional field, compound and text indexes) and `customers`                 |
| Readmodel group `reporting` (`src/readmodels`)     | Revenue per day: a custom `identity`, `initialState`, a `"x-store": "json"` field, Readmodel helpers through `ReadmodelApp`, `rebuildVersion` |
| Readmodels `billing.subscriptions`, `reporting.plans` (`src/readmodels/subscriptions.ts`) | **Decorated**: `@Readmodel` classes listed in object groups, `@EventHandler` with `before`, `associationProperty: "plan"` as the Identity, `initialState` |
| Saga `accounts` (`src/sagas`)                      | Per-Invoice state, `identity` for a Customer Event, compensation (voids an Invoice whose charge was refused), `app.tell`, `destroy()` |
| Invoice Schedule `overdue` (`src/domain/invoice.ts`) | `app.schedule` commits with issue/due-date Events; full payment or voiding cancels it. Open Invoices can change their due date. |
| Saga `receipts` (`src/sagas`)                      | A cross-group read (`reads`), `app.queue` of a typed Message with `replyTo`; the Worker's reply (`ReplyOf`) confirms the receipt or keeps the failure |
| Saga `renewals` (`src/sagas/renewals.ts`)          | **Decorated**: `@Saga`, `@SagaEventHandler`; issues Invoices on the `aggregate()` Invoice, reacts to the Customer's `chargeRefused` through `eventOf`, an `associationProperty` function returning `null`, a delayed Command, `destroy()` |
| Worker `receipts` (`src/workers`)                  | `concurrency`, `timeout`, `retry`, `permanent`, `ctx.services`, `ctx.signal`, `ctx.idempotencyKey`; its return value is the reply |
| Workflow `dunning` (`src/workflows/dunning.ts`)    | One function that waits, per Invoice: `waitFor` the payment until it falls due, `ask` the `reminders` Worker, wait 14 more days (a `promised` Signal extends it once), then `tell` `markOverdue` and cancel the Subscription. `ctx.read`, `ctx.id`, `set` for `queryWorkflow`'s `{ stage, remindersSent }` |
| Worker `reminders` (`src/workers/reminders.ts`)    | Answers the dunning Workflow's `ctx.ask`; its return value is the reply |
| Gateway `api` (`src/gateway`)                      | Middleware, Request context, `commandMetadata`, Access-map functions and filters, `Idempotency-Key`, `awaitCorrelated`, typed queries with `q` and `elemMatch`, SSE |
| Settings (`src/settings`, `database/settings.sql`) | Ordinary HTTP CRUD through routes, controllers, a service, a repository and a separate Postgres table; request/response DTOs and a stored model |
| Plugin `audit` (`src/plugins`)                     | `start`, `gateway` and `shutdown` hooks; `subscribeEvents`                                                     |
| Plugin `devtools` (`src/plugins`)                  | Read-only Event log routes for the web client's debugging tools; loaded only with `DEVTOOLS=1`                 |
| Task `statement` (`src/tasks`)                     | A CLI script against the live Application, streaming Readmodel documents and reading Streams                    |
| `src/services/mailer.ts`                           | An Application service handed to Workers, Steps, Reactions, Tasks and plugins                                   |
| `src/services/setup.ts`                            | `setupServices` owns the settings pool, constructs its repository and service, and registers cleanup            |
| `src/services/readmodel.ts`                        | `readmodelServices`: deterministic helpers Readmodel Reactions get instead of the services, live and on rebuild |
| `src/billing.test.ts`                              | In-process tests on `event-fabric/testing`, with a controlled clock and 2 Partitions per group                  |
| `src/dunning.test.ts`                              | The dunning Workflow on `processFixture` with a virtual clock: paid in time, reminded then overdue, a promise to pay, a voided Invoice |
| `src/dunning-deployments.ts`                       | The dunning Workflow in a whole Application across deployments: to the end, a restart mid-wait, and a careless deploy that drifts one instance |
| `src/dunning-stores.test.ts`                       | Runs `dunning-deployments.ts` on the in-memory store; `npm run test:postgres` runs it on Postgres |
| `src/operations.test.ts`                           | Successive deployments on one store: rejected Saga Commands dead-lettered, Worker Idempotency keys, retiring a dropped Saga group, `only` by Context |
| `src/event-fabric.config.ts`                       | Named `config` export the CLI loads: stores, transport, Metadata schema and indexes, services, Readmodel helpers, plugins |
| `eslint.config.js`                                 | EventFabric's lint rules on the compiled output (`npm run lint`, part of `npm run check`)                      |
| `src/types.config.ts`                              | Declarations only, for `event-fabric types`; needs no Postgres or RabbitMQ                                     |

## Run

```sh
cd server
docker compose up -d --build --wait   # Billing/settings Postgres, RabbitMQ, migrations, 3 app replicas, load balancer
npm run smoke:docker                  # end-to-end check through HTTP, in its own stack
docker compose down -v                # stop and delete data
```

`smoke:docker` starts a second copy of the stack under the project `event-fabric-billing-smoke`, without host ports (`compose.smoke.yml`), runs `smoke` against it and deletes it with its volumes, so the dev stack's Event log and Readmodels keep only what you did yourself. `docker compose run --rm smoke` still runs the same test against the dev stack, and its data stays there.

The image builds EventFabric from the sibling `../../event-fabric` checkout (the `event-fabric` build context in `compose.yml`), packs it like a release and installs it into the server; the build type-checks and runs `npm test`. `migrate` runs once before the app starts, since startup never migrates framework tables.

The API listens on `http://127.0.0.1:3300` (set `API_PORT` to change it), behind an nginx load balancer (`nginx.conf`) that round-robins over three identical `app` replicas (`REPLICAS` to change). Every response names its replica in `X-Instance`. The RabbitMQ console is on `http://127.0.0.1:15672` (`billing` / `billing`). Billing Postgres is on `127.0.0.1:55432`; settings Postgres is on `127.0.0.1:55433` (`settings` / `settings`, database `billing_settings`).

```sh
curl -s -X POST localhost:3300/customers -H 'Content-Type: application/json' \
  -d '{"name":"Example Debtor Ltd"}'
curl -s -X POST localhost:3300/invoices -H 'Content-Type: application/json' \
  -d '{"customerId":"<customer id>","debtor":"Example Debtor Ltd","amount":100,"dueDate":"2026-12-31"}'
# A retry with the same Idempotency-Key pays once and answers EventFabric-Duplicate: true.
curl -si -X POST localhost:3300/invoices/<id>/payments -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pay-1' -d '{"amount":40,"method":"card"}'
# Pays the rest and waits for the receipt, four hops away (Saga, Worker, reply, Command).
curl -s -X POST localhost:3300/invoices/<id>/settle -H 'Content-Type: application/json' -d '{}'
# The dunning Workflow of an Invoice (staff only): {status, state: {stage, remindersSent}, result}.
curl -s localhost:3300/invoices/<id>/dunning
# A debtor's promise to pay by a date: a Signal that extends the dunning's last wait once.
curl -s -X POST localhost:3300/invoices/<id>/promise -H 'Content-Type: application/json' -d '{"until":"2026-12-31"}'
docker compose exec app node node_modules/event-fabric/dist/cli/main.js workflows list --config dist/event-fabric.config.js --status running
curl -s -X POST localhost:3300/invoices/<id>/void -H 'Content-Type: application/json' \
  -H 'X-Role: admin' -d '{"reason":"duplicate"}'
curl -s 'localhost:3300/invoices?status=settled'
curl -s 'localhost:3300/invoices?q=example'
curl -s localhost:3300/customers                         # {items: [latest 20], nextCursor}
curl -s 'localhost:3300/customers?before=<nextCursor>'   # next 20 older registrations
curl -s localhost:3300/customers/<customer id>
curl -sN localhost:3300/customers/<customer id>/invoices/live   # Server-Sent Events
curl -s -H 'X-Role: admin' localhost:3300/reports/revenue/$(date -u +%F)
# A decorated Aggregate: bills the first month at once; the renewals Saga issues its Invoice.
curl -s -X POST localhost:3300/subscriptions -H 'Content-Type: application/json' \
  -d '{"customerId":"<customer id>","debtor":"Example Debtor Ltd","plan":"pro","monthlyAmount":30,"startsOn":"'$(date -u +%F)'"}'
curl -s localhost:3300/invoices/<subscription id>-period-1
curl -s -X POST localhost:3300/subscriptions/<subscription id>/cancel -H 'Content-Type: application/json' -d '{"reason":"moving"}'
curl -s -H 'X-Role: admin' localhost:3300/reports/plans/pro
curl -s localhost:3300/ops/model                                 # added by the audit plugin
```

The Gateway trusts the `X-Tenant`, `X-User`, `X-Role` and `X-Customer-Id` headers so you can play each caller; a real Application verifies a token in `context(req)`.

## Ordinary settings

Settings demonstrate the familiar HTTP route → controller → service → repository → database flow. They are mutable key/value rows; they have no relation to Invoice calculations.

| File | Responsibility |
| ---- | -------------- |
| [`src/settings/routes.ts`](src/settings/routes.ts) | The Gateway plugin registers Express routes and supplies `ctx.services.settings` to the controller. |
| [`src/settings/controller.ts`](src/settings/controller.ts) | Validates request DTOs, reads the tenant/role from `handle(req).ctx`, checks administrator writes, and sends response DTOs and HTTP statuses. |
| [`src/settings/service.ts`](src/settings/service.ts) | Performs the setting operations and reports duplicate or missing settings. |
| [`src/settings/repository.ts`](src/settings/repository.ts) | Uses parameterized SQL, with tenant ownership in every query. |
| [`src/settings/dto.ts`](src/settings/dto.ts) | Create `{key, value}`, update `{value}`, and response `{key, value}` contracts. Unknown input fields are rejected. |
| [`src/settings/model.ts`](src/settings/model.ts), [`database/settings.sql`](database/settings.sql) | The stored model includes `tenant`; SQL defines the table and its `(tenant, key)` primary key. |

[`setupServices`](src/services/setup.ts) creates a five-connection pool, registers its disposal, and injects the repository into the settings service. The pool is ready before the Gateway plugin runs and closes with the Application. Each replica connects to the same settings database. Docker's `settings-postgres` initializes the table from the plain SQL file on an empty volume; Application startup performs no DDL, and there is no seed data.

Keys start with a lowercase letter and contain up to 64 letters, digits, dots, underscores or hyphens (`invoicePrefix` and `invoice.footer` are valid). Keys are case-sensitive and unique within a tenant. Values are strings of up to 4096 characters, including empty strings; NUL characters are rejected. The small settings list is unpaginated and sorted by key. Clerks can read; administrators can write. These plain routes enforce access explicitly because the EventFabric Access map applies to Commands and Readmodels.

```sh
curl -si -X POST localhost:3300/settings \
  -H 'Content-Type: application/json' -H 'X-Tenant: demo' -H 'X-Role: admin' \
  -d '{"key":"invoicePrefix","value":"INV"}'
# 201, Location: /settings/invoicePrefix, {"key":"invoicePrefix","value":"INV"}
curl -s localhost:3300/settings -H 'X-Tenant: demo'
curl -s localhost:3300/settings/invoicePrefix -H 'X-Tenant: demo'
curl -s -X PUT localhost:3300/settings/invoicePrefix \
  -H 'Content-Type: application/json' -H 'X-Tenant: demo' -H 'X-Role: admin' \
  -d '{"value":"BILL"}'
curl -i -X DELETE localhost:3300/settings/invoicePrefix \
  -H 'X-Tenant: demo' -H 'X-Role: admin'
# 204, no body; later GET returns 404.
```

Each successful write has committed before its response. Invalid input returns 400, forbidden writes 403, missing or other-tenant keys 404, and duplicate keys 409. Unexpected failures use the Gateway's sanitized 500 response. Settings send no Commands and create no Events, Outbox entries or Readmodel updates. Reads are immediate and need no Position; the Command `Idempotency-Key` behavior does not apply.

## Web client

The CRM in [`../web`](../web/README.md) uses every Gateway route. Customer routes live directly in [`src/gateway/api.ts`](src/gateway/api.ts). `GET /customers` returns `{items, nextCursor}`; pass the cursor as `?before=` to read older registrations. The Gateway uses registration Event Positions for stable ordering, reads 21 registration Events to detect a next page, and fetches only the 20 selected Customer Readmodels through the scoped handle. `GET /customers/:id/subscriptions` lists one Customer's Subscriptions over the `customerId` index.

The Customer feed uses `initialSize: 0`: its `snapshot` is empty, then the browser fetches its current page over HTTP. A `changed` hint refreshes that page with `?minPosition=`; reconnecting refreshes it too. The Invoice feed opens with its Customer's Invoice documents, then the client re-reads changed documents. Try an Invoice above the Customer's credit limit: the `accounts` Saga voids it, and the page shows this without a reload.

The `devtools` plugin (`src/plugins/devtools.ts`) serves the web client's Event log; the config loads it only when `DEVTOOLS=1` (set in `compose.yml`). Its routes bypass the Access map and expose every Event, so keep it out of production.

## Scale out: a chained import

`src/scenario.ts` plays a third-party provider importing history through the load balancer. Ids are EventFabric's, so each step waits for the id the previous one returned. Per Customer, it registers the Customer (slow on purpose: a registry check takes `REGISTRY_DELAY_MS`, 1500 ms), then adds 3 contacts and issues 2 Invoices with the returned id. It then sends 4 payments at once to the first Invoice, and a void racing a payment to the second. 20 Customers run at once. A request with an unknown outcome is resent under the same Idempotency-Key. Afterwards the scenario waits for the Readmodels to settle and checks every Customer's account against its Invoices.

```sh
docker compose run --rm --no-deps scenario
CUSTOMERS=60 docker compose run --rm --no-deps scenario
```

What it shows, measured on 2026-10-16:

- **Every account agrees with its Invoices**: 60 Customers, 720 requests, 21 s, nothing resent. The 4th payment is refused as `already-settled`, and a void racing a payment ends as `voided` or `has-payments`.
- **An Invoice needs an existing Customer.** `issue` checks the Customer's Stream in the Event store and refuses an unknown one with `unknown-customer` (422). An earlier version let providers choose ids and send everything shuffled. Then Invoices arrived before their Customers, the `accounts` Saga's charges were dead-lettered, and up to 33 of 60 accounts disagreed.
- **Creations run in parallel.** A `register` sent without an id is routed by its Command id. An earlier version sent every registration to one Partition, so they ran one at a time (36 s for 20 Customers, 14 timed out and were resent).
- **Scaling**: with classic queues, one replica was the active handler of all 128 Command Partitions. Since ADR-0015 the Command queues are quorum queues, and each replica subscribes with its own priority per queue, so the Partitions spread (measured 48/39/41) and move to the others within seconds when a replica stops. Stopping two of five replicas mid-import lost nothing. Readmodel groups and Sagas are shared out across the replicas, and `billing` and `accounts` run as 4 Partitions each (ADR-0016).

Watch the spread with `docker compose exec rabbitmq rabbitmqctl list_consumers queue_name channel_pid active`, or scale with `docker compose up -d --no-recreate --scale app=5 app` (then `docker compose restart lb`, since nginx resolves the replicas at startup).

## Throughput

`src/load.ts` runs `CONCURRENCY` clients (50) for `DURATION_S` (30 s), each looping register → issue → 2 payments, and reports requests per second and latency per kind. Start the app with `REGISTRY_DELAY_MS=0` so registration doesn't dominate:

```sh
REGISTRY_DELAY_MS=0 docker compose up -d --build --wait
CONCURRENCY=50 docker compose run --rm --no-deps load
```

Every container has a CPU and memory limit (`compose.yml` header; `APP_CPUS`, `POSTGRES_CPUS`, `RABBITMQ_CPUS`, `LOAD_CPUS` and the `*_MEMORY` variables change them), so a run compares replica counts rather than the laptop's spare cores. The numbers below ran without limits; don't compare them with capped runs.

`PARTITIONS` (default 1; see the README's Operations section) splits the `billing` Readmodel group and the `accounts` and `receipts` Sagas into Partitions spread over the replicas (ADR-0016). Measured on 2026-10-16 over 3 replicas:

| Clients | 1 Partition | 4 Partitions |
| ------- | ----------- | ------------ |
| 50      | 199 req/s, p50 246 ms | 192–206 req/s, p50 216–246 ms |
| 150     | 130 req/s, p50 1.2 s  | 286 req/s, p50 488 ms |

Every event-sourced write route waits for the `billing` group (`respondWith`). With 4 Partitions its worst lag fell from 462 to 153 Events.

With the container limits, 4 Partitions and 150 clients for 5 minutes (2026-10-17): 631 req/s, p50 230 ms, p99 404 ms, every Consumer group Partition within about 500 Events of the head, and Postgres at its 4-CPU limit. With the Event store's pool at pg's default of 10 (`PG_POOL_MAX=10`), whichever Saga Partitions shared a replica with the Outbox dispatcher fell over 100,000 Events behind while that replica had CPU to spare. The example therefore defaults `PG_POOL_MAX` to 20. Even at 20, the single-Partition `receipts` Saga fell over 100,000 Events behind whenever placement put it on the Outbox's replica. Each of its Reactions reads an Invoice document and its Saga state, about 6 ms, so one Partition handles about 150 settled Invoices/s, the rate this load produces. It therefore runs with `PARTITIONS` too: with three of its four Partitions on the Outbox's replica, every one stayed within 452 Events of the head. The import scenario stays consistent with 4 Partitions, and also when the replicas switch from 1 to 4 Partitions in the middle of a 200-Customer import.

## Operate

The replicas start from `src/main.ts` (`node dist/main.js`, `npm start` on the host), which builds the Application from `src/event-fabric.config.ts` and runs it until stopped. The CLI runs inside the image:

```sh
run() { docker compose run --rm --no-deps app node_modules/event-fabric/dist/cli/main.js "$@" --config dist/event-fabric.config.js; }
run migrate --dry-run                    # prints the SQL still to apply (nothing when current), changes nothing
run consumers status                     # Leases, Checkpoints and lag; `undeclared` marks a dropped Saga group
run consumers retry <group>              # resumes a halted group
run consumers retire <saga group>        # deletes a Saga group no replica declares (asks first)
run dead-letters list                    # e.g. outbox-rejected Commands with their Rejection
run dead-letters replay <id>             # re-sends one once the data is fixed
run rebuild reporting                    # whole group, swapped in when caught up
run rebuild reporting --swap manual      # build now, then `run rebuild --swap reporting` to swap
PARTITIONS=4 APP_CPUS=4 run rebuild billing   # folds each Partition in its own worker thread
```

The Sagas and `dunning` declare no `from`, so each starts at `now` when first deployed: deploying `dunning` onto a running system starts no instance for Invoices issued before it. To run one over the history instead, retire its group and deploy it again with `from: "beginning"`. `src/operations.test.ts` deploys `accounts` and `receipts` after Invoices exist, so it sets `from: "beginning"` for them.

```sh
docker compose run --rm --no-deps app node_modules/event-fabric/dist/cli/main.js task dist/tasks/statement.js \
  --config dist/event-fabric.config.js -- <customer id>   # Task arguments follow `--`
```

`BILLING_STORE=mongo` keeps the `billing` Readmodel group in the `mongo` service (a one-member replica set), while the Event log, the other groups and the Sagas stay in Postgres. To move the group, build it in Mongo first, then switch the replicas. They continue from the swapped generation's Checkpoint:

```sh
BILLING_STORE=mongo run rebuild billing --swap manual   # 318–340 s over 8.6M Events at 1 CPU (2026-10-20)
BILLING_STORE=mongo run rebuild --swap billing
BILLING_STORE=mongo docker compose up -d --wait app
```

The group's documents live in the `billing-billing-readmodels` database, as `invoices_<tag>`, `customers_<tag>` and `subscriptions_<tag>`, where `<tag>` begins the generation's id. A rebuild's shadow sits next to them under its own tag until the swap, which drops the previous generation.

Every instance must use the same store, including a host `npm start`, which reads `BILLING_STORE` and `MONGO_URL` (`127.0.0.1:57017` with `directConnection=true`) from `.env`, as compose does. An instance on another store than the rest logs `Instances run this Readmodel group on different stores`, takes none of the `billing` Partitions, and `run consumers status` shows the split. Measured on 2026-10-20 with a fifth host instance left on Postgres: it took nothing and the smoke test passed. Without that check, such an instance would write its Partition to Postgres, and `respondWith` requests on that Partition would time out.

`node dist/main.js --only gateway:api` starts an HTTP-only replica; `--only readmodels:reporting` one that only builds that group; `--only commands:billing/billing` one that handles only the `billing` Context's Commands (an unknown Context is refused at start).

Changing the Partition count of running replicas hands over at one Position, with nothing lost: start the import scenario (`CUSTOMERS=400` runs long enough), then `PARTITIONS=4 docker compose up -d --no-deps --wait app` and `docker compose restart lb` while it runs. Requests caught by a stopping replica come back `unknown` and are resent under their Idempotency-Key. Compose also reads `PARTITIONS` from a local `.env`; `up` recreates the replicas only when the value changes. Each replica logs its Lease owner as `instance` when it starts consumers: `docker compose logs --no-log-prefix app | grep '"instance"'`; `consumers status` shows which instance holds each group.

`LOG_LEVEL=debug docker compose up -d` adds EventFabric's 10 s diagnostic summaries (README Operations). The `audit` plugin already logs every Event at `info`; EventFabric's own records carry a `component` field:

```sh
docker compose logs --no-log-prefix app | grep '"component"'
```

## Types

Every payload is a TypeBox schema: the same value is the TypeScript type and the JSON Schema checked at runtime. `aggregate(...)` types `invoice.apply.<event>(payload)`, `get`/`set` and every handler from those schemas, with no type arguments. `src/domain/index.ts` collects the Aggregates with `defineDomain`, and other files use that `domain`:

- Readmodels and Sagas key their Reactions by `domain.billing.invoice.<event>`, typed with `Reactions<EventsOf<typeof domain>, ...>`, and Identities with `Identities<EventsOf<typeof domain>>`;
- the Gateway and the Sagas send `domain.billing.invoice.<command>(id, payload)`;
- the receipts Saga queues the `sendReceipt` Message handle, which the Worker handles.

A misspelled Event, an unknown Command or a wrong payload is a compile error on the line that has it.

The Gateway's Access map and Readmodel routes, `app.getDomain()` and `app.getReadmodels()` name things as strings. Those are checked against `src/event-fabric.generated.d.ts`: `npm run types` regenerates it (commit it), and `npm run check` type-checks and fails on a stale file.

## Run the server locally

Build EventFabric in its sibling checkout (`cd ../../event-fabric && npm ci && npm run build`; `package.json` links it as `file:../../event-fabric`), then set up the server once from this directory:

```sh
cp .env.example .env # only when you do not already have a local .env
docker compose up -d --wait postgres settings-postgres rabbitmq
npm install && npm run build && npm test
npm run migrate
```

After setup, with those services running, start the server with `npm start`. It listens on `http://127.0.0.1:3000`; the Docker load balancer uses port 3300. Rebuild with `npm run build` after changing TypeScript.

`npm start` and `npm run migrate` load the gitignored `.env` through Node's built-in `--env-file-if-exists` option. Shell environment variables take precedence, and the file is optional for environments that supply their own values. `.env.example` contains the local Compose credentials and ports, including AMQP on 5672. The web client proxies to the Docker load balancer on 3300 unless its own `API_URL` says otherwise (`API_URL=http://127.0.0.1:3000 npm run dev` for this local server). When joining existing replicas, set `PARTITIONS` to their current value. With OrbStack, an existing broker can also be reached at `event-fabric-billing-rabbitmq-1.orb.local:5672` without recreating it to publish the port.

For settings on a locally managed Postgres instance instead, create an empty database and apply the same table definition:

```sh
createdb billing_settings
export SETTINGS_DATABASE_URL=postgres://localhost/billing_settings
psql "$SETTINGS_DATABASE_URL" -f database/settings.sql
```

`npm test` remains database-free. The focused HTTP/Postgres check needs a disposable database and creates the table from that same SQL file: `SETTINGS_TEST_DATABASE_URL=postgres://user:password@localhost/disposable npm run test:settings`. It covers CRUD, validation, access, tenant isolation, concurrent duplicate creation, restart persistence and no Event/Outbox effects. The dunning scenario of `src/dunning-deployments.ts` runs on Postgres with `npm run test:postgres` (`src/dunning-postgres.integration.ts`), in a schema it creates and drops; it uses the compose Postgres unless `DUNNING_TEST_DATABASE_URL` names another.

## Where each feature shows

What EventFabric brings, and where this example exercises it.

| Feature | Where |
| ------- | ----- |
| Release packing | `Dockerfile` packs EventFabric like a release and installs it |
| Commands, Steps, Rules, Events, folding State | `src/domain`; `billing.test.ts` "sendCommand(...).await … load reads an earlier Revision" |
| The Postgres Event store and Outbox at volume | `event-fabric.config.ts` (`metadataIndexes`); `src/import.ts`, a bulk import through the API |
| Postgres documents, child tables, indexes, `stream` | `src/readmodels/invoices.ts`; `src/tasks/statement.ts` (`stream`) |
| RabbitMQ and in-memory transports | `event-fabric.config.ts`; every test file |
| `createApplication`, Consumer groups, health | `event-fabric.config.ts`; `billing.test.ts` "reports itself live and ready" |
| Gateway routes, Access map, Positions | `src/gateway/api.ts`; `smoke.ts` "read its own write through the load balancer" |
| The CLI | [Operate](#operate) |
| The whole stack end to end | `smoke.ts` through Docker (`npm run smoke:docker`) |
| TypeBox payloads, `domain` handles, generated types | [Types](#types); `npm run check` (`types --check`) |
| Whole-group rebuilds with Leases | `rebuild reporting` in [Operate](#operate) |
| Worker retries | the `receipts` Worker |
| Duplicate Commands, `Idempotency-Key` | `billing.test.ts` "a Command id is accepted once"; `smoke.ts` retried payment and retried creation |
| Typed filters: `Filter<Invoice>`, `in`, `elemMatch` | `GET /invoices?status=…&method=card` in `api.ts`; `smoke.ts` |
| Server-Sent Events that drain on shutdown | `/customers/live`, `/customers/:id/invoices/live`; the web client |
| Refusing a log with undeclared Event names | `reminderSent` kept declared in `invoice.ts`; `billing.test.ts` "every Event name in the log is declared" |
| Rejected Outbox Commands dead-lettered with their Rejection | `accounts.ts` compensation; `operations.test.ts` "Saga Commands the Aggregates reject are dead-lettered"; `dead-letters list` |
| Command handlers selected by Context (`--only commands:<app>/<context>`) | [Operate](#operate); `operations.test.ts` "`only` selects Command handlers by Context" |
| Memory adapters that behave like RabbitMQ and Postgres | the in-memory tests stand in for the Docker stack |
| Saga Commands to Aggregates that do not exist yet | `src/scenario.ts`; `unknown-customer` in `invoice.ts` |
| Command Partitions across replicas (quorum queues, per-instance priorities) | `event-fabric.config.ts` transport comment; `rabbitmqctl list_consumers` in [Scale out](#scale-out-a-chained-import) |
| Creations routed by Command id | `POST /customers` (`register(undefined, …)`) under `scenario.ts` and `load.ts` |
| Consumer groups shared across replicas by load | `src/load.ts`; `consumers status`; `grep '"instance"'` in [Operate](#operate) |
| Partitioned groups and fenced layout changes | `PARTITIONS` in `event-fabric.config.ts`; `billing.test.ts` runs 2 Partitions; the switch in [Operate](#operate) |
| Rebuild generations per Partition | `rebuild billing` with `PARTITIONS=4` |
| Live feeds across Partitions | `customer-pages.test.ts` runs the `/customers/live` feed over 2 Partitions |
| Saga effect keys `["saga:<name>", instance, Event, suffix]` | `receipts.ts` (`suffix: "receipt"`); `operations.test.ts` "a receipt's Idempotency key names the Saga…" |
| Outbox order per Stream | the settle → receipt chain in `smoke.ts`; overdue Schedules in `load.ts` runs |
| Postgres cost at scale | `src/load.ts` and `src/import.ts` ([Throughput](#throughput)) |
| Decorators: `@Aggregate`, `@Readmodel`, `@Saga` | `subscription.ts`, `subscriptions.ts`, `renewals.ts` |
| Typed managed services | `src/services/index.ts`, `src/services/setup.ts` |
| Readmodel helpers in place of services | `src/services/readmodel.ts`; `reporting.ts`; `billing.test.ts` "revenue sums money through the Readmodel helpers" |
| Serving while a group rebuilds | `invoices.ts` comment; `health().rebuilding` |
| Fast rebuilds | `rebuildVersion` on `reporting` in `event-fabric.config.ts`; `rebuild` in [Operate](#operate) |
| Named Schedules, cancelled on settle or void | `overdue` in `invoice.ts`; `billing.test.ts` Schedule tests; `smoke.ts` overdue step |
| A Saga partitioned next to the Outbox | `receipts: { ...receipts, partitions }` in `event-fabric.config.ts` |
| Retiring Consumer groups | `operations.test.ts` "a Saga group no deployment declares…"; [Operate](#operate) |
| Diagnostic logging | `LOG_LEVEL=debug` in [Operate](#operate) |
| One rebuild fold worker per Partition | `PARTITIONS=4 APP_CPUS=4 run rebuild billing` in [Operate](#operate) |

## Not shown here

- **Mongo Readmodel store** (`event-fabric/mongo`): a one-line swap of `readmodelStore`, or a group's `store`, but it needs a Mongo replica set.
- **JavaScript authoring** (`compile`, `only.ifValidatedBy`, `only.ifState`, `only.after`): see EventFabric's `examples/basic.mjs`.
- **Readmodel `migrations`**: an in-place upgrade from one known schema hash to the next; without one, a schema change rebuilds the group automatically.
- **Kafka**: EventFabric ships RabbitMQ and in-memory transports; Kafka would need a new adapter behind the same transport interface (ADR-0003).
