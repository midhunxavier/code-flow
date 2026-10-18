import { randomBytes } from "node:crypto";

/**
 * One event stream per browser window, for everything the window watches: the run list, the run
 * it shows, a side chat's run, each terminal. A browser allows only 6 connections per host over
 * HTTP/1.1, shared by all its tabs, and an event stream holds one for as long as it's open: a
 * stream per feature filled them with a couple of tabs and a split terminal, and every request
 * after that waited forever. So a window opens one stream and subscribes to topics on it:
 *
 * - `GET /api/stream?subs=[{id, topic, after?}]` opens it with what the window watches already.
 *   Its first message is `{s: 0, d: {type: "hello", client}}`: the id to change subscriptions with.
 * - `POST /api/stream/<client>` with `{subscribe: [{id, topic, after?}], unsubscribe: [id]}`
 *   changes them while it's open.
 * - Every message is `{s: <subscription id>, d: <the topic's event>}`. The window picks the ids,
 *   new for every subscription, so a message for one it dropped is simply ignored. A topic that
 *   can't be watched (a run that doesn't exist, a terminal that's gone) sends
 *   `{type: "error", status, message}` and is dropped.
 *
 * `after` is where a window left off in that topic (a cursor the topic gave it), so a window that
 * reconnects is sent only what it missed.
 */

/** Sends one of a topic's events; `seq` numbers it (the older per-feature streams send it as the event's id). */
export type Deliver = (data: unknown, seq?: number) => void;
/** Starts a topic: sends what the window needs first, then its live events. Returns how to stop. */
export type TopicSource = (name: string, after: string | undefined, deliver: Deliver) => (() => void) | Promise<() => void>;

/** A topic that can't be watched; the window gets the status and the message. */
export class TopicError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SubRequest {
  id: number;
  topic: string;
  after?: string;
}

interface Sub {
  topic: string;
  stop?: () => void;
  dropped: boolean;
}

interface Client {
  id: string;
  send: (message: unknown) => void;
  subs: Map<number, Sub>;
  closed: boolean;
}

/** Subscriptions per stream: a window watches a handful (the run list, a run or two, terminals). */
const MAX_SUBS = 64;

export class StreamHub {
  private clients = new Map<string, Client>();

  constructor(private sources: Record<string, TopicSource>) {}

  /** A stream opened: `send` writes to it. Returns its client id; call `close` when it ends. */
  open(send: (message: unknown) => void, subs: unknown): string {
    const client: Client = { id: randomBytes(12).toString("hex"), send, subs: new Map(), closed: false };
    this.clients.set(client.id, client);
    send({ s: 0, d: { type: "hello", client: client.id } });
    this.update(client.id, { subscribe: subs });
    return client.id;
  }

  close(id: string) {
    const client = this.clients.get(id);
    if (!client) return;
    client.closed = true;
    this.clients.delete(id);
    for (const sub of client.subs.values()) this.stop(sub);
    client.subs.clear();
  }

  /** Change a stream's subscriptions; false when there's no such stream (it closed). */
  update(id: string, change: { subscribe?: unknown; unsubscribe?: unknown }): boolean {
    const client = this.clients.get(id);
    if (!client) return false;
    for (const subId of Array.isArray(change.unsubscribe) ? change.unsubscribe : []) {
      const sub = client.subs.get(subId);
      if (!sub) continue;
      client.subs.delete(subId);
      this.stop(sub);
    }
    for (const req of Array.isArray(change.subscribe) ? change.subscribe : []) void this.subscribe(client, req);
    return true;
  }

  /** Open streams and their subscriptions, for tests and health. */
  get stats() {
    return { streams: this.clients.size, subscriptions: [...this.clients.values()].reduce((n, c) => n + c.subs.size, 0) };
  }

  private async subscribe(client: Client, req: unknown) {
    const { id, topic, after } = (req ?? {}) as Partial<SubRequest>;
    if (!Number.isInteger(id) || id! < 1 || typeof topic !== "string" || topic.length > 200 || client.subs.has(id!)) return;
    const fail = (status: number, message: string) => client.send({ s: id, d: { type: "error", status, message } });
    if (after !== undefined && (typeof after !== "string" || after.length > 100)) return fail(400, "That cursor isn't one code-flow gave out");
    if (client.subs.size >= MAX_SUBS) return fail(429, `A window watches at most ${MAX_SUBS} things at once`);
    const colon = topic.indexOf(":");
    const [kind, name] = colon < 0 ? [topic, ""] : [topic.slice(0, colon), topic.slice(colon + 1)];
    const source = Object.hasOwn(this.sources, kind) ? this.sources[kind] : undefined;
    if (!source) return fail(404, `Nothing to watch called “${kind}”`);
    const sub: Sub = { topic, dropped: false };
    client.subs.set(id!, sub);
    const deliver: Deliver = (d) => {
      if (!sub.dropped && !client.closed) client.send({ s: id, d });
    };
    try {
      const stop = await source(name, after, deliver);
      // Unsubscribed (or the stream closed) while it was starting.
      if (sub.dropped || client.closed) stop();
      else sub.stop = stop;
    } catch (err) {
      if (client.subs.get(id!) === sub) client.subs.delete(id!);
      if (sub.dropped || client.closed) return;
      sub.dropped = true;
      if (err instanceof TopicError) fail(err.status, err.message);
      else fail(500, (err as Error).message);
    }
  }

  private stop(sub: Sub) {
    sub.dropped = true;
    try {
      sub.stop?.();
    } catch {
      // already gone
    }
  }
}

/** The sequence number in a cursor (`<epoch>:<seq>`, as event ids are), if it's from this server start. */
export function cursorSeq(cursor: string | undefined, epoch: string): number | undefined {
  const [from, seq] = String(cursor ?? "").split(":");
  const n = Number(seq);
  return from === epoch && seq !== "" && seq !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
