import type { Request, Response, Router } from "express";
import { encodePosition, type Plugin, type RecordedEvent } from "event-fabric";

/**
 * ─── Plugin `audit` ────────────────────────────────────────────────────────────
 * A plugin is a function the Application calls once at startup with its context:
 * `logger`, `config`, `sendCommand`, `awaitCorrelated`, `subscribeEvents`,
 * `readmodels`, `services`, the read-only `model`, and `on(hook, callback)`.
 *
 * Hooks:
 * - `start`: after the Application has started;
 * - `gateway`: once per Gateway, with the context and `{ name, router, routes }`,
 *   after the Gateway's own routes;
 * - `shutdown`: in reverse order on `stop()`, sharing the shutdown timeout. A failing
 *   or hanging hook does not skip the others.
 */
export const audit: Plugin = (ctx) => {
  let unsubscribe: (() => Promise<void>) | undefined;

  /*
   * `subscribeEvents` receives an at-most-once Notification for each recorded Event.
   * Good for logs and live updates; anything that must not miss an Event belongs in
   * a Readmodel or Saga, which read the durable log.
   */
  ctx.on("start", async () => {
    unsubscribe = await ctx.subscribeEvents((event: RecordedEvent) =>
      ctx.logger.info(
        {
          event: `${event.stream.context}.${event.stream.aggregate}.${event.name}`,
          id: event.stream.id,
          position: encodePosition(event.position),
          correlationId: event.correlationId,
          actor: event.metadata.actor,
        },
        "Event recorded",
      ),
    );
  });

  /*
   * Routes added here are plain Express routes: the Access map does not guard them,
   * so any sensitive operations need explicit authorization (as settings do).
   */
  ctx.on(
    "gateway",
    (
      _ctx: unknown,
      { name, router, routes }: { name: string; router: Router; routes: unknown[] },
    ) =>
      router.get("/ops/model", (_req: Request, res: Response) =>
        res.json({
          gateway: name,
          routes,
          aggregates: ctx.model.aggregates.map(
            (a: { context: string; name: string }) => `${a.context}.${a.name}`,
          ),
          readmodels: Object.keys(ctx.model.readmodels),
          sagas: Object.keys(ctx.model.sagas),
          workers: Object.keys(ctx.model.workers),
        }),
      ),
  );

  ctx.on("shutdown", async () => {
    await unsubscribe?.();
  });
};
