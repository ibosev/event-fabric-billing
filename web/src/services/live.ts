import { atom } from "nanostores";
import type { Live } from "../contracts.ts";

export const live: Live = {
  open(url, handlers, signal) {
    const $connected = atom(false);
    const source = new EventSource(url);
    source.onopen = () => $connected.set(true);
    source.onerror = () => $connected.set(false);
    for (const [name, handler] of Object.entries(handlers))
      source.addEventListener(name, (event) => handler(JSON.parse((event as MessageEvent).data)));
    signal.addEventListener("abort", () => { source.close(); $connected.set(false); }, { once: true });
    return $connected;
  },
};
