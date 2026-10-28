import { For, Show, type JSX, type ParentProps } from "solid-js";
import type { InvoiceStatus } from "../contracts.ts";

/*
 * Flowbite's components (default theme, Tailwind CSS v4 tokens) as plain markup. Flowbite's
 * own JavaScript is not loaded: Solid renders and nanostores hold any open/closed state.
 */

const base = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap box-border border font-medium leading-5 rounded-base text-sm px-3.5 py-2 shadow-xs focus:outline-none focus:ring-4 disabled:pointer-events-none disabled:opacity-50 transition-colors";
export const button = `${base} text-white bg-brand border-transparent hover:bg-brand-strong focus:ring-brand-medium`;
export const secondary = `${base} text-body bg-neutral-primary-soft border-default-medium hover:bg-neutral-secondary-medium hover:text-heading focus:ring-neutral-tertiary`;
export const danger = `${base} text-white bg-danger border-transparent hover:bg-danger-strong focus:ring-danger-medium`;
/** Append to a button class for the small size. */
export const small = " !px-2.5 !py-1.5 !text-xs";
export const input =
  "bg-neutral-secondary-soft border border-default-medium text-heading text-sm rounded-base focus:ring-brand focus:border-brand block w-full px-3 py-2 shadow-xs placeholder:text-body-subtle";
export const label = "block mb-1.5 text-sm font-medium text-heading";
export const link = "font-medium text-fg-brand hover:underline";

const euro = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" });
export const money = { format: (value: number) => euro.format(value) };
const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
const stamp = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** `2026-11-27` → `27 Nov 2026`. */
export const date = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso));
export const dateTime = (iso: string) => stamp.format(new Date(iso));
/** Whole days from today to a `YYYY-MM-DD` date; negative when it is past. */
export const daysUntil = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / 864e5);
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
export const shortId = (id: string) => id.slice(0, 8).toUpperCase();

/** A due date with how far it is, tinted when it has passed on an open Invoice. */
export function Due(props: { date: string; open?: boolean }) {
  const days = () => daysUntil(props.date);
  const hint = () => relative.format(...(Math.abs(days()) < 45 ? [days(), "day"] : Math.abs(days()) < 540 ? [Math.round(days() / 30), "month"] : [Math.round(days() / 365), "year"]) as [number, Intl.RelativeTimeFormatUnit]);
  return (
    <span class="whitespace-nowrap">
      <span class="text-heading">{date(props.date)}</span>
      <Show when={props.open}>
        <span class={`ms-1.5 text-xs ${days() < 0 ? "text-fg-danger font-medium" : "text-body-subtle"}`}>{hint()}</span>
      </Show>
    </span>
  );
}

export function Card(props: ParentProps<{ title?: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element; class?: string }>) {
  return (
    <section class={`bg-neutral-primary-soft border border-default rounded-base shadow-xs overflow-hidden ${props.class ?? ""}`}>
      <Show when={props.title || props.actions}>
        <header class="flex flex-wrap items-center justify-between gap-2 border-b border-default px-4 py-3">
          <div>
            <h2 class="text-base font-semibold text-heading">{props.title}</h2>
            <Show when={props.subtitle}><p class="text-xs text-body">{props.subtitle}</p></Show>
          </div>
          <div class="flex items-center gap-2">{props.actions}</div>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

export function PageHeader(props: { title: JSX.Element; subtitle?: JSX.Element; crumbs?: [string, string][]; actions?: JSX.Element; leading?: JSX.Element }) {
  return (
    <div class="mb-6">
      <nav class="mb-3 flex text-xs font-medium text-body" aria-label="Breadcrumb">
        <ol class="inline-flex items-center gap-1.5">
          <li><a href="#/" class="hover:text-fg-brand">Home</a></li>
          <For each={props.crumbs ?? []}>
            {([text, href]) => (
              <li class="inline-flex items-center gap-1.5">
                <Icon name="chevron" class="size-3 text-body-subtle" />
                <a href={href} class="hover:text-fg-brand">{text}</a>
              </li>
            )}
          </For>
        </ol>
      </nav>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex min-w-0 items-center gap-4">
          {props.leading}
          <div class="min-w-0">
            <h1 class="truncate text-2xl font-bold tracking-tight text-heading">{props.title}</h1>
            <Show when={props.subtitle}><p class="mt-0.5 text-sm text-body">{props.subtitle}</p></Show>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
      </div>
    </div>
  );
}

const tones = {
  brand: "bg-brand-softer text-fg-brand-strong",
  success: "bg-success-soft text-fg-success-strong",
  warning: "bg-warning-soft text-fg-warning",
  danger: "bg-danger-soft text-fg-danger-strong",
  neutral: "bg-neutral-secondary-medium text-body",
};
const dots = { brand: "bg-fg-brand", success: "bg-fg-success", warning: "bg-fg-warning-subtle", danger: "bg-fg-danger", neutral: "bg-body-subtle" };
export type Tone = keyof typeof tones;
export function Badge(props: ParentProps<{ tone?: Tone; dot?: boolean }>) {
  return (
    <span class={`${tones[props.tone ?? "neutral"]} inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium`}>
      <Show when={props.dot}><span class={`size-1.5 rounded-full ${dots[props.tone ?? "neutral"]}`} /></Show>
      {props.children}
    </span>
  );
}
const statusTone: Record<InvoiceStatus, Tone> = { open: "brand", overdue: "danger", settled: "success", void: "neutral" };
const statusText: Record<InvoiceStatus, string> = { open: "Open", overdue: "Overdue", settled: "Paid", void: "Void" };
export const InvoiceBadge = (props: { status: InvoiceStatus }) => <Badge dot tone={statusTone[props.status]}>{statusText[props.status]}</Badge>;

export function LiveDot(props: { on: boolean }) {
  return (
    <span class={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${props.on ? "bg-success-soft text-fg-success-strong" : "bg-neutral-secondary-medium text-body"}`} title="Server-Sent Events">
      <span class="relative flex size-2">
        <Show when={props.on}><span class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" /></Show>
        <span class={`relative inline-flex size-2 rounded-full ${props.on ? "bg-success" : "bg-neutral-quaternary"}`} />
      </span>
      {props.on ? "Live" : "Offline"}
    </span>
  );
}

/** Tailwind needs whole class names, so the palette is spelled out. */
const avatarColors = [
  "bg-blue-100 text-blue-800", "bg-emerald-100 text-emerald-800", "bg-amber-100 text-amber-800", "bg-rose-100 text-rose-800",
  "bg-violet-100 text-violet-800", "bg-cyan-100 text-cyan-800", "bg-orange-100 text-orange-800", "bg-teal-100 text-teal-800",
];
export function Avatar(props: { name: string; size?: "sm" | "lg" }) {
  const initials = () => props.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
  const color = () => avatarColors[[...props.name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % avatarColors.length];
  return (
    <span class={`grid shrink-0 place-items-center rounded-full font-semibold ${color()} ${props.size === "lg" ? "size-14 text-lg" : "size-8 text-xs"}`} aria-hidden="true">
      {initials()}
    </span>
  );
}

const statIcon: Record<Tone, string> = { brand: "bg-brand-softer text-fg-brand", success: "bg-success-soft text-fg-success", warning: "bg-warning-soft text-fg-warning-subtle", danger: "bg-danger-soft text-fg-danger", neutral: "bg-neutral-secondary-medium text-body" };
export function Stat(props: { label: string; value: JSX.Element; hint?: JSX.Element; icon?: IconName; tone?: Tone; progress?: number }) {
  return (
    <div class="bg-neutral-primary-soft border border-default rounded-base shadow-xs p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-medium text-body">{props.label}</p>
          <p class="mt-1 truncate text-2xl font-bold tracking-tight text-heading tabular-nums">{props.value}</p>
        </div>
        <Show when={props.icon}>
          <span class={`grid size-10 shrink-0 place-items-center rounded-base ${statIcon[props.tone ?? "brand"]}`}><Icon name={props.icon!} /></span>
        </Show>
      </div>
      <Show when={props.progress !== undefined}><div class="mt-3"><Progress value={props.progress!} tone={props.tone} /></div></Show>
      <Show when={props.hint}><p class="mt-2 text-xs text-body">{props.hint}</p></Show>
    </div>
  );
}

const bar: Record<Tone, string> = { brand: "bg-brand", success: "bg-success", warning: "bg-warning", danger: "bg-danger", neutral: "bg-neutral-quaternary" };
/** `value` from 0 to 1. */
export function Progress(props: { value: number; tone?: Tone }) {
  return (
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-neutral-tertiary" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(props.value * 100)}>
      <div class={`h-full rounded-full transition-[width] duration-500 ${bar[props.tone ?? "brand"]}`} style={{ width: `${Math.min(100, Math.max(0, props.value * 100))}%` }} />
    </div>
  );
}

export function Table(props: ParentProps<{ head: (string | [string, "right"])[] }>) {
  return (
    <div class="relative overflow-x-auto">
      <table class="w-full text-sm text-left text-body">
        <thead class="text-xs uppercase tracking-wide text-body bg-neutral-secondary-soft border-b border-default">
          <tr>
            <For each={props.head}>
              {(h) => <th scope="col" class={`px-4 py-2.5 font-semibold ${Array.isArray(h) ? "text-right" : ""}`}>{Array.isArray(h) ? h[0] : h}</th>}
            </For>
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}
export const row = "bg-neutral-primary-soft border-b border-default last:border-b-0 hover:bg-neutral-secondary-soft transition-colors";
/** A row that navigates: the whole row is the target, its first link the keyboard one. */
export const clickRow = `${row} cursor-pointer`;
export const cell = "px-4 py-3";
export const num = "px-4 py-3 text-right tabular-nums whitespace-nowrap";

export function Empty(props: ParentProps<{ icon?: IconName; title?: string }>) {
  return (
    <div class="flex flex-col items-center px-6 py-10 text-center">
      <span class="mb-3 grid size-10 place-items-center rounded-full bg-neutral-secondary-medium text-body"><Icon name={props.icon ?? "inbox"} /></span>
      <Show when={props.title}><p class="text-sm font-semibold text-heading">{props.title}</p></Show>
      <div class="mt-1 max-w-sm text-sm text-body">{props.children}</div>
    </div>
  );
}

/** Placeholder rows while the first answer is on its way. */
export function Skeleton(props: { rows?: number }) {
  return (
    <div class="animate-pulse space-y-3 p-4" aria-busy="true" aria-label="Loading">
      <For each={Array.from({ length: props.rows ?? 4 })}>
        {(_, i) => (
          <div class="flex items-center gap-3">
            <div class="size-8 rounded-full bg-neutral-tertiary" />
            <div class="h-2.5 rounded-full bg-neutral-tertiary" style={{ width: `${40 + ((i() * 17) % 45)}%` }} />
          </div>
        )}
      </For>
    </div>
  );
}

export function Alert(props: ParentProps<{ tone?: "warning" | "danger" | "brand" }>) {
  const tone = { warning: "text-fg-warning bg-warning-soft border-warning-subtle", danger: "text-fg-danger-strong bg-danger-soft border-danger-subtle", brand: "text-fg-brand-strong bg-brand-softer border-brand-subtle" };
  return (
    <div role="alert" class={`flex items-start gap-3 p-4 text-sm rounded-base border ${tone[props.tone ?? "warning"]}`}>
      <Icon name="info" class="size-5 shrink-0" />
      <div>{props.children}</div>
    </div>
  );
}

/** Flowbite's right-hand drawer. */
export function Drawer(props: ParentProps<{ open: boolean; title: string; subtitle?: string; onClose(): void }>) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 bg-dark-backdrop/60 backdrop-blur-[1px]" onClick={() => props.onClose()} />
      <aside role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={(e) => e.key === "Escape" && props.onClose()}
        class="fixed top-0 right-0 z-50 flex h-screen w-full max-w-md flex-col bg-neutral-primary-soft border-s border-default shadow-xl">
        <div class="flex items-start justify-between gap-4 border-b border-default px-5 py-4">
          <div>
            <h3 class="text-lg font-semibold text-heading">{props.title}</h3>
            <Show when={props.subtitle}><p class="mt-0.5 text-sm text-body">{props.subtitle}</p></Show>
          </div>
          <button type="button" class="rounded-base p-1.5 text-body hover:bg-neutral-tertiary hover:text-heading" aria-label="Close" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-5">{props.children}</div>
      </aside>
    </Show>
  );
}

/** A label with its control and an optional hint under it. */
export function Field(props: ParentProps<{ label: string; for: string; hint?: string }>) {
  return (
    <div>
      <label class={label} for={props.for}>{props.label}</label>
      {props.children}
      <Show when={props.hint}><p class="mt-1.5 text-xs text-body">{props.hint}</p></Show>
    </div>
  );
}

/* Outline icons (24×24, stroke). */
const paths = {
  home: "M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25",
  users: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
  invoice: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
  chart: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  settings: "M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75",
  bolt: "M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z",
  menu: "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5",
  close: "M6 18L18 6M6 6l12 12",
  plus: "M12 4.5v15m7.5-7.5h-15",
  check: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  info: "M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z",
  error: "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z",
  chevron: "M8.25 4.5l7.5 7.5-7.5 7.5",
  down: "M19.5 8.25l-7.5 7.5-7.5-7.5",
  cash: "M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z",
  clock: "M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z",
  alarm: "M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0",
  refresh: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99",
  card: "M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z",
  repeat: "M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3",
  mail: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
  inbox: "M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z",
  search: "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
  code: "M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5",
  logout: "M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9",
};
export type IconName = keyof typeof paths;
export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg class={props.class ?? "size-5"} aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">
      <path stroke-linecap="round" stroke-linejoin="round" d={paths[props.name]} />
    </svg>
  );
}
