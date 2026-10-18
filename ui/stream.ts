import { api, ApiError, post } from "./lib.js";

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
  clearTimeout(retry);
  retry = undefined;
  source?.close();
  client = "";
  refused.clear();
  if (!wire.size) {
    source = undefined;
    return;
  }
  const initial = [...wire].map(([id, wired]) => request(id, wired));
  onServer = new Set(initial.map((s) => s.id));
  const es = new EventSource(`/api/stream?subs=${encodeURIComponent(JSON.stringify(initial))}`);
  source = es;
  es.onmessage = (msg) => {
    const { s, d } = JSON.parse(msg.data) as { s: number; d: any };
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

function reconnect() {
  source?.close();
  source = undefined;
  client = "";
  clearTimeout(retry);
  const wait = [500, 1_000, 2_000, 5_000][Math.min(failures++, 3)]!;
  retry = setTimeout(() => {
    // Find out first whether code-flow is there, and this browser still signed in (a 401 reloads).
    api("/api/health").then(connect, () => {
      retry = setTimeout(connect, 5_000);
    });
  }, wait);
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
    if (client === forClient) scheduleSync();
  }
}

// ---------------------------------------------------------------- one stream for every window
const CHANNEL = "codeflow-stream";
const WINDOW = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
/** Followers say what they watch this often (so a window that vanished without a word is dropped). */
const HEARTBEAT_MS = 15_000;
/** Every window's channel, and this window's own, for the events of what it watches. */
let shared: BroadcastChannel | undefined;
/** Leader: the other windows, what they watch (their ids → the stream's) and where each left off. */
const windows = new Map<string, { ids: Map<number, number>; cursors: Map<number, string | undefined>; seen: number; out: BroadcastChannel }>();

type Shared = { kind: "leader" } | { kind: "subs"; window: string; subs: [number, string, string | undefined][] } | { kind: "bye"; window: string };

function share() {
  if (typeof BroadcastChannel !== "function" || !navigator.locks?.request) {
    role = "solo";
    return;
  }
  role = "follower";
  shared = new BroadcastChannel(CHANNEL);
  const mine = new BroadcastChannel(`${CHANNEL}:${WINDOW}`);
  mine.onmessage = (e: MessageEvent<{ s: number; d: unknown }>) => subs.get(e.data.s)?.onData(e.data.d);
  shared.onmessage = (e: MessageEvent<Shared>) => {
    const m = e.data;
    if (m.kind === "leader") {
      if (role === "follower") announce(); // a new leader: tell it what this window watches
    } else if (role === "leader") {
      adopt(m.window, m.kind === "subs" ? m.subs : []);
    }
  };
  void navigator.locks.request(CHANNEL, () => {
    lead();
    return new Promise<never>(() => {}); // held for as long as this window is open
  });
  addEventListener("pagehide", () => role === "follower" && shared?.postMessage({ kind: "bye", window: WINDOW } satisfies Shared));
  setInterval(() => {
    if (role === "follower") announce();
    else if (role === "leader") for (const [id, w] of windows) if (Date.now() - w.seen > HEARTBEAT_MS * 3) adopt(id, []);
  }, HEARTBEAT_MS);
}

/** This window took the lock: it holds the stream now, for itself and the others. */
function lead() {
  role = "leader";
  for (const [id, sub] of subs) wire.set(id, { topic: sub.topic, cursor: () => sub.cursor?.(), deliver: sub.onData });
  connect();
  shared!.postMessage({ kind: "leader" } satisfies Shared);
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
    w = { ids: new Map(), cursors: new Map(), seen: 0, out: new BroadcastChannel(`${CHANNEL}:${window}`) };
    windows.set(window, w);
  }
  const theirs = w;
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
