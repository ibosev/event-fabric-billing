import { atom } from "nanostores";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { NotifyMessage, PageProps } from "../contracts.ts";

/** Renders a module's Solid view into `root` until the sandbox signal aborts (the module stops). */
export function mount(sandbox: jc.Sandbox, root: HTMLElement | undefined, view: () => JSX.Element): void {
  if (!root) throw new Error(`${sandbox.moduleId} started without a root element`);
  const dispose = render(view, root);
  sandbox.signal.addEventListener("abort", dispose, { once: true });
}

/**
 * A page module: `setup` builds the page's state in nanostores and returns its view. The shell
 * starts a fresh instance per route, so state, requests and live feeds end with the page.
 */
export const page = (setup: (sandbox: jc.Sandbox, params: Record<string, string>) => () => JSX.Element): jc.ModuleFactory =>
  (sandbox) => ({
    sandbox,
    init(props?: PageProps) {
      mount(sandbox, props?.root, setup(sandbox, props?.params ?? {}));
    },
    destroy() {},
  });

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Commands from a module: `$busy` while one runs; a failure (e.g. a Rejection) becomes an error toast. */
export function actions(sandbox: jc.Sandbox) {
  const $busy = atom(false);
  const notify = (tone: NotifyMessage["tone"], text: string) => sandbox.publishAsync<NotifyMessage>({ type: "notify", tone, text });
  const run = async <T>(work: () => Promise<T>, success?: string): Promise<T | undefined> => {
    $busy.set(true);
    try {
      const result = await work();
      if (success) notify("success", success);
      return result;
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      $busy.set(false);
    }
  };
  return { $busy, run, notify };
}

export type Load<T> = { data?: T; error?: string; loading: boolean };

/** A request's state as a store; `reload` drops an answer that a newer request overtook. */
export function resource<T>(fetcher: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
  const $state = atom<Load<T>>({ loading: true });
  let latest: AbortController | undefined;
  const reload = async () => {
    latest?.abort();
    const own = (latest = new AbortController());
    const current = AbortSignal.any([signal, own.signal]);
    $state.set({ ...$state.get(), loading: true, error: undefined });
    try {
      const data = await fetcher(current);
      if (!current.aborted) $state.set({ data, loading: false });
    } catch (error) {
      if (!current.aborted) $state.set({ data: $state.get().data, loading: false, error: messageOf(error) });
    }
  };
  void reload();
  return { $state, reload };
}

/** Form fields by name; `reset` clears the form after a successful Command. */
export const fields = (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  return { values: Object.fromEntries(new FormData(form)) as Record<string, string>, reset: () => form.reset() };
};

export const inDays = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
