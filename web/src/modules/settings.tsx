import { useStore } from "@nanostores/solid";
import { atom } from "nanostores";
import { For, Show } from "solid-js";
import type { Setting } from "../contracts.ts";
import { actions, fields, page, resource } from "../lib/module.ts";
import { Alert, Card, Empty, Field, Icon, PageHeader, Skeleton, Table, button, cell, input, row, secondary, small } from "../lib/ui.tsx";

/**
 * Ordinary CRUD next to the event-sourced model: `/settings` goes through routes, a
 * controller, a service and a repository to its own Postgres table, per tenant.
 * Anyone reads; only an admin creates, changes or deletes.
 */
export const settings = page((sandbox) => {
  const api = sandbox.getService("api");
  const session = sandbox.getService("session").$session.get();
  const { $busy, run } = actions(sandbox);
  const list = resource((s) => api.get<Setting[]>("/settings", s), sandbox.signal);
  const $editing = atom<string | undefined>();

  const create = (event: SubmitEvent) => {
    const { values, reset } = fields(event);
    void run(async () => { await api.post("/settings", values); reset(); void list.reload(); }, `Created ${values.key}`);
  };
  const update = (key: string) => (event: SubmitEvent) => {
    const { values } = fields(event);
    void run(async () => { await api.put(`/settings/${key}`, { value: values.value }); $editing.set(undefined); void list.reload(); }, `Updated ${key}`);
  };
  const remove = (key: string) => run(async () => { await api.delete(`/settings/${key}`); void list.reload(); }, `Deleted ${key}`);

  return () => {
    const state = useStore(list.$state);
    const editing = useStore($editing);
    const busy = useStore($busy);
    return (
      <>
        <PageHeader title="Settings" subtitle="Plain CRUD in its own Postgres table, next to the event-sourced model." crumbs={[["Settings", "#/settings"]]} />
        <Show when={session.role !== "admin"}><div class="mb-4"><Alert tone="brand">Read only: switch to admin in the top-right menu to change settings.</Alert></div></Show>
        <div class="grid items-start gap-6 lg:grid-cols-3">
          <Card title="Tenant settings" subtitle={`Tenant ${session.tenant}`} class="lg:col-span-2">
            <Show when={state().error}><div class="p-4"><Alert tone="danger">{state().error}</Alert></div></Show>
            <Show when={(state().data ?? []).length} fallback={state().loading && !state().data ? <Skeleton rows={3} /> : <Empty icon="settings" title="No settings yet">Create one on the right.</Empty>}>
              <Table head={["Key", "Value", ""]}>
                <For each={state().data}>
                  {(setting) => (
                    <tr class={row}>
                      <th scope="row" class={`${cell} font-mono font-medium text-heading`}>{setting.key}</th>
                      <td class={cell}>
                        <Show when={editing() === setting.key} fallback={<span class="break-all rounded bg-neutral-secondary-medium px-1.5 py-0.5 font-mono text-xs text-heading">{setting.value}</span>}>
                          <form onSubmit={update(setting.key)} class="flex gap-2">
                            <input name="value" value={setting.value} required class={input} aria-label={`${setting.key} value`} />
                            <button disabled={busy()} class={button + small}>Save</button>
                          </form>
                        </Show>
                      </td>
                      <td class={`${cell} text-right whitespace-nowrap`}>
                        <Show when={session.role === "admin"}>
                        <button class={secondary + small} onClick={() => $editing.set(editing() === setting.key ? undefined : setting.key)}>
                          {editing() === setting.key ? "Cancel" : "Edit"}
                        </button>{" "}
                        <button class={`${secondary + small} text-fg-danger`} disabled={busy()} onClick={() => void remove(setting.key)}>Delete</button>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </Table>
            </Show>
          </Card>
          <Card title="New setting" subtitle="Admin only">
            <form onSubmit={create} class="space-y-4 p-4">
              <Field label="Key" for="setting-key" hint="Starts with a lowercase letter; letters, digits, . _ -">
                <input id="setting-key" name="key" required pattern="[a-z][a-zA-Z0-9._\-]{0,63}" class={`${input} font-mono`} placeholder="invoicePrefix" />
              </Field>
              <Field label="Value" for="setting-value">
                <input id="setting-value" name="value" required maxLength={4096} class={input} placeholder="INV" />
              </Field>
              <button disabled={busy() || session.role !== "admin"} class={`${button} w-full`}><Icon name="plus" class="size-4" />Create setting</button>
            </form>
          </Card>
        </div>
      </>
    );
  };
});
