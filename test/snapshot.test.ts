// Snapshot mode: a screenshot of any web page in a headless Chrome of its own. The checks on the
// request need no browser; the screenshots themselves need Chrome, Chromium, Edge or Brave, and are
// skipped without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

// Snapshots track their Chrome with the server's process groups: keep those, and Chrome's profiles,
// out of the real ~/.codeflow and temp folder.
const home = mkdtempSync(join(tmpdir(), "codeflow-test-snapshot-home-"));
const temp = mkdtempSync(join(tmpdir(), "codeflow-test-snapshot-tmp-"));
process.env.CODEFLOW_HOME = home;
process.env.TMPDIR = temp;
const { findChrome, SnapshotError, snapshotUrl, takeSnapshot } = await import("../src/snapshot.js");
// After the process groups' own exit hook (registered by that import), which writes into the home.
process.once("exit", () => {
  for (const dir of [home, temp]) rmSync(dir, { recursive: true, force: true });
});

const chrome = findChrome();
const noChrome = !chrome && "no Chrome, Chromium, Edge or Brave here";

/** A PNG's size and pixels (8-bit RGB or RGBA, not interlaced: what Chrome writes). */
function decode(b64: string) {
  const buf = Buffer.from(b64, "base64");
  assert.equal(buf.subarray(1, 4).toString(), "PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
      assert.equal(data[8], 8, "8 bits per channel");
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert.ok(channels, `colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const corner = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      const add = [0, left, up, (left + up) >> 1, paeth][filter]!;
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + add) & 255;
    }
  }
  const px = (x: number, y: number) => [...out.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
  return { width, height, px };
}
const near = (actual: number[], expected: number[], what: string) =>
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]!) <= 12), `${what}: ${actual} is not ${expected}`);
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}
const page = (html: string) => serve((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));

test("snapshot requests: http(s) only, a sensible size, and a clear word when there's no Chrome", async () => {
  assert.equal(snapshotUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "not a url"]) {
    assert.throws(() => snapshotUrl(bad), (e: unknown) => e instanceof SnapshotError && e.status === 400, bad);
  }
  await assert.rejects(takeSnapshot({ url: "https://example.com/", width: 100 }), (e: unknown) => e instanceof SnapshotError && e.status === 400 && /width/.test(e.message));
  await assert.rejects(takeSnapshot({ url: "https://example.com/", width: 800, height: Number("tall") }), (e: unknown) => e instanceof SnapshotError && e.status === 400 && /height/.test(e.message));
  assert.equal(findChrome({ CODEFLOW_CHROME: "/no/such/chrome" }), undefined, "a CODEFLOW_CHROME that isn't there isn't used");
  assert.equal(findChrome({ CODEFLOW_CHROME: tmpdir() }), undefined, "nor one that's a folder (an .app bundle, say)");
});

test("a snapshot of the viewport, and a whole-page one that has all of the page", { skip: noChrome }, async () => {
  const bands = `<div style="height:600px;background:#f00"></div><div style="height:600px;background:#0f0"></div><div style="height:600px;background:#00f"></div>`;
  const { server, url } = await page(`<html><head><title>Snap</title><meta name="viewport" content="width=device-width"></head><body style="margin:0">${bands}</body></html>`);
  try {
    const view = await takeSnapshot({ url, width: 390, height: 700 });
    assert.deepEqual([view.width, view.height, view.title, view.url], [390, 700, "Snap", url]);
    const shown = decode(view.image);
    assert.deepEqual([shown.width, shown.height], [390, 700]);
    near(shown.px(195, 300), RED, "the top of the viewport");
    near(shown.px(195, 650), GREEN, "the bottom of the viewport");

    const full = await takeSnapshot({ url, width: 390, height: 700, full: true });
    const whole = decode(full.image);
    assert.deepEqual([whole.width, whole.height], [full.width, full.height]);
    assert.deepEqual([full.width, full.height], [390, 1800]);
    near(whole.px(195, 300), RED, "the first band");
    near(whole.px(195, 900), GREEN, "the second band");
    near(whole.px(195, 1790), BLUE, "the last band, below the viewport");
  } finally {
    server.close();
  }
});

test("a whole-page snapshot at phone width of a page made for desktops is the zoomed-out page a phone shows", { skip: noChrome }, async () => {
  // No viewport tag: a phone lays it out 980px wide and zooms out to fit.
  const half = (colour: string) => `<div style="width:490px;height:3000px;background:${colour}"></div>`;
  const { server, url } = await page(`<html><body style="margin:0;width:980px;display:flex">${half("#f00")}${half("#00f")}</body></html>`);
  try {
    const full = await takeSnapshot({ url, width: 390, height: 844, full: true });
    const whole = decode(full.image);
    assert.deepEqual([whole.width, whole.height], [full.width, full.height]);
    assert.ok(Math.abs(full.width - 390) <= 1, `as wide as the phone: ${full.width}`);
    assert.ok(full.height > 844, `taller than the screen: ${full.height}`);
    near(whole.px(10, 100), RED, "the left half");
    near(whole.px(full.width - 10, 100), BLUE, "the right half, not cut off");
    near(whole.px(full.width - 10, full.height - 10), BLUE, "the bottom right");
  } finally {
    server.close();
  }
});

test("snapshots take turns: one Chrome at a time", { skip: noChrome }, async () => {
  let open = 0;
  let most = 0;
  const { server, url } = await serve((req, res) => {
    if (req.url !== "/") return void res.writeHead(404).end();
    most = Math.max(most, ++open);
    setTimeout(() => {
      open--;
      res.writeHead(200, { "content-type": "text/html" }).end("<title>A</title>");
    }, 300);
  });
  try {
    const [a, b] = await Promise.all([takeSnapshot({ url, width: 800 }), takeSnapshot({ url, width: 600 })]);
    assert.deepEqual([a.width, b.width], [800, 600]);
    assert.equal(most, 1, "the second waited for the first");
  } finally {
    server.close();
  }
});

test("a page that can't be reached, an alert(), and a Chrome that dies each end the snapshot, and the next one still works", { skip: noChrome }, async () => {
  await assert.rejects(takeSnapshot({ url: "http://127.0.0.1:9/", width: 800 }), (e: unknown) => e instanceof SnapshotError && e.status === 502 && /Couldn't open/.test(e.message));

  const { server, url } = await page("<title>Hello</title><p>hi</p><script>alert('welcome'); confirm('sure?')</script>");
  try {
    const started = Date.now();
    const shot = await takeSnapshot({ url, width: 800 });
    assert.equal(shot.title, "Hello");
    assert.ok(Date.now() - started < 15_000, `the dialogs were answered, not waited out: ${Date.now() - started}ms`);
  } finally {
    server.close();
  }

  if (process.platform !== "win32") {
    const dir = mkdtempSync(join(temp, "fake-chrome-"));
    const fake = join(dir, "chrome");
    writeFileSync(fake, "#!/bin/sh\necho 'fake chrome dying' >&2\nexit 3\n");
    chmodSync(fake, 0o755);
    process.env.CODEFLOW_CHROME = fake;
    try {
      const started = Date.now();
      await assert.rejects(takeSnapshot({ url: "https://example.com/", width: 800 }), (e: unknown) => e instanceof SnapshotError && e.status === 502 && /exit 3/.test(e.message));
      assert.ok(Date.now() - started < 10_000, `said so at once: ${Date.now() - started}ms`);
    } finally {
      delete process.env.CODEFLOW_CHROME;
    }
  }
  const again = await page("<title>Again</title>");
  try {
    assert.equal((await takeSnapshot({ url: again.url, width: 600 })).title, "Again");
  } finally {
    again.server.close();
  }
});

test("each snapshot's Chrome profile is gone afterwards", { skip: noChrome }, () => {
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("codeflow-snapshot-")), []);
});
