import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
const home = mkdtempSync(join(tmpdir(), "codeflow-replay-home-")); process.env.CODEFLOW_HOME = home;
const { takeSnapshot, findChrome } = await import("../src/snapshot.js");
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
test("real browser replays form interactions, retains a walkthrough and fails a wrong assertion", { timeout: 60_000, skip: !findChrome() }, async () => {
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><label>Name<input id="name"></label><button id="go" onclick="document.querySelector('#result').innerText='Hello '+document.querySelector('#name').value">Greet</button><div id="result">Waiting</div></body></html>`));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const journey = { id: "fixture", repo: "/repo", title: "Greeting", url, width: 800, createdAt: 1, actions: [{ kind: "fill" as const, selector: "#name", value: "Ada" }, { kind: "click" as const, selector: "#go" }], expected: { selector: "#result", text: "Hello Ada" } };
  try {
    const policy = { localApp: (value: URL) => value.origin === new URL(url).origin, documentOrigin: new URL(url).origin };
    const good = await takeSnapshot({ url, width: 800, journey }, policy);
    assert.equal(good.replay?.status, "passed", good.replay?.error); assert.equal(good.replay?.frames.length, 4); assert.match(good.replay!.frames[0]!.image, /^data:image\/jpeg;base64,/);
    const bad = await takeSnapshot({ url, width: 800, journey: { ...journey, expected: { selector: "#result", text: "Not the greeting" } } }, policy);
    assert.equal(bad.replay?.status, "failed"); assert.equal(bad.replay?.failedAt, 2); assert.match(bad.replay!.error!, /Expected visible text/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
