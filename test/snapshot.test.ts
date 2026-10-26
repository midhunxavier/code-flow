// Snapshot mode: a screenshot of any web page in a headless Chrome of its own. The checks on the
// request need no browser; the screenshots themselves need Chrome, Chromium, Edge or Brave, and are
// skipped without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const { addressKind, findChrome, refusal, SnapshotError, snapshotUrl, takeSnapshot } = await import("../src/snapshot.js");
type SnapshotRequest = import("../src/snapshot.js").SnapshotRequest;
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
/**
 * These tests' pages are on 127.0.0.1, which snapshots keep away from unless it's a local app the
 * Browser shows (the server says which): here, any http://127.0.0.1 address is one.
 */
const snap = (request: SnapshotRequest) => takeSnapshot(request, { localApp: (u) => u.protocol === "http:" && u.hostname === "127.0.0.1" });
const refused = (status: number, message: RegExp) => (e: unknown) => e instanceof SnapshotError && e.status === status && message.test(e.message);

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

test("snapshots keep away from this computer and link-local addresses, every address a name has; private networks are fine", async () => {
  for (const ip of ["127.0.0.1", "127.8.9.10", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::1]"]) assert.equal(addressKind(ip), "loopback", ip);
  for (const ip of ["169.254.169.254", "169.254.0.1", "fe80::1", "fe80::1%en0", "febf::1", "fd00:ec2::254", "::ffff:169.254.169.254"]) assert.equal(addressKind(ip), "link-local", ip);
  for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.3.4", "100.64.0.1", "fd12:3456::1", "8.8.8.8", "2606:4700::1111", "::ffff:192.168.1.20"]) assert.equal(addressKind(ip), undefined, ip);

  // Refused before any Chrome starts: there's none here, and the answer is still 403, not 501.
  const previousChrome = process.env.CODEFLOW_CHROME;
  process.env.CODEFLOW_CHROME = "/no/such/chrome";
  try {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1:9/",
      "http://[::1]:8080/",
      "http://0.0.0.0/",
      "http://2130706433/", // 127.0.0.1, written as a number
      "http://[::ffff:127.0.0.1]/",
      "http://app.localhost/", // Chrome answers *.localhost itself
      "https://localhost./",
    ]) {
      await assert.rejects(takeSnapshot({ url, width: 800 }), refused(403, /is this computer, and snapshots don't open those\. Only a running local app at an allowed http:\/\/localhost:<port> address can be captured/), url);
    }
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/"]) {
      await assert.rejects(takeSnapshot({ url, width: 800 }), refused(403, /is a link-local address \(where cloud machines keep their metadata service\)/), url);
    }
    // A local app the server vouches for is let through (here to the missing Chrome); code-flow's own port isn't one.
    const localApp = (u: URL) => u.hostname === "localhost" && u.port !== "4317";
    await assert.rejects(takeSnapshot({ url: "http://localhost:5173/", width: 800 }, { localApp }), refused(501, /need Google Chrome/));
    await assert.rejects(takeSnapshot({ url: "http://localhost:4317/", width: 800 }, { localApp }), refused(403, /localhost:4317 is this computer/));
  } finally {
    if (previousChrome === undefined) delete process.env.CODEFLOW_CHROME;
    else process.env.CODEFLOW_CHROME = previousChrome;
  }

  // A host name is checked by every address it has, not just the first.
  const names: Record<string, string[]> = { "rebind.example": ["93.184.215.14", "127.0.0.1"], "meta.example": ["169.254.169.254"], "staging.lan": ["192.168.1.20"], "both.example": ["::1", "fe80::2"] };
  const lookup = async (name: string) => names[name] ?? Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
  assert.deepEqual(await refusal(new URL("https://rebind.example/"), undefined, lookup), { host: "rebind.example", kind: "loopback" });
  assert.deepEqual(await refusal(new URL("http://meta.example:8080/x"), undefined, lookup), { host: "meta.example:8080", kind: "link-local" });
  assert.deepEqual(await refusal(new URL("http://both.example/"), undefined, lookup), { host: "both.example", kind: "link-local" }, "the worse of the two");
  assert.equal(await refusal(new URL("http://staging.lan/"), undefined, lookup), undefined, "LAN staging sites are fine");
  await assert.rejects(refusal(new URL("https://nowhere.example/"), undefined, lookup), refused(502, /nowhere\.example wasn't found \(ENOTFOUND\)/), "a name that can't be checked isn't opened");
});

test("a page can't take a snapshot on to this computer: a redirect there fails, and what it would load from there is never asked for", { skip: noChrome }, async () => {
  let reached = 0;
  const inside = await serve((_req, res) => {
    reached++;
    res.writeHead(200, { "content-type": "text/html" }).end("<title>Inside</title>");
  });
  const insidePort = new URL(inside.url).port;
  const there = `http://localhost:${insidePort}`; // this computer by another name than the one the page is allowed on
  const outside = await serve((req, res) => {
    if (req.url === "/") return void res.writeHead(302, { location: `${there}/secret` }).end();
    res.writeHead(200, { "content-type": "text/html" }).end(`<title>Outside</title><img src="${there}/pixel.png"><iframe src="${there}/frame"></iframe><script>fetch("${there}/api").catch(() => {})</script>`);
  });
  try {
    await assert.rejects(snap({ url: outside.url, width: 800 }), refused(403, new RegExp(`it went on to localhost:${insidePort}, which is this computer, and snapshots don't open those`)));
    const shot = await snap({ url: `${outside.url}page`, width: 800 });
    assert.equal(shot.title, "Outside", "the page itself is fine");
    assert.equal(reached, 0, "nothing reached the address on this computer");
  } finally {
    inside.server.close();
    outside.server.close();
  }
});

test("a snapshot of the viewport, and a whole-page one that has all of the page", { skip: noChrome }, async () => {
  const bands = `<div style="height:600px;background:#f00"></div><div style="height:600px;background:#0f0"></div><div style="height:600px;background:#00f"></div>`;
  const { server, url } = await page(`<html><head><title>Snap</title><meta name="viewport" content="width=device-width"></head><body style="margin:0">${bands}</body></html>`);
  try {
    const view = await snap({ url, width: 390, height: 700 });
    assert.deepEqual([view.width, view.height, view.title, view.url], [390, 700, "Snap", url]);
    const shown = decode(view.image);
    assert.deepEqual([shown.width, shown.height], [390, 700]);
    near(shown.px(195, 300), RED, "the top of the viewport");
    near(shown.px(195, 650), GREEN, "the bottom of the viewport");

    const full = await snap({ url, width: 390, height: 700, full: true });
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
    const full = await snap({ url, width: 390, height: 844, full: true });
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
  // Zoomed in, the visible width is a fraction of a CSS pixel: the size reported is the picture's own.
  const zoomed = await page(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1.5"></head><body style="margin:0"><div style="height:2000px;background:#f00"></div></body></html>`);
  try {
    for (const full of [false, true]) {
      const shot = await snap({ url: zoomed.url, width: 412, height: 800, full });
      const png = decode(shot.image);
      assert.deepEqual([png.width, png.height], [shot.width, shot.height], `full: ${full}`);
    }
  } finally {
    zoomed.server.close();
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
    const [a, b] = await Promise.all([snap({ url, width: 800 }), snap({ url, width: 600 })]);
    assert.deepEqual([a.width, b.width], [800, 600]);
    assert.equal(most, 1, "the second waited for the first");
  } finally {
    server.close();
  }
});

test("a page that can't be reached, an alert(), and a Chrome that dies each end the snapshot, and the next one still works", { skip: noChrome }, async () => {
  await assert.rejects(snap({ url: "http://127.0.0.1:9/", width: 800 }), (e: unknown) => e instanceof SnapshotError && e.status === 502 && /Couldn't open/.test(e.message));

  const { server, url } = await page("<title>Hello</title><p>hi</p><script>alert('welcome'); confirm('sure?')</script>");
  try {
    const started = Date.now();
    const shot = await snap({ url, width: 800 });
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
    const previousChrome = process.env.CODEFLOW_CHROME;
    process.env.CODEFLOW_CHROME = fake;
    try {
      const started = Date.now();
      await assert.rejects(snap({ url: "http://127.0.0.1:9/", width: 800 }), (e: unknown) => e instanceof SnapshotError && e.status === 502 && /exit 3/.test(e.message));
      assert.ok(Date.now() - started < 10_000, `said so at once: ${Date.now() - started}ms`);
      // A file that isn't a program: spawn throws on macOS; Linux runs it with /bin/sh, which fails.
      writeFileSync(fake, "garbage, not a program\n");
      await assert.rejects(snap({ url: "http://127.0.0.1:9/", width: 800 }), (e: unknown) => e instanceof SnapshotError && e.status === 502 && /Couldn't start|exit 127/.test(e.message));
    } finally {
      if (previousChrome === undefined) delete process.env.CODEFLOW_CHROME;
      else process.env.CODEFLOW_CHROME = previousChrome;
    }
  }
  const again = await page("<title>Again</title>");
  try {
    assert.equal((await snap({ url: again.url, width: 600 })).title, "Again");
  } finally {
    again.server.close();
  }
});

test("a page whose renderer crashes ends the snapshot at once, not at the timeout", { skip: (noChrome || process.platform === "win32") && "needs Chrome, and ps" }, async () => {
  // An image that never comes keeps the page loading; once the page asks for it, its renderer is there.
  let asked = false;
  const { server, url } = await serve((req, res) => {
    if (req.url === "/never.png") asked = true;
    else res.writeHead(200, { "content-type": "text/html" }).end('<title>x</title><img src="/never.png">');
  });
  try {
    const started = Date.now();
    const shot = snap({ url, width: 800 });
    for (let i = 0; i < 100 && !asked; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(asked, "the page loaded far enough to ask for its image");
    // Every renderer of the Chrome this snapshot started (its profile is in this test's temp folder),
    // found by ancestry: on Linux they're forked from Chrome's zygote and don't name the profile.
    const procs = execFileSync("ps", ["-axo", "pid=,ppid=,command="])
      .toString()
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
    const browser = procs.find((p) => p.command.includes(temp) && p.command.includes("--remote-debugging-pipe") && !p.command.includes("--type="));
    assert.ok(browser, "found the snapshot's Chrome");
    const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
    const under = (pid: number) => {
      for (let at = parent.get(pid); at && at > 1; at = parent.get(at)) if (at === browser.pid) return true;
      return false;
    };
    const renderers = procs.filter((p) => p.command.includes("--type=renderer") && under(p.pid));
    assert.ok(renderers.length, "found its renderers");
    for (const r of renderers) process.kill(r.pid, "SIGKILL");
    await assert.rejects(shot, (e: unknown) => e instanceof SnapshotError && e.status === 502 && /crashed/.test(e.message));
    assert.ok(Date.now() - started < 20_000, `said so at once: ${Date.now() - started}ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("each snapshot's Chrome profile is gone afterwards", { skip: noChrome }, () => {
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("codeflow-snapshot-")), []);
});
