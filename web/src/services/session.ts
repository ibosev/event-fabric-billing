import { atom } from "nanostores";
import type { Session, SessionService } from "../contracts.ts";

const KEY = "billing.session";
const initial: Session = { role: "clerk", user: "web", tenant: "demo" };

/** The caller the browser plays, remembered per browser. */
export function createSession(): SessionService {
  let stored: Partial<Session> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {}
  const $session = atom<Session>({ ...initial, ...stored });
  return {
    $session,
    update(patch) {
      $session.set({ ...$session.get(), ...patch });
      try {
        localStorage.setItem(KEY, JSON.stringify($session.get()));
      } catch {}
    },
  };
}
