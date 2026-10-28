# EventFabric billing

A billing CRM built as an example of [EventFabric](https://github.com/ibosev/event-fabric), in two parts, each with its own `package.json`:

| Folder | What it is |
| --- | --- |
| [`server/`](server/README.md) | The billing Application on EventFabric: event-sourced Customers, Invoices and Subscriptions, Sagas, Workers, a dunning Workflow, Readmodels, a Gateway and ordinary settings CRUD, on Postgres, RabbitMQ and optionally Mongo |
| [`web/`](web/README.md) | The CRM frontend: [justcore](https://github.com/ibosev/justcore) modules written in SolidJS, all state in nanostores, styled with Flowbite on Tailwind CSS |

The server's only framework is EventFabric; the frontend's is justcore.

## Set up

Both libraries are linked from sibling checkouts (`file:../../event-fabric` and `file:../../justcore`), and the server's Docker image builds EventFabric from its checkout. Clone the three repositories side by side and build the libraries once:

```sh
git clone https://github.com/ibosev/event-fabric
git clone https://github.com/ibosev/justcore
git clone https://github.com/ibosev/event-fabric-billing
(cd event-fabric && npm ci && npm run build)
(cd justcore && npm ci && npm run build)
```

## Run

Docker runs the server stack; Node 24 runs the web client.

```sh
cd event-fabric-billing/server
docker compose up -d --build --wait   # Postgres, RabbitMQ, Mongo, migrations, 3 replicas behind nginx on :3300
npm run smoke:docker                  # end-to-end check in its own throwaway stack

cd ../web
npm install
npm run dev                           # http://localhost:5173, /api proxied to :3300
```

`docker compose down -v` (in `server/`) stops everything and deletes the data.

## License

MIT
