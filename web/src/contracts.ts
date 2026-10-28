import type { ReadableAtom } from "nanostores";
import type {} from "justcore";

/*
 * The contract between the shell (`main.ts`) and every module: the documents the server
 * returns, the services a sandbox hands out, and the messages on the bus. Modules import
 * types from here and nothing from each other.
 */

/* ─── Server documents (Readmodels of the billing server) ─── */
export type Contact = { contactId: string; name: string; email: string };
export type Customer = {
  _id: string;
  name: string;
  creditLimit: number;
  invoiced: number;
  paid: number;
  balance: number;
  invoices: string[];
  contacts: Contact[];
};
export type InvoiceStatus = "open" | "overdue" | "settled" | "void";
export type Invoice = {
  _id: string;
  customerId: string;
  debtor: string;
  amount: number;
  paid: number;
  status: InvoiceStatus;
  dueDate: string;
  payments: { amount: number; method: string; at: string }[];
  receipt: string | null;
  voidReason?: string | null;
};
export type Subscription = {
  _id: string;
  customerId: string;
  plan: "basic" | "pro";
  monthlyAmount: number;
  status: "active" | "cancelled";
  periods: number;
  invoices: string[];
  nextRenewal: string | null;
  cancelReason?: string | null;
};
export type Revenue = { _id: string; total: number; payments: number; byMethod: Record<string, number>; lastPaymentAt: string };
export type Plan = { _id: string; active: number; monthlyRevenue: number };
export type Setting = { key: string; value: string };
/** `GET /invoices/:id/dunning`: the dunning Workflow of one Invoice. */
export type Dunning = { status: string; state?: { stage: string; remindersSent: number }; result?: unknown };
export type Stream = { context: string; aggregate: string; id: string };
export type RecordedEvent = {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  timestamp: string;
  correlationId: string;
  causationId?: string;
  stream: Stream;
  revision: number;
  position: string;
};
/** One Event of a Stream with the Aggregate state folded up to it (devtools plugin). */
export type Step = { event: RecordedEvent; state: Record<string, unknown> };
export type Model = { gateway: string; aggregates: string[]; readmodels: string[]; sagas: string[]; workers: string[] };

/* ─── Services ─── */

/** Who the browser plays. The server trusts these headers instead of a token (its Gateway `context`). */
export type Session = { role: "clerk" | "admin"; user: string; tenant: string; customerId?: string };
export interface SessionService {
  readonly $session: ReadableAtom<Session>;
  update(patch: Partial<Session>): void;
}

export interface Api {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

export type Route = { path: string; module: string; params: Record<string, string> };
export interface Router {
  readonly $route: ReadableAtom<Route>;
  navigate(path: string): void;
}

/** Server-Sent Events, closed when `signal` aborts (pass the sandbox's). */
export interface Live {
  open(url: string, handlers: Record<string, (data: any) => void>, signal: AbortSignal): ReadableAtom<boolean>;
}

declare global {
  namespace jc {
    interface ServiceLocatorMap {
      api: Api;
      session: SessionService;
      router: Router;
      live: Live;
    }
  }
}

/* ─── Messages ─── */

/** Fact or failure a module wants the user to see; the toasts module shows it. */
export interface NotifyMessage extends jc.Message {
  type: "notify";
  tone: "success" | "error" | "info";
  text: string;
}

/** What the shell passes to a page module's `init` and `moduleDidReceiveProps`. */
export type PageProps = { root: HTMLElement; params: Record<string, string> };
