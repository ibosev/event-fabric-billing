import type { SettingsRepository } from "./repository.js";

export class SettingNotFoundError extends Error {}
export class SettingExistsError extends Error {}

/** Ordinary application operations; the repository is supplied during Services setup. */
export const createSettingsService = (repository: SettingsRepository) => ({
  async create(tenant: string, key: string, value: string) {
    const setting = await repository.create(tenant, key, value);
    if (!setting) throw new SettingExistsError();
    return setting;
  },
  list: (tenant: string) => repository.list(tenant),
  async get(tenant: string, key: string) {
    const setting = await repository.get(tenant, key);
    if (!setting) throw new SettingNotFoundError();
    return setting;
  },
  async update(tenant: string, key: string, value: string) {
    const setting = await repository.update(tenant, key, value);
    if (!setting) throw new SettingNotFoundError();
    return setting;
  },
  async delete(tenant: string, key: string) {
    if (!(await repository.delete(tenant, key))) throw new SettingNotFoundError();
  },
});
export type SettingsService = ReturnType<typeof createSettingsService>;
