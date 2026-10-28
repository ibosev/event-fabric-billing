import type { ReadableAtom } from "nanostores";
import type { Api, Session } from "../contracts.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A Rejection answers `{ status, error: { code, message } }`; other errors `{ code, message }`. */
export const errorOf = (status: number, body: any): ApiError =>
  new ApiError(
    status,
    body?.error?.code ?? body?.code,
    body?.error?.message ?? body?.message ?? body?.code ?? `Request failed (HTTP ${status})`,
  );

/** JSON over the Gateway, with the session's caller headers on every request. */
export function createApi($session: ReadableAtom<Session>, base = "/api"): Api {
  const request = async (method: string, path: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal) => {
    const { user, role, tenant, customerId } = $session.get();
    const res = await fetch(base + path, {
      method,
      signal,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        "X-User": user,
        "X-Role": role,
        "X-Tenant": tenant,
        ...(customerId && { "X-Customer-Id": customerId }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw errorOf(res.status, json);
    return json;
  };
  return {
    get: (path, signal) => request("GET", path, undefined, undefined, signal),
    post: (path, body, headers) => request("POST", path, body, headers),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}
