import type { ErrorRequestHandler, Request, Response } from "express";
import { createValidator, ForbiddenError, handle, ValidationError } from "event-fabric";
import type { Caller } from "../gateway/api.js";
import {
  CreateSettingRequest, SettingKey, UpdateSettingRequest, type SettingResponse,
} from "./dto.js";
import type { Setting } from "./model.js";
import { SettingExistsError, SettingNotFoundError, type SettingsService } from "./service.js";

const response = ({ key, value }: Setting): SettingResponse => ({ key, value });
const validate = createValidator({ mutate: false });
const administrator = (req: Request) => {
  const caller = handle<Caller>(req).ctx;
  if (caller.role !== "admin") throw new ForbiddenError();
  return caller;
};
const requestKey = async (req: Request) => {
  const key = String(req.params.key);
  await validate(SettingKey, key);
  return key;
};

/** Translate HTTP requests/responses; the service owns the setting operations. */
export const createSettingsController = (settings: SettingsService) => ({
  async create(req: Request, res: Response) {
    const { tenant } = administrator(req);
    const body: CreateSettingRequest = req.body;
    await validate(CreateSettingRequest, body);
    const setting = await settings.create(tenant, body.key, body.value);
    res.status(201).location(`/settings/${setting.key}`).json(response(setting));
  },
  async get(req: Request, res: Response) {
    const { tenant } = handle<Caller>(req).ctx;
    const setting = await settings.get(tenant, await requestKey(req));
    res.json(response(setting));
  },
  async list(req: Request, res: Response) {
    const { tenant } = handle<Caller>(req).ctx;
    res.json((await settings.list(tenant)).map(response));
  },
  async update(req: Request, res: Response) {
    const { tenant } = administrator(req);
    const body: UpdateSettingRequest = req.body;
    await validate(UpdateSettingRequest, body);
    res.json(response(await settings.update(tenant, await requestKey(req), body.value)));
  },
  async delete(req: Request, res: Response) {
    const { tenant } = administrator(req);
    await settings.delete(tenant, await requestKey(req));
    res.status(204).end();
  },
  error: ((error, _req, res, next) => {
    if (error instanceof ValidationError)
      return res.status(400).json({ code: "invalid-setting", message: error.message });
    if (error instanceof SettingNotFoundError)
      return res.status(404).json({ code: "setting-not-found" });
    if (error instanceof SettingExistsError)
      return res.status(409).json({ code: "setting-exists" });
    next(error);
  }) satisfies ErrorRequestHandler,
});
