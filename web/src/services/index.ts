import { createApi } from "./api.ts";
import { live } from "./live.ts";
import { createRouter } from "./router.ts";
import { createSession } from "./session.ts";

/** A justcore extension: puts the services every module asks its sandbox for into the core. */
export const services: jc.Extension = {
  name: "billing-services",
  install(core) {
    const locator = core.serviceLocator;
    locator.addService("session", createSession);
    locator.addService("api", () => createApi(locator.getService("session").$session));
    locator.addService("router", createRouter);
    locator.addService("live", () => live);
  },
};
