/**
 * ─── Entry point ───────────────────────────────────────────────────────────────
 * Starts the billing Application: `node dist/main.js [--only kind:name ...]`, e.g.
 * `--only gateway:api` for an HTTP-only replica. It runs until SIGTERM or SIGINT and
 * exits 1 when the broker connection is lost, so the supervisor restarts it.
 *
 * The composition root stays in `event-fabric.config.ts`: the CLI (`migrate`,
 * `rebuild`, `task`, `consumers`, `dead-letters`, `types`) and rebuild worker
 * threads import it without starting anything.
 */
import { parseArgs } from "node:util";
import { createApplication } from "event-fabric";
import { config } from "./event-fabric.config.js";

const { values } = parseArgs({
  options: { only: { type: "string", multiple: true } },
});
const application = createApplication({
  ...(await config()),
  // Rebuild worker threads load the config from here; without it a rebuild folds on one thread.
  configModule: import.meta.resolve("./event-fabric.config.js"),
});
process.exitCode = await application.run({ only: values.only });
