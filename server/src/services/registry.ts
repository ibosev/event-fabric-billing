/**
 * ─── Service `registry` ────────────────────────────────────────────────────────
 * Stands in for an outside company registry that Customer registration consults.
 * It answers after `delayMs`, so registering a Customer takes a while, as it does
 * when a real provider is slow. `REGISTRY_DELAY_MS` sets it in the config.
 */
export type Registry = {
  verify(name: string, options: { signal?: AbortSignal }): Promise<void>;
};

export const createRegistry = (delayMs: number): Registry => ({
  async verify(_name, { signal }) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  },
});
