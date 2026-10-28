import type { Mailer } from "./mailer.js";
import type { Registry } from "./registry.js";
import type { SettingsService } from "../settings/service.js";

/**
 * ─── Services ──────────────────────────────────────────────────────────────────
 * Registering the services contract types `app.getServices()` in Steps and Reactions,
 * `ctx.services` in Workers, plugins and Tasks, and requires the config to supply all
 * of them. `event-fabric types` never writes this part of `Register`.
 */
export type Services = { mailer: Mailer; registry: Registry; settings: SettingsService };

/**
 * Readmodel helpers: what `app.getServices()` returns in Readmodel Reactions, live and
 * on every rebuild. They are deterministic functions only, so a rebuild reproduces
 * the documents; the runtime makes the object read-only. Sagas keep `Services`.
 */
export type ReadmodelServices = { addMoney: (a: number, b: number) => number };

declare module "event-fabric" {
  interface Register {
    services: Services;
    readmodelServices: ReadmodelServices;
  }
}
