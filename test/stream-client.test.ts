// The UI's side of a window's one event stream (ui/stream.ts), without a browser: subscriptions
// go in the stream's address and then in batched requests, a topic the server refused isn't asked
// for again, and a stream that drops (or that the server lost) reopens with every subscription
// where it left off. Bundled the way build-ui does it, with a stand-in EventSource and fetch.
// (Sharing one stream between windows needs Web Locks: the e2e test covers it in Chrome.)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ui = fileURLToPath(new URL("../ui", import.meta.url));

class FakeSource {
  static all: FakeSource[] = [];
  onmessage?: (msg: { data: string }) => void;
  onerror?: () => void;
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  /** The server sends a message on this stream. */
  send(s: number, d: unknown) {
    this.onmessage?.({ data: JSON.stringify({ s, d }) });
  }
  get subs(): { id: number; topic: string; after?: string }[] {
    return JSON.parse(new URL(this.url, "http://x").searchParams.get("subs")!);
  }
}
const posts: { path: string; body: any }[] = [];
let postStatus = 200;
let m: { subscribe: (topic: string, onData: (d: any) => void, cursor?: () => string | undefined) => () => void };

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    addEventListener: () => {},
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/", reload: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    EventSource: FakeSource,
    fetch: async (path: string, opts: { method?: string; body?: string } = {}) => {
      if (opts.method === "POST") posts.push({ path, body: JSON.parse(opts.body ?? "{}") });
      const status = opts.method === "POST" ? postStatus : 200;
      return { ok: status < 400, status, statusText: "", json: async () => (status < 400 ? {} : { error: "That stream has closed" }) };
    },
  });
  const out = await esbuild.build({
    stdin: { contents: `export { subscribe } from "./stream.ts";`, resolveDir: ui, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-stream-client-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, what: string) => {
  for (const end = Date.now() + 5_000; !cond(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

test("one stream: subscriptions go in its address, then in one request per change; a refused topic isn't asked for again", async () => {
  const got: Record<string, any[]> = { runs: [], a: [], b: [], gone: [] };
  let cursor = "e1:5";
  const stopRuns = m.subscribe("runs", (d) => got.runs!.push(d), () => cursor);
  const stopA = m.subscribe("run:a", (d) => got.a!.push(d));
  await tick();
  assert.equal(FakeSource.all.length, 1, "one stream for both");
  const stream = FakeSource.all[0]!;
  assert.deepEqual(stream.subs, [
    { id: 1, topic: "runs", after: "e1:5" },
    { id: 2, topic: "run:a" },
  ]);
  stream.send(0, { type: "hello", client: "c1" });
  stream.send(1, { type: "hello", resumed: true });
  stream.send(2, { type: "run", seq: 1 });
  await tick();
  assert.equal(posts.length, 0, "nothing changed since it opened");
  assert.deepEqual(got.runs, [{ type: "hello", resumed: true }]);
  assert.deepEqual(got.a, [{ type: "run", seq: 1 }]);

  // Two changes at once: one request.
  m.subscribe("run:b", (d) => got.b!.push(d));
  stopA();
  await until(() => posts.length === 1, "the change");
  assert.deepEqual(posts[0], { path: "/api/stream/c1", body: { subscribe: [{ id: 3, topic: "run:b" }], unsubscribe: [2] } });
  stream.send(2, { type: "run", seq: 2 });
  assert.equal(got.a!.length, 1, "nothing for a subscription that's gone");

  // The server can't send a topic: the subscriber hears why, and it isn't asked for again.
  m.subscribe("shell:gone", (d) => got.gone!.push(d));
  await until(() => posts.length === 2, "the subscription");
  stream.send(4, { type: "error", status: 404, message: "That terminal is gone" });
  await tick();
  await tick();
  assert.equal(posts.length, 2, "no request asking for it again");
  m.subscribe("run:c", () => {});
  await until(() => posts.length === 3, "the next change");
  assert.deepEqual(posts[2]!.body, { subscribe: [{ id: 5, topic: "run:c" }], unsubscribe: [] });
  assert.equal(got.gone![0].status, 404);

  // The stream drops: a new one, with every subscription where it left off (and the refused one, once).
  cursor = "e1:9";
  stream.onerror?.();
  assert.equal(stream.closed, true);
  await until(() => FakeSource.all.length === 2, "the new stream");
  const again = FakeSource.all[1]!;
  assert.deepEqual(again.subs, [
    { id: 1, topic: "runs", after: "e1:9" },
    { id: 3, topic: "run:b" },
    { id: 4, topic: "shell:gone" },
    { id: 5, topic: "run:c" },
  ]);

  // The server lost the stream (a request about it gets a 404): a new one again.
  again.send(0, { type: "hello", client: "c2" });
  postStatus = 404;
  stopRuns();
  await until(() => FakeSource.all.length === 3, "a stream the server knows");
  postStatus = 200;
  assert.equal(again.closed, true);
  assert.deepEqual(FakeSource.all[2]!.subs.map((s) => s.topic), ["run:b", "shell:gone", "run:c"]);
});
