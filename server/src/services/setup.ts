import { Pool } from "pg";
import type { SetupServices } from "event-fabric";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/service.js";
import { createMailer } from "./mailer.js";
import { createRegistry } from "./registry.js";

/** Own the pool for the lifetime of the Application, including failed startup. */
export const setupServices = (database: string, registryDelay: number): SetupServices =>
  async ({ resources, logger }) => {
    const pool = resources.adopt(
      new Pool({ connectionString: database, max: 5 }), (pool) => pool.end(),
    );
    pool.on("error", (error) =>
      logger.error({ error: error.message }, "Settings database connection failed"),
    );
    const client = await pool.connect();
    client.release();
    return {
      mailer: createMailer(logger),
      registry: createRegistry(registryDelay),
      settings: createSettingsService(createSettingsRepository(pool)),
    };
  };
