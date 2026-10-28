import type { Request, Response, Router } from "express";
import {
  comparePositions,
  encodePosition,
  loadAggregate,
  sse,
  type AggregateDefinition,
  type EventStore,
  type Plugin,
  type RecordedEvent,
} from "event-fabric";

/**
 * ─── Plugin `devtools` ─────────────────────────────────────────────────────────
 * Read-only routes over the Event log for the web client's debugging tools:
 *
 * - `GET /devtools/events`: the newest Events across the whole store, one Correlation's
 *   (`?correlationId=`), or one Stream's together with every Event of the requests that
 *   touched it (`?stream=context/aggregate/id`), newest first;
 * - `GET /devtools/events/live`: every recorded Event as it happens (Server-Sent Events);
 * - `GET /devtools/streams/:context/:aggregate/:id`: one Stream's Events, each with
 *   the Aggregate state folded up to it by the Aggregate's own Event handlers.
 *
 * These routes bypass the Gateway's Access map and expose every Event, so the
 * config registers the plugin only when `DEVTOOLS=1`, never in production.
 */
const wire = (event: RecordedEvent) => ({
  ...event,
  position: encodePosition(event.position),
});

export const devtools: Plugin = (ctx) => {
  const store: EventStore = ctx.config.store;
  const aggregates: AggregateDefinition[] = ctx.config.aggregates ?? [];

  ctx.on("gateway", (_ctx: unknown, { router }: { router: Router }) => {
    router.get("/devtools/events", async (req: Request, res: Response) => {
      const { correlationId, stream } = req.query;
      if (typeof stream === "string") {
        const [context = "", aggregate = "", ...id] = stream.split("/");
        const own = await store.readStream({ context, aggregate, id: id.join("/") });
        const correlations = [...new Set(own.map((event) => event.correlationId))];
        // shortcut: one read per Correlation, fine for example-sized Streams.
        const related = (await Promise.all(correlations.map((correlation) => store.readAll({ correlationId: correlation })))).flat();
        return res.json(related.sort((a, b) => comparePositions(b.position, a.position)).map(wire));
      }
      const events =
        typeof correlationId === "string"
          ? await store.readAll({ correlationId })
          : await store.readAll({ reverse: true, limit: 200 });
      res.json(events.map(wire));
    });

    router.get("/devtools/events/live", async (req: Request, res: Response) => {
      let feed: ReturnType<typeof sse> | undefined;
      const stop = await ctx.subscribeEvents((event: RecordedEvent) =>
        feed?.send("event", wire(event)),
      );
      feed = sse(req, res, { heartbeat: 15_000 });
      req.on("close", () => void stop());
    });

    router.get(
      "/devtools/streams/:context/:aggregate/:id",
      async (req: Request, res: Response) => {
        const stream = {
          context: String(req.params.context),
          aggregate: String(req.params.aggregate),
          id: String(req.params.id),
        };
        const definition = aggregates.find(
          (a) => a.context === stream.context && a.name === stream.aggregate,
        );
        if (!definition)
          return res.status(404).json({ code: "unknown-aggregate" });
        const history = await store.readStream(stream);
        // shortcut: folds each prefix from scratch (quadratic), fine for example-sized Streams.
        res.json(
          history.map((event, i) => ({
            event: wire(event),
            state: loadAggregate(definition, stream.id, history.slice(0, i + 1)).get(),
          })),
        );
      },
    );
  });
};
