// The side panel Browser's preview proxy (src/preview.ts), tested directly against a stand-in
// dev server on a free port: where the overlay goes in a page, the frame policy that replaces
// the app's, the host name it's served on, code-flow's cookies kept from the app, compressed
// pages, connections that close when the browser leaves, and the overlay itself in headless
// Chrome (skipped without Chrome). Never ports 4317/4318: code-flow's origins here are made up.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-preview-home-"));
const { Previews, framedPolicy, injectOverlay } = await import("../src/preview.js");

const CODEFLOW = ["http://localhost:40999", "http://127.0.0.1:40999"];
const TAG = `<script src="/__codeflow/overlay.js"></script>`;

/** A raw request to the proxy: no decompression, the Host it names, and set-cookie as sent. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    })
      .on("error", reject)
      .end();
  });
}

const within = <T>(promise: Promise<T>, what: string, ms = 3000) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))]);

// ------------------------------------------------------------ the stand-in dev server
let appPort: number;
let seen: IncomingHttpHeaders = {};
/** Requests the app is holding open, by path: resolved when the proxy's side of each closes. */
const held = new Map<string, { arrived: () => void; closed: () => void }>();
const hold = (path: string) => {
  let arrived!: () => void;
  let closed!: () => void;
  const promises = { arrived: new Promise<void>((r) => (arrived = r)), closed: new Promise<void>((r) => (closed = r)) };
  held.set(path, { arrived, closed });
  return promises;
};
// Its inline style is refused by its own policy; the layout comes from its stylesheet.
const PAGE = `<!doctype html><title>App</title><link rel="stylesheet" href="/app.css"><body><a id="link" href="/next">next</a>
<form id="login" style="color: blue"><input id="pw" type="password"><input id="keep" type="checkbox" checked><textarea id="note">default</textarea></form>
<img src="/missing.png" alt="">
<script nonce="app">document.body.dataset.ran = "1"</script></body>`;
const app = createServer((req: IncomingMessage, res: ServerResponse) => {
  seen = req.headers;
  const path = req.url ?? "/";
  if (path === "/" || path === "/next") {
    // A page that refuses frames and allows only its own nonce'd scripts and its own stylesheets.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; script-src 'nonce-app' 'strict-dynamic'; frame-ancestors 'none'" });
    return res.end(path === "/" ? PAGE : "<!doctype html><title>Next</title><body>next page</body>");
  }
  if (path === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end("#link { display: block; width: 300px; height: 80px } #login { width: 300px; padding: 12px }");
  if (path === "/cookies") {
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["codeflow_session=evil; Path=/", "sid=2; Path=/; HttpOnly"] });
    return res.end(String(req.headers.cookie ?? ""));
  }
  // A static server that sends its precompressed page whatever it was asked for.
  if (path === "/gz") return res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipSync("<html><head><title>gz</title></head></html>"));
  if (path === "/not-gz") return res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end("<html><head></head></html>");
  if (path === "/zz") return res.writeHead(200, { "content-type": "text/html", "content-encoding": "compress" }).end("compressed?");
  const waiting = held.get(path);
  if (waiting) {
    res.on("close", waiting.closed);
    waiting.arrived();
    // An event stream: never ends. /slow doesn't even answer.
    if (path === "/events") res.writeHead(200, { "content-type": "text/event-stream" }).write("data: hi\n\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});
const appSockets: Socket[] = [];
app.on("upgrade", (_req, socket: Socket) => {
  appSockets.push(socket);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (d) => socket.write(d));
  // Like a real WebSocket server: when the other side is done, so is it.
  socket.on("end", () => socket.end());
  socket.on("error", () => {});
});

const previews = new Previews(() => CODEFLOW, () => [40999]);
let proxy: { url: string; origin: string };
let port: number;

before(async () => {
  appPort = await new Promise<number>((r) => app.listen(0, "127.0.0.1", () => r((app.address() as AddressInfo).port)));
  proxy = await previews.show(`http://127.0.0.1:${appPort}/`, "127.0.0.1:40999");
  port = Number(new URL(proxy.origin).port);
});

after(() => {
  previews.closeAll();
  app.closeAllConnections();
  app.close();
});

// ------------------------------------------------------------ where the overlay goes
test("injectOverlay: after the doctype, comments and the <html> and <head> tags, never before the doctype or inside <header>", () => {
  // No <html> or <head> (both optional): after the doctype, so the page stays in standards mode.
  assert.equal(injectOverlay("<!doctype html><title>x</title><body>hi"), `<!doctype html>${TAG}<title>x</title><body>hi`);
  // Legacy XHTML: an XML declaration first, then the doctype; the page stays in standards mode.
  assert.equal(injectOverlay(`<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html><html><head><title>x</title>`), `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html><html><head>${TAG}<title>x</title>`);
  assert.equal(
    injectOverlay(`\uFEFF<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">`),
    `\uFEFF<!DOCTYPE html>\n<html lang="en">\n<head>\n  ${TAG}<meta charset="utf-8">`,
  );
  // A <head> in a comment isn't the head; "$&" in the tag is kept as it is.
  assert.equal(
    injectOverlay(`<!doctype html><!-- <head> goes below --><html><head data-x="$&$'"><title>t</title>`),
    `<!doctype html><!-- <head> goes below --><html><head data-x="$&$'">${TAG}<title>t</title>`,
  );
  assert.equal(injectOverlay("<!doctype html><body><header>Top</header>"), `<!doctype html>${TAG}<body><header>Top</header>`);
  assert.equal(injectOverlay("<!doctype html><body><script>var s = '<head>'</script>"), `<!doctype html>${TAG}<body><script>var s = '<head>'</script>`);
  assert.equal(injectOverlay("just text"), `${TAG}just text`);
  assert.equal(injectOverlay("<head>", "n0nce+/="), `<head><script src="/__codeflow/overlay.js" nonce="n0nce+/="></script>`);
});

// ------------------------------------------------------------ the frame policy
test("framedPolicy: only code-flow and the app frame the page; the app's own policy stays, allowing the overlay and its snapshots", () => {
  const ancestors = `frame-ancestors 'self' ${CODEFLOW.join(" ")}`;
  assert.equal(framedPolicy(undefined, CODEFLOW, "N"), ancestors, "an app without a policy still can't be framed by other sites");
  // default-src's sources are copied to script-src and img-src, so nothing else is loosened.
  assert.equal(
    framedPolicy("default-src 'self'; frame-ancestors 'none'", CODEFLOW, "N"),
    `default-src 'self'; script-src 'self' 'nonce-N'; img-src 'self' data:, ${ancestors}`,
  );
  // A nonce would switch 'unsafe-inline' off, so the overlay is allowed as 'self' there.
  assert.equal(framedPolicy("script-src 'self' 'unsafe-inline'", CODEFLOW, "N"), `script-src 'self' 'unsafe-inline' 'self', ${ancestors}`);
  assert.equal(framedPolicy("script-src 'unsafe-inline' 'nonce-a' 'strict-dynamic'", CODEFLOW, "N"), `script-src 'unsafe-inline' 'nonce-a' 'strict-dynamic' 'nonce-N', ${ancestors}`);
  assert.equal(framedPolicy("script-src-elem 'none'; img-src 'none'", CODEFLOW, "N"), `script-src-elem 'none' 'nonce-N'; img-src 'none' data:, ${ancestors}`);
  // Two policies (two headers, or one with a comma): each is enforced, so each is changed.
  assert.equal(framedPolicy(["script-src 'self'", "frame-ancestors 'none'"], CODEFLOW, "N"), `script-src 'self' 'nonce-N', ${ancestors}`);
  assert.equal(framedPolicy("style-src 'self', connect-src 'none'", CODEFLOW, "N"), `style-src 'self', connect-src 'none', ${ancestors}`);
});

test("a page through the proxy: the overlay with the nonce its policy allows, and no X-Frame-Options", async () => {
  const page = await get(port, "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers["x-frame-options"], undefined);
  const policy = String(page.headers["content-security-policy"]);
  const nonce = policy.match(/'nonce-([^']+)'/g)?.at(-1)?.slice(7, -1);
  assert.ok(nonce && nonce !== "app", policy);
  assert.match(policy, /script-src 'nonce-app' 'strict-dynamic' 'nonce-[^']+'; img-src 'self' data:, frame-ancestors 'self' http:\/\/localhost:40999 http:\/\/127\.0\.0\.1:40999$/);
  assert.doesNotMatch(policy, /'none'/);
  assert.ok(page.body.toString().startsWith(`<!doctype html><script src="/__codeflow/overlay.js" nonce="${nonce}"></script><title>App</title>`));
  assert.equal(seen["accept-encoding"], "identity", "pages are asked for uncompressed");
  assert.notEqual((await get(port, "/")).headers["content-security-policy"], policy, "a new nonce for every response");
});

// ------------------------------------------------------------ host name and cookies
test("show: on the host name code-flow's page was opened with, the same port for both", async () => {
  const local = await previews.show(`http://127.0.0.1:${appPort}/a?b=1#c`, "localhost:40999");
  assert.equal(local.origin, `http://localhost:${port}`);
  assert.equal(local.url, `http://localhost:${port}/a?b=1#c`);
  assert.equal((await previews.show(`http://127.0.0.1:${appPort}/`, "127.0.0.1:40999")).origin, `http://127.0.0.1:${port}`);
  assert.equal((await previews.show(`http://127.0.0.1:${appPort}/`)).origin, `http://127.0.0.1:${port}`);
  // Both names reach the proxy; nothing else does (DNS rebinding).
  assert.equal((await get(port, "/", { host: `localhost:${port}` })).status, 200);
  assert.equal((await get(port, "/", { host: `evil.example:${port}` })).status, 403);
  await assert.rejects(previews.show("http://localhost:40999/"), /code-flow itself/);
});

test("code-flow's own cookies never reach the app, and the app can't set them", async () => {
  const res = await get(port, "/cookies", { cookie: "theme=dark; codeflow_session=secret; codeflow_phone_40998=phone; sid=1" });
  assert.equal(res.body.toString(), "theme=dark; sid=1");
  assert.deepEqual(res.headers["set-cookie"], ["sid=2; Path=/; HttpOnly"]);
  await get(port, "/cookies", { cookie: "codeflow_session=secret" });
  assert.equal(seen.cookie, undefined, "no cookie header left at all");
});

// ------------------------------------------------------------ compressed pages
test("a page sent compressed anyway is decompressed for the overlay; an encoding it can't read passes through as it came", async () => {
  const gz = await get(port, "/gz");
  assert.equal(gz.headers["content-encoding"], undefined);
  assert.equal(gz.body.toString(), `<html><head>${TAG}<title>gz</title></head></html>`, "no nonce where the app has no script policy");
  const zz = await get(port, "/zz");
  assert.equal(zz.headers["content-encoding"], "compress");
  assert.equal(zz.body.toString(), "compressed?");
  const notGz = await get(port, "/not-gz");
  assert.equal(notGz.headers["content-encoding"], "gzip", "not gzip after all: left as it came");
  assert.equal(notGz.body.toString(), "<html><head></head></html>");
});

// ------------------------------------------------------------ connections that end
test("when the browser leaves, the request to the app closes too: an event stream, and a request still waiting for its answer", async () => {
  const events = hold("/events");
  const client = request({ host: "127.0.0.1", port, path: "/events", agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => res.once("data", () => client.destroy()));
  client.on("error", () => {});
  client.end();
  await within(events.closed, "the app's event stream closes");

  const slow = hold("/slow");
  const waiting = request({ host: "127.0.0.1", port, path: "/slow", agent: false, headers: { host: `127.0.0.1:${port}` } });
  waiting.on("error", () => {});
  waiting.end();
  await within(slow.arrived, "the request reaches the app");
  waiting.destroy();
  await within(slow.closed, "the app's side of the waiting request closes");
  assert.equal((await get(port, "/cookies")).status, 200, "the proxy carries on");
});

test("WebSockets: the browser closing reaches the app, and closing the previews closes both ends of each", async () => {
  const own = new Previews(() => CODEFLOW, () => []);
  const shown = await own.show(`http://localhost:${appPort}/`, "localhost:40999");
  const wsPort = Number(new URL(shown.origin).port);
  const open = async () => {
    const known = appSockets.length;
    const socket = connect(wsPort, "127.0.0.1");
    socket.on("error", () => {});
    socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${wsPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    await within(new Promise<void>((r) => socket.once("data", () => r())), "the upgrade answers");
    const appSocket = appSockets[known]!;
    return { socket, appClosed: new Promise<void>((r) => (appSocket.destroyed ? r() : appSocket.once("close", () => r()))) };
  };
  const first = await open();
  first.socket.end();
  await within(first.appClosed, "the browser closing closes the app's socket");

  const second = await open();
  const closed = new Promise<void>((r) => second.socket.once("close", () => r()));
  own.closeAll();
  await within(closed, "closing the previews closes the browser's socket");
  await within(second.appClosed, "and the app's");
});

// ------------------------------------------------------------ the overlay, in a browser
test("the overlay in Chrome: Box doesn't click through, snapshots hide passwords, pin ids are new per page load, console reports are right", async (t) => {
  const { chromium } = await import("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return t.skip("Chrome isn't installed");
  }
  // A stand-in for code-flow's page: frames the preview, says hello on every load, keeps what the overlay says.
  const parent = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><body style="margin:0"><iframe id="f" style="width:800px;height:600px;border:0"></iframe><script>
      window.msgs = [];
      const f = document.getElementById("f");
      window.send = (msg) => f.contentWindow.postMessage({ codeflow: 1, ...msg }, ORIGIN);
      addEventListener("message", (e) => { if (e.source === f.contentWindow && e.data && e.data.codeflow === 1) msgs.push(e.data); });
      f.addEventListener("load", () => send({ type: "hello" }));
      f.src = ORIGIN + "/";
    </script></body>`);
  });
  const parentPort = await new Promise<number>((r) => parent.listen(0, "127.0.0.1", () => r((parent.address() as AddressInfo).port)));
  const own = new Previews(() => [`http://127.0.0.1:${parentPort}`], () => [parentPort]);
  const shown = await own.show(`http://127.0.0.1:${appPort}/`, `127.0.0.1:${parentPort}`);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(`window.ORIGIN = ${JSON.stringify(shown.origin)}`);
    await page.goto(`http://127.0.0.1:${parentPort}/`);
    const messages = (type: string) => page.evaluate((type) => (window as any).msgs.filter((m: any) => m.type === type), type);
    const waitFor = (type: string, count = 1) => page.waitForFunction(([type, count]) => (window as any).msgs.filter((m: any) => m.type === type).length >= Number(count), [type, count], { timeout: 5000 });
    await waitFor("ready");
    const frame = page.frames().find((f) => f.url().startsWith(shown.origin))!;
    assert.equal(await frame.evaluate(() => document.body.dataset.ran), "1", "the app's own nonce'd script still runs");

    // A missing image is a failed load, not "Script error". A reused XHR reports each failure once.
    await page.waitForFunction(() => (window as any).msgs.some((m: any) => m.type === "console" && /missing\.png/.test(m.text)), undefined, { timeout: 5000 });
    await frame.evaluate(async () => {
      const xhr = new XMLHttpRequest();
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => {
          xhr.onloadend = resolve;
          xhr.open("GET", `/gone-${i}`);
          xhr.send();
        });
      }
    });
    await page.waitForTimeout(200);
    const consoleLines = (await messages("console")).map((m: any) => `${m.level}: ${m.text}`);
    assert.ok(consoleLines.includes(`network: failed to load img ${shown.origin}/missing.png`), consoleLines.join("\n"));
    assert.ok(!consoleLines.some((l: string) => l.includes("Script error")), consoleLines.join("\n"));
    assert.deepEqual(consoleLines.filter((l: string) => l.includes("/gone-")), ["network: 404 GET /gone-0", "network: 404 GET /gone-1", "network: 404 GET /gone-2"]);

    // Pick the form after typing a password (and copying it into the attribute, as React does).
    await frame.fill("#pw", "hunter2");
    await frame.fill("#note", "typed note");
    await frame.evaluate(() => {
      const pw = document.getElementById("pw") as HTMLInputElement;
      pw.setAttribute("value", pw.value);
      const serialize = XMLSerializer.prototype.serializeToString;
      XMLSerializer.prototype.serializeToString = function (node) {
        const out = serialize.call(this, node);
        (window as any).lastSnapshot = out;
        return out;
      };
    });
    await page.evaluate(() => (window as any).send({ type: "mode", mode: "pick" }));
    const form = (await frame.locator("#login").boundingBox())!;
    await page.mouse.click(form.x + 4, form.y + 4);
    await waitFor("pin");
    const [picked] = await messages("pin");
    assert.equal(picked.pin.kind, "element");
    assert.equal(picked.pin.selector, "#login");
    assert.doesNotMatch(picked.pin.html, /hunter2/, "the pin's HTML leaves the password out");
    const snapshot: string = await frame.evaluate(() => (window as any).lastSnapshot);
    assert.doesNotMatch(snapshot, /hunter2/, "the snapshot leaves the password out");
    assert.match(snapshot, /type="password"[^>]*value="•••••••"|value="•••••••"[^>]*type="password"/);
    assert.match(snapshot, /type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/);
    assert.match(snapshot, /<textarea[^>]*>typed note<\/textarea>/);
    assert.match(String(picked.pin.image), /^data:image\/png/, "the snapshot loads under the app's img-src");

    // Adjust, then Remove: the page's own look comes back, though its policy refuses inline styles.
    const color = () => frame.evaluate(() => getComputedStyle(document.getElementById("login")!).color);
    const pageColor = await color();
    await page.evaluate((id) => (window as any).send({ type: "adjust", id, styles: { color: "rgb(255, 0, 0)" } }), picked.pin.id);
    await frame.waitForFunction(() => getComputedStyle(document.getElementById("login")!).color === "rgb(255, 0, 0)");
    await page.evaluate((id) => (window as any).send({ type: "reset", id }), picked.pin.id);
    await frame.waitForFunction((pageColor) => getComputedStyle(document.getElementById("login")!).color === pageColor, pageColor, { timeout: 2000 });

    // Box: a press on the link and a drag over it draw a box; the page never gets the click.
    await page.evaluate(() => (window as any).send({ type: "mode", mode: "box" }));
    const link = (await frame.locator("#link").boundingBox())!;
    await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
    await page.mouse.move(link.x + 5, link.y + 5);
    await page.mouse.down();
    await page.mouse.move(link.x + 150, link.y + 60, { steps: 5 });
    await page.mouse.up();
    await waitFor("pin", 2);
    await page.waitForTimeout(300);
    assert.equal(new URL(frame.url()).pathname, "/", "the link wasn't followed");
    assert.equal((await messages("pin"))[1].pin.kind, "box");

    // After a reload, a new pin's id is one no earlier page used.
    await frame.evaluate(() => location.reload());
    await waitFor("ready", 2);
    await page.evaluate(() => (window as any).send({ type: "mode", mode: "pick" }));
    const again = (await frame.locator("#login").boundingBox())!;
    await page.mouse.click(again.x + 4, again.y + 4);
    await waitFor("pin", 3);
    const ids = (await messages("pin")).map((m: any) => m.pin.id);
    assert.equal(new Set(ids).size, 3, ids.join(", "));
    assert.notEqual(String(ids[2]).split("-")[0], String(ids[0]).split("-")[0], ids.join(", "));
  } finally {
    await browser.close();
    own.closeAll();
    parent.close();
  }
});
