import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the real feed with deterministic HTTP/SSE interleavings. Private entry
// points are exposed only in this in-memory test bundle, not the shipped browser.
const source = await readFile(new URL("../ui/run-feed.ts", import.meta.url), "utf8");
const bundle = await build({ stdin: { contents: source + "\nexport { feedFor, receive };", resolveDir: fileURLToPath(new URL("../ui", import.meta.url)), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "esm" });
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: () => void) => { callback(); return 1; } });
const { feedFor, receive, loadStepTranscript } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`);
const event = (id: string, seq: number) => ({ type: "agent", runId: id, stepId: "step", seq, ts: seq, event: { kind: "text", text: `event ${seq}` } });
const pending = () => {
  let respond!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  return (body: unknown, status = 200) => respond(new Response(JSON.stringify(body), { status }));
};
const page = (id: string, seq: number) => ({ events: [event(id, seq)], latestSeq: seq, before: "older", bytes: 0, scannedBytes: 0, resumed: false });

test("failed Earlier request preserves live events received while it is pending", async () => {
  const id = "failed-earlier", feed = feedFor(id);
  receive(feed, event(id, 10));
  const respond = pending(), loading = loadStepTranscript(id, "step", "older");
  receive(feed, event(id, 11));
  respond({ error: "Temporary failure" }, 503); await loading;
  assert.deepEqual(feed.data.current.events.get("step").map((item: any) => item.text), ["event 10", "event 11"]);
  assert.equal(feed.data.current.pages.get("step").historical, false);
  assert.match(feed.data.current.pages.get("step").error, /Temporary failure/);
});

test("Latest request keeps the older view stable and merges events newer than its HTTP snapshot", async () => {
  const id = "latest-race", feed = feedFor(id);
  let respond = pending(), loading = loadStepTranscript(id, "step", "older");
  respond(page(id, 2)); await loading;
  assert.equal(feed.data.current.pages.get("step").historical, true);
  respond = pending(); loading = loadStepTranscript(id, "step");
  receive(feed, event(id, 12));
  assert.deepEqual(feed.data.current.events.get("step").map((item: any) => item.text), ["event 2"]);
  respond(page(id, 11)); await loading;
  assert.deepEqual(feed.data.current.events.get("step").map((item: any) => item.text), ["event 11", "event 12"]);
  assert.equal(feed.data.current.pages.get("step").historical, false);
});
