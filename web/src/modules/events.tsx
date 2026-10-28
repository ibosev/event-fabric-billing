import { useStore } from "@nanostores/solid";
import { atom, computed } from "nanostores";
import { For, Show } from "solid-js";
import type { Model, RecordedEvent, Step, Stream } from "../contracts.ts";
import { page, resource } from "../lib/module.ts";
import { Alert, Badge, Card, Empty, PageHeader, input, secondary, shortId, small } from "../lib/ui.tsx";

const clock = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const same = (a?: Stream, b?: Stream) => !!a && !!b && a.context === b.context && a.aggregate === b.aggregate && a.id === b.id;
const aggregateTone = { invoice: "brand", customer: "success", subscription: "warning" } as const;

/**
 * Debugging tools over the server's `devtools` plugin (`DEVTOOLS=1`):
 *
 * - Event log: the newest 200 Events of the whole store, live over Server-Sent Events; opened
 *   on a Stream (`#/events/:context/:aggregate/:id`), only that Stream's Events and those of
 *   the requests that touched it, until "Show all";
 * - Stream inspector: one Stream's Events with the Aggregate state after each, folded on the
 *   server by the Aggregate's own handlers; a time machine steps through the revisions;
 * - Correlation: every Event one request caused, across Aggregates, in log order;
 * - Model: what the audit plugin reports about the running Application.
 */
export const events = page((sandbox, params) => {
  const api = sandbox.getService("api");
  const { signal } = sandbox;
  const $enabled = atom<boolean | undefined>();
  const $events = atom<RecordedEvent[]>([]);
  const $filter = atom("");
  const $stream = atom<Stream | undefined>(params.id ? (params as Stream) : undefined);
  /** The Stream the list is narrowed to; undefined lists the whole store. */
  const $scope = atom<Stream | undefined>($stream.get());
  /** The revision on screen; undefined follows the latest. */
  const $cursor = atom<number | undefined>();
  const $correlation = atom<string | undefined>();
  const $playing = atom(false);

  const history = resource(async (s) => {
    const stream = $stream.get();
    return stream ? api.get<Step[]>(`/devtools/streams/${stream.context}/${stream.aggregate}/${stream.id}`, s) : [];
  }, signal);
  const chain = resource(async (s) => {
    const id = $correlation.get();
    return id ? api.get<RecordedEvent[]>(`/devtools/events?correlationId=${encodeURIComponent(id)}`, s) : [];
  }, signal);
  const model = resource((s) => api.get<Model>("/ops/model", s), signal);
  const $correlations = computed($events, (list) => new Set(list.map((e) => e.correlationId)));

  const $shown = computed([$events, $filter], (list, filter) => {
    const term = filter.trim().toLowerCase();
    return term ? list.filter((e) => `${e.stream.aggregate}.${e.name} ${e.stream.id} ${e.correlationId}`.toLowerCase().includes(term)) : list;
  });
  const $total = computed(history.$state, (state) => state.data?.length ?? 0);
  const $at = computed([$cursor, $total], (cursor, total) => Math.min(cursor ?? total, total));

  let feed = false;
  const load = () => {
    const scope = $scope.get();
    const query = scope ? `?stream=${encodeURIComponent(`${scope.context}/${scope.aggregate}/${scope.id}`)}` : "";
    return api.get<RecordedEvent[]>(`/devtools/events${query}`, signal).then((list) => {
      $enabled.set(true);
      $events.set(list);
      // The live feed opens only once the log answers, so a server without the plugin is not retried forever.
      if (feed) return;
      feed = true;
      sandbox.getService("live").open("/api/devtools/events/live", {
        event: (event: RecordedEvent) => {
          const scope = $scope.get();
          // A new request on the scoped Stream brings Events of other Streams with it: re-read them all.
          if (scope && same(event.stream, scope)) void load();
          else if (!scope || $correlations.get().has(event.correlationId))
            $events.set([event, ...$events.get().filter((e) => e.id !== event.id)].slice(0, 500));
          if (same(event.stream, $stream.get())) void history.reload();
          if (event.correlationId === $correlation.get()) void chain.reload();
        },
      }, signal);
    }, () => $enabled.get() ?? $enabled.set(false));
  };
  void load();
  const unbind = [$stream.listen(() => void history.reload()), $correlation.listen(() => void chain.reload()), $scope.listen(() => void load())];

  let timer: ReturnType<typeof setInterval> | undefined;
  const pause = () => { clearInterval(timer); $playing.set(false); };
  const play = () => {
    if ($playing.get()) return pause();
    let next = $at.get() >= $total.get() ? 1 : $at.get();
    $cursor.set(next);
    $playing.set(true);
    timer = setInterval(() => (++next > $total.get() ? pause() : $cursor.set(next)), 700);
  };
  signal.addEventListener("abort", () => { clearInterval(timer); unbind.forEach((stop) => stop()); }, { once: true });
  const inspect = (stream: Stream, revision?: number) => { pause(); $stream.set(stream); $cursor.set(revision); };

  const EventName = (props: { event: RecordedEvent }) => (
    <span class="inline-flex items-center gap-1.5">
      <Badge tone={aggregateTone[props.event.stream.aggregate as keyof typeof aggregateTone] ?? "neutral"}>{props.event.stream.aggregate}</Badge>
      <span class="font-semibold text-heading">{props.event.name}</span>
    </span>
  );

  return () => {
    const enabled = useStore($enabled);
    const shown = useStore($shown);
    const scope = useStore($scope);
    const stream = useStore($stream);
    const steps = useStore(history.$state);
    const correlation = useStore($correlation);
    const chainState = useStore(chain.$state);
    const cursor = useStore($cursor);
    const at = useStore($at);
    const total = useStore($total);
    const playing = useStore($playing);
    const modelState = useStore(model.$state);
    const step = () => steps().data?.[at() - 1];
    const previous = () => (at() > 1 ? steps().data![at() - 2]!.state : {});
    const changed = (key: string) => json(step()?.state[key]) !== json(previous()[key]);
    return (
      <>
        <PageHeader title="Event log" subtitle="Every recorded Event, live. Pick one to replay its Stream." crumbs={[["Event log", "#/events"]]} />
        <Show when={enabled() !== false} fallback={<Alert>The server runs without its devtools plugin. Start it with <code>DEVTOOLS=1</code> (the compose stack does).</Alert>}>
          <div class="grid items-start gap-6 lg:grid-cols-[22rem_1fr] 2xl:grid-cols-[26rem_1fr]">
            <Card title="Events" class="flex max-h-[28rem] flex-col lg:sticky lg:top-22 lg:max-h-[calc(100vh-7rem)]">
              <div class="flex items-center justify-between gap-2 border-b border-default bg-neutral-secondary-soft px-4 py-2 text-xs text-body">
                <span class="min-w-0 truncate">
                  {scope() ? <>{shown().length} touching {scope()!.aggregate} <span class="font-mono">{shortId(scope()!.id)}</span></> : `Whole store · newest ${shown().length}`}
                </span>
                <Show when={scope() || stream()}>
                  <button class={`${secondary + small} shrink-0`} onClick={() => $scope.set(scope() ? undefined : stream())}>
                    {scope() ? "Show all" : `Only this ${stream()!.aggregate}`}
                  </button>
                </Show>
              </div>
              <div class="border-b border-default p-3">
                <input type="search" class={input} placeholder="Filter by name, stream or correlation id" aria-label="Filter events" onInput={(e) => $filter.set(e.currentTarget.value)} />
              </div>
              <ol class="flex-1 divide-y divide-default overflow-auto text-xs">
                <For each={shown()} fallback={<Empty>{enabled() ? "No events yet." : "Loading…"}</Empty>}>
                  {(event) => (
                    <li>
                      <button onClick={() => inspect(event.stream, event.revision)}
                        class={`grid w-full grid-cols-[5.5rem_1fr_auto] items-center gap-2 px-4 py-2 text-left hover:bg-neutral-secondary-soft ${same(event.stream, stream()) ? "bg-brand-softer" : ""}`}>
                        <span class="font-mono text-body-subtle">{clock(event.timestamp)}</span>
                        <span class="truncate"><EventName event={event} /> <span class="font-mono text-body-subtle">{event.stream.id.slice(0, 8)}</span></span>
                        <span class="text-right font-mono text-body" title="Who sent the request">
                          <span class="text-body-subtle">{String(event.metadata.actor ?? "")}</span> r{event.revision}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            </Card>

            <div class="min-w-0 space-y-6">
              <Card title={stream() ? <span>Stream <span class="font-mono text-sm text-body">{stream()!.context}.{stream()!.aggregate} {stream()!.id.slice(0, 13)}</span></span> : "Stream inspector"}>
                <Show when={stream()} fallback={<Empty icon="code" title="No Stream picked">Pick an Event on the left to replay its Aggregate, revision by revision.</Empty>}>
                  <Show when={total() > 0} fallback={<Empty>{steps().loading ? "Loading…" : steps().error ?? "This Stream has no Events."}</Empty>}>
                    <div class="space-y-4 p-5">
                      <div class="flex flex-wrap items-center gap-2">
                        <button class={secondary + small} disabled={at() <= 1} onClick={() => $cursor.set(1)} aria-label="First revision">⏮</button>
                        <button class={secondary + small} disabled={at() <= 1} onClick={() => $cursor.set(at() - 1)} aria-label="Previous revision">◀</button>
                        <button class={`${secondary + small} w-20`} onClick={play}>{playing() ? "Pause" : "Replay"}</button>
                        <button class={secondary + small} disabled={at() >= total()} onClick={() => $cursor.set(at() + 1)} aria-label="Next revision">▶</button>
                        <button class={secondary + small} disabled={cursor() === undefined} onClick={() => $cursor.set(undefined)}>Follow latest</button>
                        <input type="range" min="1" max={total()} value={at()} aria-label="Revision" class="min-w-32 flex-1 accent-(--color-brand)"
                          onInput={(e) => $cursor.set(Number(e.currentTarget.value))} />
                        <span class="font-mono text-xs">r{at()} / {total()}</span>
                        <Show when={cursor() === undefined}><Badge tone="success">latest</Badge></Show>
                      </div>
                      <div class="grid gap-4 2xl:grid-cols-2">
                        <ol class="space-y-1 text-xs">
                          <For each={steps().data}>
                            {(s, i) => (
                              <li>
                                <button onClick={() => $cursor.set(i() + 1)}
                                  class={`flex w-full items-center gap-2 rounded-base border px-2 py-1.5 text-left ${i() + 1 === at() ? "border-brand bg-brand-softer" : i() + 1 > at() ? "border-dashed border-default opacity-40" : "border-default hover:bg-neutral-secondary-soft"}`}>
                                  <span class="w-8 font-mono text-body">r{s.event.revision}</span>
                                  <span class="flex-1 truncate"><EventName event={s.event} /></span>
                                  <span class="font-mono text-body-subtle">{clock(s.event.timestamp)}</span>
                                </button>
                              </li>
                            )}
                          </For>
                        </ol>
                        <div class="space-y-4">
                          <div>
                            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-body">State after r{at()}</h3>
                            <dl class="divide-y divide-default rounded-base border border-default font-mono text-xs">
                              <For each={Object.keys(step()?.state ?? {})}>
                                {(key) => (
                                  <div class={`grid grid-cols-[8rem_1fr] gap-2 px-2 py-1 ${changed(key) ? "bg-warning-soft" : ""}`}>
                                    <dt class={changed(key) ? "font-semibold text-fg-warning" : "text-body"}>{key}</dt>
                                    <dd class="break-all whitespace-pre-wrap text-heading">{json(step()?.state[key])}</dd>
                                  </div>
                                )}
                              </For>
                            </dl>
                            <p class="mt-1 text-xs text-body">Highlighted: changed by this Event.</p>
                          </div>
                          <Show when={step()}>
                            {(s) => (
                              <div>
                                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-body">Event</h3>
                                <pre class="overflow-auto rounded-base bg-dark p-3 text-xs text-white">
                                  {json({ payload: s().event.payload, metadata: s().event.metadata, position: s().event.position })}
                                </pre>
                                <button class={`${secondary + small} mt-2`} onClick={() => $correlation.set(s().event.correlationId)}>
                                  Trace correlation {s().event.correlationId.slice(0, 8)}
                                </button>
                              </div>
                            )}
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>
                </Show>
              </Card>

              <Show when={correlation()}>
                {(id) => (
                  <Card title={<span>Correlation <span class="font-mono text-sm text-body">{id().slice(0, 13)}</span></span>}
                    actions={<button class={secondary + small} onClick={() => $correlation.set(undefined)}>Close</button>}>
                    <ol class="divide-y divide-default text-xs">
                      <For each={chainState().data} fallback={<Empty>{chainState().loading ? "Loading…" : "No Events."}</Empty>}>
                        {(event) => (
                          <li>
                            <button onClick={() => inspect(event.stream, event.revision)} class="grid w-full grid-cols-[6rem_1fr_auto] items-center gap-2 px-5 py-2 text-left hover:bg-neutral-secondary-soft">
                              <span class="font-mono text-body-subtle">{clock(event.timestamp)}</span>
                              <span class="truncate"><EventName event={event} /> <span class="font-mono text-body-subtle">{event.stream.id.slice(0, 8)}</span></span>
                              <span class="font-mono text-body">{String(event.metadata.actor ?? "")}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Card>
                )}
              </Show>

              <Card title="Application model">
                <Show when={modelState().data} fallback={<Empty>{modelState().error ?? "Loading…"}</Empty>}>
                  {(m) => (
                    <dl class="grid gap-4 p-5 text-sm sm:grid-cols-2">
                      <For each={["aggregates", "readmodels", "sagas", "workers"] as const}>
                        {(kind) => (
                          <div>
                            <dt class="mb-1.5 font-medium capitalize text-heading">{kind}</dt>
                            <dd class="flex flex-wrap gap-1.5"><For each={m()[kind]}>{(name) => <Badge>{name}</Badge>}</For></dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  )}
                </Show>
              </Card>
            </div>
          </div>
        </Show>
      </>
    );
  };
});
