import { Type, type Static } from "event-fabric";

/** HTTP contracts and runtime validation, separate from the stored model. */
export const SettingKey = Type.String({ pattern: "^[a-z][a-zA-Z0-9._-]{0,63}$" });
const value = Type.String({ maxLength: 4096, pattern: "^[^\\u0000]*$" });
export const CreateSettingRequest = Type.Object({ key: SettingKey, value }, { additionalProperties: false });
export type CreateSettingRequest = Static<typeof CreateSettingRequest>;
export const UpdateSettingRequest = Type.Object({ value }, { additionalProperties: false });
export type UpdateSettingRequest = Static<typeof UpdateSettingRequest>;
export type SettingResponse = { key: string; value: string };
