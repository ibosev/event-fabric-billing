import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For } from "solid-js";
import type { NotifyMessage } from "../contracts.ts";
import { mount } from "../lib/module.ts";
import { Icon } from "../lib/ui.tsx";

type Toast = NotifyMessage & { id: number };
const look = {
  success: { icon: "check", class: "text-fg-success bg-success-soft", title: "Done" },
  error: { icon: "error", class: "text-fg-danger bg-danger-soft", title: "Something went wrong" },
  info: { icon: "info", class: "text-fg-brand bg-brand-softer", title: "Note" },
} as const;

/** Shows every module's `notify` messages as Flowbite toasts. */
export const toasts: jc.ModuleFactory = (sandbox) => {
  const $toasts = atom<Toast[]>([]);
  let next = 1;
  const dismiss = (id: number) => $toasts.set($toasts.get().filter((t) => t.id !== id));
  return {
    sandbox,
    init(props?: { root: HTMLElement }) {
      mount(sandbox, props?.root, () => {
        const list = useStore($toasts);
        return (
          <div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="polite">
            <For each={list()}>
              {(toast) => (
                <div role={toast.tone === "error" ? "alert" : "status"}
                  class="pointer-events-auto flex items-start gap-3 rounded-base border border-default bg-neutral-primary-soft p-3.5 text-body shadow-lg">
                  <span class={`grid size-8 shrink-0 place-items-center rounded-full ${look[toast.tone].class}`}>
                    <Icon name={look[toast.tone].icon} class="size-5" />
                  </span>
                  <div class="min-w-0 flex-1 pt-0.5">
                    <p class="text-sm font-semibold text-heading">{look[toast.tone].title}</p>
                    <p class="break-words text-sm">{toast.text}</p>
                  </div>
                  <button type="button" class="rounded-base p-1 text-body-subtle hover:bg-neutral-tertiary hover:text-heading" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
                    <Icon name="close" class="size-4" />
                  </button>
                </div>
              )}
            </For>
          </div>
        );
      });
    },
    moduleWillSubscribe: () => ["notify"],
    moduleDidReceiveMessage(message: jc.Message) {
      const toast = { ...(message as NotifyMessage), id: next++ };
      $toasts.set([...$toasts.get(), toast].slice(-4));
      setTimeout(() => dismiss(toast.id), toast.tone === "error" ? 8000 : 4000);
    },
    destroy() {},
  };
};
