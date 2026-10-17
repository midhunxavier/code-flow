// Snapshot mode: a screenshot of any web page in a headless Chrome of its own. The checks on the
// request need no browser; the screenshots themselves need Chrome, Chromium or Edge, and are
// skipped without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { findChrome, SnapshotError, snapshotUrl, takeSnapshot } from "../src/snapshot.js";

const chrome = findChrome();
const png = (b64: string) => {
  const buf = Buffer.from(b64, "base64");
  return { signature: buf.subarray(1, 4).toString(), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};
async function page(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

test("snapshot requests: http(s) only, a sensible width, and a clear word when there's no Chrome", async () => {
  assert.equal(snapshotUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "not a url"]) {
    assert.throws(() => snapshotUrl(bad), (e: unknown) => e instanceof SnapshotError && e.status === 400, bad);
  }
  await assert.rejects(takeSnapshot({ url: "https://example.com/", width: 100 }), (e: unknown) => e instanceof SnapshotError && e.status === 400 && /width/.test(e.message));
  assert.equal(findChrome({ CODEFLOW_CHROME: "/no/such/chrome" }), undefined, "a CODEFLOW_CHROME that isn't there isn't used");
});

test("a snapshot at a phone width, and a full-page one as tall as the page", { skip: !chrome && "no Chrome, Chromium or Edge here" }, async () => {
  const { server, url } = await page('<html><head><title>Snap</title></head><body style="margin:0"><div style="height:1800px;background:#cde">tall</div></body></html>');
  try {
    const view = await takeSnapshot({ url, width: 390 });
    assert.deepEqual([view.width, view.title, view.url], [390, "Snap", url]);
    assert.deepEqual(png(view.image), { signature: "PNG", width: 390, height: view.height });
    assert.ok(view.height < 1800, "just the viewport");
    const full = await takeSnapshot({ url, width: 390, full: true });
    assert.ok(full.height >= 1800, `the whole page: ${full.height}px`);
    assert.equal(png(full.image).height, full.height);
  } finally {
    server.close();
  }
});

test("snapshots take turns, and a page that can't be reached says so", { skip: !chrome && "no Chrome, Chromium or Edge here" }, async () => {
  const { server, url } = await page("<title>A</title>");
  try {
    const [a, b] = await Promise.all([takeSnapshot({ url, width: 800 }), takeSnapshot({ url, width: 600 })]);
    assert.deepEqual([a.width, b.width], [800, 600]);
  } finally {
    server.close();
  }
  await assert.rejects(takeSnapshot({ url: "http://127.0.0.1:9/", width: 800 }), (e: unknown) => e instanceof SnapshotError && /Couldn't open/.test(e.message));
});
