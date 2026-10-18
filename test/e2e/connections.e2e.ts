// End-to-end: a browser allows 6 connections per host over HTTP/1.1, shared by every tab. A run
// view, a side chat, two terminals and a second tab must not use them up: requests still go
// through, and keystrokes still reach the terminal.
// Run with `npx tsx --test test/e2e/connections.e2e.ts` (needs Google Chrome installed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const TOKEN = "e2e-connections-token";
const bearer = { authorization: `Bearer ${TOKEN}` };

let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let repo: string;

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-conn-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node check.mjs" } }));
  writeFileSync(join(repo, "check.mjs"), 'import { readdirSync } from "node:fs"; process.exit(readdirSync(".").some((f) => f.startsWith("claude-")) ? 0 : 1);\n');
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // As in ui.e2e.ts: a bash with a home of its own and a known prompt, no dotfiles.
  const shellHome = mkdtempSync(join(tmpdir(), "codeflow-conn-user-"));
  const loginShell = join(shellHome, "e2e-shell");
  writeFileSync(loginShell, `#!/bin/bash\nexport HOME='${shellHome}' HISTFILE='${join(shellHome, ".bash_history")}' BASH_SILENCE_DEPRECATION_WARNING=1 PS1='e2e$ '\nexec /bin/bash --noprofile --norc -i\n`, { mode: 0o755 });

  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      SHELL: loginShell,
      PORT: String(PORT),
      CODEFLOW_REMOTE_PORT: String(await freePort()),
      CODEFLOW_HOME: mkdtempSync(join(tmpdir(), "codeflow-conn-home-")),
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
      CODEFLOW_TOKEN: TOKEN,
    },
    stdio: process.env.E2E_DEBUG ? "inherit" : "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`, { headers: bearer }).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  // One context: its tabs share the browser's connections to the server, as a real profile's do.
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
});

after(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
});

const api = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, body === undefined ? { headers: bearer } : { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

/** What the server sees: windows' streams and the topics they watch (eventually, as subscriptions change). */
async function streamsAre(want: { streams: number; subscriptions: number }, what: string) {
  let got: unknown;
  for (let i = 0; i < 100; i++) {
    got = (await api("/api/health")).streams;
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(got, want, what);
}

/** A request from the page, within `ms`: "stalled" when the browser holds it back for lack of a connection. */
const fetchFrom = (page: Page, path: string, ms = 5_000) =>
  page.evaluate(
    ([path, ms]) => Promise.race([fetch(path as string).then((r) => r.status), new Promise((resolve) => setTimeout(() => resolve("stalled"), ms as number))]),
    [path, ms] as const,
  );

test("a run view with a side chat, two terminals and a second tab still gets its requests through", async () => {
  const created = await api("/api/runs", { repo, task: "E2E: a run for the connections", pattern: "pipeline", roles: { planner: ["claude"], builder: ["claude"], reviewer: ["codex"] }, options: {} });
  assert.ok(created.id, created.error);
  let run = await api(`/api/runs/${created.id}`);
  for (let i = 0; i < 150 && run.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 200));
    run = await api(`/api/runs/${created.id}`);
  }
  assert.equal(run.status, "done");

  const page = await context.newPage();
  await page.goto(`${BASE}/?token=${TOKEN}#/run/${created.id}`);
  await page.locator(".runview .run-head h2", { hasText: "E2E: a run for the connections" }).waitFor();
  const toggle = page.getByRole("button", { name: "Side panel", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const side = page.getByRole("complementary", { name: "Side panel" });
  await side.locator(".side-scope").getByText("E2E: a run for the connections").waitFor();

  // A side chat on the run (it reads the run as the run view does).
  await side.getByRole("tab", { name: "Chat" }).click();
  await side.getByText("Chat about this run").waitFor();
  await side.getByLabel("Message").fill("E2E: what did this run change?");
  await side.getByLabel("Message").press("Enter");
  await side.locator("#side-pane-chat .fu-answer.done").first().waitFor({ timeout: 30_000 });

  // Two terminals, one above the other.
  await side.getByRole("tab", { name: "Terminal" }).click();
  await side.locator("#side-pane-terminal .sess.on").waitFor();
  await side.getByRole("button", { name: "New terminal" }).click();
  await side.locator(".pop-item", { hasText: "repository" }).click();
  await side.locator("#side-pane-terminal .sess").nth(1).waitFor();
  await side.getByRole("button", { name: "Split" }).click();
  await side.locator("#side-pane-terminal .term-pane").nth(1).waitFor();
  assert.equal(await side.locator("#side-pane-terminal .term-pane").count(), 2);
  assert.equal(await fetchFrom(page, "/api/health"), 200, "one tab on its own gets through");
  // One stream for the window: the run list, the run, and the two terminals on it.
  await streamsAre({ streams: 1, subscriptions: 4 }, "a window's one stream");

  // Behind another tab the terminals aren't watched; the side chat shares the run view's subscription.
  await side.getByRole("tab", { name: "Chat" }).click();
  await streamsAre({ streams: 1, subscriptions: 2 }, "terminals dropped, the run shared");
  await side.getByRole("tab", { name: "Terminal" }).click();
  await streamsAre({ streams: 1, subscriptions: 4 }, "terminals watched again");

  // A closed panel watches nothing; opened again, it does.
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await streamsAre({ streams: 1, subscriptions: 2 }, "the run list and the run view's run");
  await page.getByRole("button", { name: "Side panel", exact: true }).click();
  await streamsAre({ streams: 1, subscriptions: 4 }, "the panel's terminals again");

  // A second tab on the same run: the first tab's stream carries its topics too.
  const second = await context.newPage();
  await second.goto(`${BASE}/#/run/${created.id}`);
  await second.locator(".runview .run-head h2", { hasText: "E2E: a run for the connections" }).waitFor({ timeout: 10_000 }).catch(() => {});
  assert.equal(await fetchFrom(page, "/api/health"), 200, "the first tab's requests still go through");
  assert.equal(await fetchFrom(second, "/api/health"), 200, "the second tab's requests go through");
  await second.locator(".runview .run-head h2", { hasText: "E2E: a run for the connections" }).waitFor({ timeout: 5_000 });
  // It opens with the panel as you left it (on the Terminal tab, the same two shells).
  await streamsAre({ streams: 1, subscriptions: 8 }, "one stream for both tabs");

  // Keystrokes still reach a terminal (drawn afresh after it was hidden), and its output comes back.
  const pane = side.locator("#side-pane-terminal .term-pane").first();
  await pane.locator(".xterm").click();
  await page.keyboard.type("echo conn-$((40+2))");
  await page.keyboard.press("Enter");
  await pane.locator(".xterm-rows").getByText("conn-42").waitFor({ timeout: 5_000 });

  // A button still works in the second tab, and the first tab hears what it did: Archive (keeping the worktrees).
  await second.getByRole("button", { name: "Archive…" }).click();
  const dialog = second.locator("dialog", { hasText: "Archive this run" });
  await dialog.getByRole("checkbox").first().uncheck();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await second.locator(".run-head").getByRole("button", { name: "Unarchive" }).waitFor({ timeout: 5_000 });
  await page.locator(".run-head").getByRole("button", { name: "Unarchive" }).waitFor({ timeout: 5_000 });

  // A tab that goes away stops being watched at once, even one that crashed without a word.
  const third = await context.newPage();
  await third.goto(`${BASE}/#/run/${created.id}`);
  await streamsAre({ streams: 1, subscriptions: 12 }, "a third tab, on the same stream");
  const cdp = await context.newCDPSession(third);
  void cdp.send("Page.crash").catch(() => {}); // never answered: the page is gone
  await streamsAre({ streams: 1, subscriptions: 8 }, "the crashed tab's topics dropped");

  // The tab holding the stream closes: the other one opens it, and keeps hearing about the run.
  await page.close();
  await streamsAre({ streams: 1, subscriptions: 4 }, "the second tab's stream: its run list, its run, its terminals");
  await api(`/api/runs/${created.id}/archive`, { archived: false });
  await second.locator(".run-head").getByRole("button", { name: "Archive…" }).waitFor({ timeout: 5_000 });
  assert.equal(await fetchFrom(second, "/api/health"), 200);
  await second.close();
  await streamsAre({ streams: 0, subscriptions: 0 }, "no tabs, no streams");
});

test("owner stream sharing stays private across shared-account sign-in and uses no secret in Web Lock names", async () => {
  const projects = await api("/api/projects"); assert.ok(projects[0]?.id);
  const state = await api("/api/accounts");
  const created = await api("/api/accounts", { revision: state.revision, username: "stream-viewer", displayName: "Stream viewer", password: "a long stream boundary password", roles: { [projects[0].id]: "viewer" } });
  assert.ok(created.users?.some((user: { username: string }) => user.username === "stream-viewer"), created.error);
  const ownerPage = await context.newPage();
  await ownerPage.goto(`${BASE}/?token=${TOKEN}`); await ownerPage.getByRole("button", { name: "New run", exact: true }).waitFor();
  await streamsAre({ streams: 1, subscriptions: 1 }, "the owner watches its one private stream");
  const before = await ownerPage.evaluate(async () => (await fetch("/api/auth/self")).json());
  assert.match(before.streamSharing.channelKey, /^[a-f0-9]{64}$/); assert.match(before.streamSharing.lockId, /^[a-f0-9]{32}$/);
  const locks = await ownerPage.evaluate(async () => (await navigator.locks.query()).held?.map((lock) => lock.name ?? "") ?? []);
  assert.ok(locks.some((name) => name.includes(before.streamSharing.lockId)));
  assert.ok(locks.every((name) => !name.includes(before.streamSharing.channelKey)), "enumerable lock names never disclose the private BroadcastChannel capability");
  assert.equal(await ownerPage.evaluate((key) => [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) => String(value).includes(key)), before.streamSharing.channelKey), false, "the channel key stays in owner-page memory");

  // A plain document on the same origin has the same BroadcastChannel namespace and Web Locks.
  // It becomes a real shared viewer, then tries the upstream public broker names and known lock ID.
  const sharedPage = await context.newPage(); await sharedPage.route("**/stream-boundary-surface", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Stream boundary fixture</title><main>Shared viewer fixture</main>" }));
  await sharedPage.goto(`${BASE}/stream-boundary-surface`);
  const login = await sharedPage.evaluate(async () => (await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "stream-viewer", password: "a long stream boundary password" }) })).status); assert.equal(login, 200);
  const identity = await sharedPage.evaluate(async () => (await fetch("/api/auth/self")).json()); assert.equal(identity.kind, "shared"); assert.equal(identity.streamSharing, undefined);
  assert.equal(await sharedPage.evaluate(async () => (await fetch("/api/stream?subs=%5B%7B%22id%22%3A1%2C%22topic%22%3A%22runs%22%7D%5D")).status), 403);
  await streamsAre({ streams: 0, subscriptions: 0 }, "shared login closes the prior owner's transport before it can outlive the identity switch");
  await ownerPage.getByRole("heading", { name: "Shared project review", exact: true }).waitFor({ timeout: 10000 });
  await sharedPage.evaluate((lockId) => {
    const root = window as unknown as { received: unknown[]; publicChannels: BroadcastChannel[] };
    root.received = [];
    root.publicChannels = ["codeflow-stream", "codeflow-stream:unprivileged", `codeflow-stream:${lockId}`, `codeflow-stream:${lockId}:unprivileged`].map((name) => { const channel = new BroadcastChannel(name); channel.onmessage = (event) => root.received.push(event.data); return channel; });
    for (const channel of root.publicChannels) channel.postMessage({ kind: "subs", window: "unprivileged", subs: [[71, "runs", undefined]] });
  }, before.streamSharing.lockId);

  // Owner recovery creates a different private group. Public forged subscriptions cannot join it.
  const recovered = await context.newPage(); await recovered.goto(`${BASE}/?token=${TOKEN}`); await recovered.getByRole("button", { name: "New run", exact: true }).waitFor();
  const after = await recovered.evaluate(async () => (await fetch("/api/auth/self")).json()); assert.notEqual(after.streamSharing.channelKey, before.streamSharing.channelKey); assert.notEqual(after.streamSharing.lockId, before.streamSharing.lockId);
  await streamsAre({ streams: 1, subscriptions: 1 }, "a recovered owner group has no forged subscriber");
  await sharedPage.evaluate(() => { for (const channel of (window as unknown as { publicChannels: BroadcastChannel[] }).publicChannels) channel.postMessage({ kind: "subs", window: "unprivileged", subs: [[71, "runs", undefined]] }); });
  // This round trip follows the forged messages and creates a real owner-feed update.
  const list = await api("/api/runs"); const run = Array.isArray(list) ? list[0] : list.runs[0]; assert.ok(run?.id);
  await api(`/api/runs/${run.id}/archive`, { archived: false });
  await streamsAre({ streams: 1, subscriptions: 1 }, "public/lock-derived broker names cannot add subscriptions");
  assert.deepEqual(await sharedPage.evaluate(() => (window as unknown as { received: unknown[] }).received), [], "a shared document receives no owner stream messages");
  await recovered.close(); await ownerPage.close(); await sharedPage.close(); await streamsAre({ streams: 0, subscriptions: 0 }, "every owner broker was released");
});
