import { apiPath, api, ApiError, post } from "./lib.js";

/**
 * The event stream for everything this window watches (see src/stream.ts): the run list, the runs
 * it shows, its terminals. A browser has 6 connections per host for all its tabs, and an event
 * stream holds one while it's open, so a stream per feature ran out of them; requests then waited
 * forever. So there's one stream, subscribing or unsubscribing is a short request, and the
 * browser's windows share it: one of them (the first to take a Web Lock) holds it for all, and the
 * others send it what they watch and get their events over a BroadcastChannel. When that window
 * closes, the next one takes the lock and opens it again. Where there are no Web Locks (the phone,
 * on plain HTTP over Wi-Fi) each window has its own.
 *
 * `subscribe(topic, onData, cursor)` starts sending a topic's events to `onData`; the function it
 * returns stops them. `cursor` says where the subscriber left off, for when the stream reconnects:
 * the topic then sends only what it missed (or starts over, with a hello that says so).
 */

type OnData = (data: any) => void;
export interface StreamSharing { channelKey: string; lockId: string }
export interface StreamState { state: "connecting" | "connected" | "reconnecting" | "offline"; lastReceived?: number; detail?: string }
let sharing: StreamSharing | undefined;
let transport: StreamState = { state: "connecting" };
const stateListeners = new Set<(state: StreamState) => void>();

/** Owner bootstrap supplies this capability before rendering anything that subscribes. */
export function configureStreamSharing(value?: StreamSharing) {
  if (role) throw new Error("Configure stream sharing before subscribing");
  sharing = value && /^[a-f0-9]{64}$/.test(value.channelKey) && /^[a-f0-9]{32}$/.test(value.lockId) ? { ...value } : undefined;
}

export function onStreamState(listener: (state: StreamState) => void): () => void {
  stateListeners.add(listener); listener(transport);
  return () => { stateListeners.delete(listener); };
}

function connection(state: StreamState) {
  transport = typeof navigator !== "undefined" && navigator.onLine === false ? { ...state, state: "offline" } : state;
  for (const listener of stateListeners) listener(transport);
  if (role === "leader") shared?.postMessage({ kind: "state", state: transport } satisfies Shared);
}
interface Sub {
  topic: string;
  onData: OnData;
  cursor?: () => string | undefined;
}
/** What the stream carries: this window's subscriptions and, in the window that holds it, other windows'. */
interface Wired {
  topic: string;
  cursor: () => string | undefined;
  deliver: OnData;
}

/** This window's own subscriptions. */
const subs = new Map<number, Sub>();
let nextId = 1;
/**
 * solo: the stream is this window's alone. follower: another window holds it. leader: this window
 * holds it for all of them.
 */
let role: "solo" | "follower" | "leader" | undefined;

export function subscribe(topic: string, onData: OnData, cursor?: () => string | undefined): () => void {
  role ?? share();
  const id = nextId++;
  const sub = { topic, onData, cursor };
  subs.set(id, sub);
  if (role === "follower") announce();
  else serve(id, { topic, cursor: () => cursor?.(), deliver: onData });
  return () => {
    if (!subs.delete(id)) return;
    if (role === "follower") announce();
    else unserve(id);
  };
}

// ---------------------------------------------------------------- the stream itself (solo or leader)
const wire = new Map<number, Wired>();
/** The subscriptions the server has on this stream (or is being sent). */
let onServer = new Set<number>();
/** Topics the server couldn't send (it said why): not asked for again on this stream. */
const refused = new Set<number>();
let source: EventSource | undefined;
/** The stream's id on the server, from its hello: subscriptions change with it. */
let client = "";
let syncing = false;
let syncQueued = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let opening = false;
let reconnectVersion = 0;

function serve(id: number, wired: Wired) {
  wire.set(id, wired);
  if (source || retry) return scheduleSync();
  // Opened once this task is done, with everything subscribed in it (a page's first render).
  if (opening) return;
  opening = true;
  queueMicrotask(() => {
    opening = false;
    if (!source && !retry) connect();
  });
}

function unserve(id: number) {
  if (!wire.delete(id)) return;
  refused.delete(id);
  scheduleSync();
}

function request(id: number, wired: Wired) {
  const after = wired.cursor();
  return after ? { id, topic: wired.topic, after } : { id, topic: wired.topic };
}

function connect() {
  reconnectVersion++;
  clearTimeout(retry);
  retry = undefined;
  source?.close();
  client = "";
  refused.clear();
  if (!wire.size) {
    source = undefined;
    return;
  }
  connection({ ...transport, state: failures ? "reconnecting" : "connecting" });
  const initial = [...wire].map(([id, wired]) => request(id, wired));
  onServer = new Set(initial.map((s) => s.id));
  const es = new EventSource(apiPath(`/api/stream?subs=${encodeURIComponent(JSON.stringify(initial))}`));
  source = es;
  es.onmessage = (msg) => {
    if (source !== es) return;
    let message: { s: number; d: any };
    try { message = JSON.parse(msg.data); } catch { return; }
    if (!message || !Number.isSafeInteger(message.s) || message.s < 0 || !message.d || typeof message.d !== "object") return;
    const { s, d } = message;
    connection({ state: "connected", lastReceived: Date.now() });
    if (s === 0) {
      if (d?.type === "hello") {
        client = d.client;
        failures = 0;
        scheduleSync(); // what changed while it was opening
      }
      return;
    }
    // The server dropped a topic it couldn't send; the subscriber hears why.
    if (d?.type === "error") {
      onServer.delete(s);
      refused.add(s);
    }
    // A subscription dropped here may still get a message or two on its way: ignored.
    wire.get(s)?.deliver(d);
  };
  // Whatever closed it (code-flow restarted, the network dropped, the laptop slept): a new stream,
  // opened with every subscription where it left off. Not the browser's own reconnect, which would
  // reopen the address it started with, and so what was watched back then.
  es.onerror = () => {
    if (source !== es) return;
    reconnect();
  };
}

function reconnect(immediate = false) {
  const version = ++reconnectVersion;
  source?.close();
  source = undefined;
  client = "";
  connection({ ...transport, state: "reconnecting", detail: "The live-update connection closed. Retrying…" });
  clearTimeout(retry);
  const wait = [500, 1_000, 2_000, 5_000][Math.min(failures++, 3)]!;
  const probe = async () => {
    const signal = AbortSignal.timeout(10_000);
    try {
      if (sharing) {
        const identity = await api<{ kind: string; streamSharing?: StreamSharing }>("/api/auth/self", { signal });
        if (version !== reconnectVersion) return;
        // Cookies are shared between tabs. A role switch or owner recovery must leave the old
        // broker group rather than reconnect it with a different browser identity.
        if (identity.kind !== "owner" || identity.streamSharing?.channelKey !== sharing.channelKey || identity.streamSharing?.lockId !== sharing.lockId) { location.reload(); return; }
      }
      // Diagnostics can fail independently of the feed. Let the stream itself establish liveness.
      if (version !== reconnectVersion) return;
      connect();
    } catch (error) {
      if (version !== reconnectVersion) return;
      connection({ ...transport, state: "reconnecting", detail: signal.aborted ? "Could not reconnect: the identity check timed out. Retrying…" : `Could not reconnect: ${(error as Error).message.slice(0, 240)}` });
      retry = setTimeout(() => void probe(), 5_000);
    }
  };
  retry = setTimeout(() => void probe(), immediate ? 0 : wait);
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    void sync();
  });
}

/** Send the server what changed: subscriptions added and dropped since it last heard. One request at a time. */
async function sync() {
  if (syncing || !client) return;
  const add = [...wire].filter(([id]) => !onServer.has(id) && !refused.has(id));
  const drop = [...onServer].filter((id) => !wire.has(id));
  if (!add.length && !drop.length) return;
  syncing = true;
  const forClient = client;
  for (const [id] of add) onServer.add(id);
  for (const id of drop) onServer.delete(id);
  try {
    await post(`/api/stream/${forClient}`, { subscribe: add.map(([id, wired]) => request(id, wired)), unsubscribe: drop });
  } catch (err) {
    // The stream is gone on the server (or code-flow is): start a new one with everything.
    const status = err instanceof ApiError ? err.status : 0;
    if (client === forClient && (status === 0 || status === 404 || status >= 500)) reconnect();
  } finally {
    syncing = false;
    // A replacement stream may have opened while this request was pending.
    if (client) scheduleSync();
  }
}

// ---------------------------------------------------------------- one stream for every window
const PREFIX = "codeflow-stream";
let channelName = "";
let lockName = "";
const WINDOW = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
/** Followers say what they watch this often (so a window that vanished without a word is dropped). */
const HEARTBEAT_MS = 15_000;
/** Every window's channel, and this window's own, for the events of what it watches. */
let shared: BroadcastChannel | undefined;
/** Leader: the other windows, what they watch (their ids → the stream's) and where each left off. */
const windows = new Map<string, { ids: Map<number, number>; cursors: Map<number, string | undefined>; seen: number; out: BroadcastChannel }>();

type Shared = { kind: "leader"; state: StreamState } | { kind: "state"; state: StreamState } | { kind: "subs"; window: string; subs: [number, string, string | undefined][] } | { kind: "bye"; window: string };

function share() {
  window.addEventListener("offline", () => connection({ ...transport, state: "offline" }));
  window.addEventListener("online", () => { connection({ ...transport, state: "reconnecting" }); if (role === "follower") announce(); else if (wire.size) reconnect(true); });
  // Static channel names let a shared-role tab impersonate a window and read owner events.
  // Web Lock names are enumerable, so the channel capability is distinct from every lock ID.
  if (!sharing || typeof BroadcastChannel !== "function" || typeof navigator === "undefined" || !navigator.locks?.request) {
    role = "solo";
    return;
  }
  channelName = `${PREFIX}:${sharing.channelKey}`;
  lockName = `${PREFIX}:${sharing.lockId}`;
  role = "follower";
  shared = new BroadcastChannel(channelName);
  const mine = new BroadcastChannel(`${channelName}:${WINDOW}`);
  mine.onmessage = (e: MessageEvent<{ s: number; d: any }>) => {
    if (e.data.s === 0 && e.data.d?.type === "transport") connection(e.data.d.state);
    else subs.get(e.data.s)?.onData(e.data.d);
  };
  shared.onmessage = (e: MessageEvent<Shared>) => {
    const m = e.data;
    if (m.kind === "leader") {
      connection(m.state);
      if (role === "follower") announce(); // a new leader: tell it what this window watches
    } else if (m.kind === "state") {
      if (role === "follower") connection(m.state);
    } else if (role === "leader") {
      adopt(m.window, m.kind === "subs" ? m.subs : []);
    }
  };
  void navigator.locks.request(lockName, () => {
    lead();
    return new Promise<never>(() => {}); // held for as long as this window is open
  });
  // A lock of this window's own, held while it's open: the window holding the stream waits for it,
  // so it hears at once when this one closes, or crashes.
  void navigator.locks.request(`${lockName}:${WINDOW}`, () => new Promise<never>(() => {}));
  window.addEventListener("pagehide", () => role === "follower" && shared?.postMessage({ kind: "bye", window: WINDOW } satisfies Shared));
  setInterval(() => {
    if (role === "follower") announce();
    else if (role === "leader") for (const [id, w] of windows) if (Date.now() - w.seen > HEARTBEAT_MS * 3) adopt(id, []);
  }, HEARTBEAT_MS);
}

/** This window took the lock: it holds the stream now, for itself and the others. */
function lead() {
  role = "leader";
  for (const [id, sub] of subs) wire.set(id, { topic: sub.topic, cursor: () => sub.cursor?.(), deliver: sub.onData });
  reconnect(true); // A promoted follower must validate its broker capability before forwarding.
  shared!.postMessage({ kind: "leader", state: transport } satisfies Shared);
}

let announcing = false;
/** Follower: tell the window that holds the stream everything this one watches, and where each left off. */
function announce() {
  if (announcing) return;
  announcing = true;
  queueMicrotask(() => {
    announcing = false;
    if (role !== "follower") return;
    shared!.postMessage({ kind: "subs", window: WINDOW, subs: [...subs].map(([id, sub]) => [id, sub.topic, sub.cursor?.()]) } satisfies Shared);
  });
}

/** Leader: what another window watches now, in place of what it watched before. */
function adopt(window: string, list: [number, string, string | undefined][]) {
  let w = windows.get(window);
  if (!w) {
    if (!list.length) return;
    w = { ids: new Map(), cursors: new Map(), seen: 0, out: new BroadcastChannel(`${channelName}:${window}`) };
    windows.set(window, w);
    // Granted once that window is gone (see share).
    void navigator.locks.request(`${lockName}:${window}`, () => windows.get(window) === w && adopt(window, []));
  }
  const theirs = w;
  theirs.out.postMessage({ s: 0, d: { type: "transport", state: transport } });
  theirs.seen = Date.now();
  const want = new Map(list.map(([id, topic, after]) => [id, { topic, after }]));
  for (const [id, wired] of theirs.ids) {
    if (want.has(id)) continue;
    theirs.ids.delete(id);
    theirs.cursors.delete(id);
    unserve(wired);
  }
  for (const [id, { topic, after }] of want) {
    theirs.cursors.set(id, after);
    if (theirs.ids.has(id)) continue;
    const wired = nextId++;
    theirs.ids.set(id, wired);
    serve(wired, { topic, cursor: () => theirs.cursors.get(id), deliver: (d) => theirs.out.postMessage({ s: id, d }) });
  }
  if (!theirs.ids.size) {
    theirs.out.close();
    windows.delete(window);
  }
}
