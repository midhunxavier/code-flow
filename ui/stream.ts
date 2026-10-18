import { api, ApiError, post } from "./lib.js";

/**
 * This window's one event stream (see src/stream.ts), for everything it watches: the run list, the
 * runs it shows, its terminals. A browser has 6 connections per host for all its tabs, and an event
 * stream holds one while it's open, so a stream per feature ran out of them; requests then waited
 * forever. Here a window opens one, and subscribing or unsubscribing is a short request.
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

let nextId = 1;
const subs = new Map<number, Sub>();
/** The subscriptions the server has on this stream (or is being sent). */
let onServer = new Set<number>();
let source: EventSource | undefined;
/** The stream's id on the server, from its hello: subscriptions change with it. */
let client = "";
let syncing = false;
let syncQueued = false;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

export function subscribe(topic: string, onData: OnData, cursor?: () => string | undefined): () => void {
  const id = nextId++;
  subs.set(id, { topic, onData, cursor });
  if (!source && !retry) connect();
  else scheduleSync();
  return () => {
    if (!subs.delete(id)) return;
    scheduleSync();
  };
}

function request(id: number, sub: Sub) {
  const after = sub.cursor?.();
  return after ? { id, topic: sub.topic, after } : { id, topic: sub.topic };
}

function connect() {
  clearTimeout(retry);
  retry = undefined;
  source?.close();
  client = "";
  if (!subs.size) {
    source = undefined;
    return;
  }
  const initial = [...subs].map(([id, sub]) => request(id, sub));
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
    // The server dropped a topic it couldn't send (it says why to the subscriber).
    if (d?.type === "error") onServer.delete(s);
    // A subscription dropped here may still get a message or two on its way: ignored.
    subs.get(s)?.onData(d);
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
  const add = [...subs].filter(([id]) => !onServer.has(id));
  const drop = [...onServer].filter((id) => !subs.has(id));
  if (!add.length && !drop.length) return;
  syncing = true;
  const forClient = client;
  for (const [id] of add) onServer.add(id);
  for (const id of drop) onServer.delete(id);
  try {
    await post(`/api/stream/${forClient}`, { subscribe: add.map(([id, sub]) => request(id, sub)), unsubscribe: drop });
  } catch (err) {
    // The stream is gone on the server (or code-flow is): start a new one with everything.
    const status = err instanceof ApiError ? err.status : 0;
    if (client === forClient && (status === 0 || status === 404 || status >= 500)) reconnect();
  } finally {
    syncing = false;
    if (client === forClient) scheduleSync();
  }
}
