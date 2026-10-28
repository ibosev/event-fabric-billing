import type { Router } from "express";
import type { Plugin } from "event-fabric";
import { createSettingsController } from "./controller.js";

/** The Gateway hook supplies ready Services to ordinary Express controllers. */
export const settingsRoutes: Plugin = (ctx) => {
  ctx.on("gateway", (_ctx: unknown, { name, router }: { name: string; router: Router }) => {
    if (name !== "api") return;
    const controller = createSettingsController(ctx.services.settings);
    router.post("/settings", controller.create);
    router.get("/settings", controller.list);
    router.get("/settings/:key", controller.get);
    router.put("/settings/:key", controller.update);
    router.delete("/settings/:key", controller.delete);
    router.use("/settings", controller.error);
  });
};
