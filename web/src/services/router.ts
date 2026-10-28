import { atom } from "nanostores";
import type { Route, Router } from "../contracts.ts";

/** Hash paths to page modules; named groups become the page's `params`. */
const routes: [RegExp, string][] = [
  [/^\/$/, "dashboard"],
  [/^\/customers$/, "customers"],
  [/^\/customers\/(?<id>[^/]+)$/, "customer"],
  [/^\/invoices$/, "invoices"],
  [/^\/invoices\/(?<id>[^/]+)$/, "invoice"],
  [/^\/reports$/, "reports"],
  [/^\/settings$/, "settings"],
  [/^\/events(?:\/(?<context>[^/]+)\/(?<aggregate>[^/]+)\/(?<id>[^/]+))?$/, "events"],
];

/** Path groups and query values (`#/invoices?q=acme`) both become params. */
export function matchRoute(hash: string): Route {
  const [path = "/", query = ""] = (hash.replace(/^#/, "") || "/").split("?");
  for (const [pattern, module] of routes) {
    const match = pattern.exec(path);
    if (match) {
      const params = Object.fromEntries([
        ...new URLSearchParams(query),
        ...Object.entries(match.groups ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, decodeURIComponent(value!)]),
      ]);
      return { path, module, params };
    }
  }
  return { path, module: "not-found", params: {} };
}

/** The URL is the shared navigation state: modules read `$route` and ask to `navigate`. */
export function createRouter(): Router {
  const $route = atom(matchRoute(location.hash));
  addEventListener("hashchange", () => $route.set(matchRoute(location.hash)));
  return { $route, navigate: (path) => void (location.hash = path) };
}
