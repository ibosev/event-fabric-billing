import { configs } from "event-fabric/eslint-plugin";

/*
 * ─── Lint ──────────────────────────────────────────────────────────────────────
 * EventFabric's rules run on the compiled output, which needs no TypeScript parser
 * (TypeScript 7 ships no API for one). They find each handler's role from its
 * decorator or its place in an `aggregate()`/Readmodel/Saga object: Event handlers
 * and Readmodel Reactions may not read the clock or randomness, Commands use
 * `command.now`, and decorated classes hold no state.
 */
export default [{ ...configs.recommended, files: ["dist/**/*.js"] }];
