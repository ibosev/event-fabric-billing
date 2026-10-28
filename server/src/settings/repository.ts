import type { Pool } from "pg";
import type { Setting } from "./model.js";

/** All SQL lives here; every operation includes tenant ownership. */
export const createSettingsRepository = (pool: Pool) => ({
  async create(tenant: string, key: string, value: string): Promise<Setting | undefined> {
    const result = await pool.query<Setting>(
      "INSERT INTO settings (tenant, key, value) VALUES ($1, $2, $3) ON CONFLICT (tenant, key) DO NOTHING RETURNING tenant, key, value",
      [tenant, key, value],
    );
    return result.rows[0];
  },
  async get(tenant: string, key: string): Promise<Setting | undefined> {
    const result = await pool.query<Setting>(
      "SELECT tenant, key, value FROM settings WHERE tenant = $1 AND key = $2",
      [tenant, key],
    );
    return result.rows[0];
  },
  async list(tenant: string): Promise<Setting[]> {
    // shortcut: an unpaginated settings list; add pagination if this small collection grows.
    const result = await pool.query<Setting>(
      "SELECT tenant, key, value FROM settings WHERE tenant = $1 ORDER BY key",
      [tenant],
    );
    return result.rows;
  },
  async update(tenant: string, key: string, value: string): Promise<Setting | undefined> {
    const result = await pool.query<Setting>(
      "UPDATE settings SET value = $3 WHERE tenant = $1 AND key = $2 RETURNING tenant, key, value",
      [tenant, key, value],
    );
    return result.rows[0];
  },
  async delete(tenant: string, key: string): Promise<boolean> {
    const result = await pool.query(
      "DELETE FROM settings WHERE tenant = $1 AND key = $2", [tenant, key],
    );
    return result.rowCount === 1;
  },
});
export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
