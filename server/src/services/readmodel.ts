import type { ReadmodelServices } from "./index.js";

/** The Readmodel helpers every Application of this example supplies as `readmodelServices`. */
export const readmodelServices: ReadmodelServices = {
  // Sums of amounts stay at cents: 0.1 + 0.2 is 0.3, not 0.30000000000000004.
  addMoney: (a, b) => Math.round((a + b) * 100) / 100,
};
