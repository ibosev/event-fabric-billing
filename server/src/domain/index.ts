import { defineDomain } from "event-fabric";
import { customer } from "./customer.js";
import { invoice } from "./invoice.js";

/**
 * ─── The domain ────────────────────────────────────────────────────────────────
 * Every Aggregate of the Application, collected into one namespace of Handles:
 *
 * - `domain.billing.invoice.settled` is the qualified Event name
 *   `"billing.invoice.settled"`, typed with its payload. Readmodels and Sagas key
 *   their Reactions by it.
 * - `domain.billing.invoice.issue(id, payload)` builds a typed Command that a
 *   Gateway, Saga, Worker or Task sends.
 *
 * A misspelled Event, an unknown Command or a wrong payload is a compile error on
 * the line that has it, and editors rename through these Handles.
 */
export const domain = defineDomain(invoice, customer);
