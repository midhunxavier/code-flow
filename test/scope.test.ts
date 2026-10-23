// What the side panel is about, and a popped-out panel among the windows, without a browser: a
// popped-out panel stays a panel and hands pages and drafts to the main window (a new one if that's
// gone), a side chat's link shows that run's chat wherever the panel is, the panel waits on a run's
// key until the runs load, and a run's review page counts as looking at it. The UI is bundled the
// way build-ui does it and loaded with a stand-in window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const ORIGIN = "http://localhost:4317";
const storage = new Map<string, string>();
const listeners: Record<string, ((e: unknown) => void)[]> = {};
/** What the stand-in server answers, by path. */
const answers: Record<string, unknown> = {};
const notified: string[] = [];
const opens: { url: string; target: string }[] = [];
let openReturns: unknown = null;
let m: any;

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    innerWidth: 1400,
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: ORIGIN, pathname: "/" },
    document: { hidden: false },
    Notification: class {
      static permission = "granted";
      constructor(title: string) {
        notified.push(title);
      }
    },
    fetch: async (path: string) => ({ ok: true, status: 200, json: async () => answers[path.split("?")[0]!] ?? {} }),
    opener: null,
    open: (url: string, target: string) => {
      opens.push({ url, target });
      return openReturns;
    },
  });
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "./state.ts";`,
        `export { handOffLink, notifyFinished } from "./app.tsx";`,
        `export { toast } from "./lib.ts";`,
      ].join("\n"),
      resolveDir: ui,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-scope-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
  m.listenForHandOffs();
});

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  repo: "/work/app",
  status: "done",
  task: `Task ${id}`,
  pattern: "solo",
  roles: { agent: ["claude"] },
  followUps: [],
  notes: [],
  worktrees: [],
  artifacts: [],
  createdAt: 1,
  ...extra,
});

/** Another window this one can talk to: what it was sent, and how often it was brought to the front. */
function otherWindow(origin = ORIGIN) {
  return {
    closed: false,
    location: { origin, pathname: "/" },
    sent: [] as { msg: any; target: string }[],
    focused: 0,
    postMessage(msg: unknown, target: string) {
      this.sent.push({ msg: structuredClone(msg), target });
    },
    focus() {
      this.focused++;
    },
  };
}
/** Another site's window: its location can't be read. */
const anotherSite = {
  closed: false,
  get location(): never {
    throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame");
  },
  postMessage() {
    throw new Error("nothing should be sent to another site");
  },
};
/** A message from another window, as the browser delivers it. */
const message = (data: unknown, from: { origin?: string; source?: unknown } = {}) => {
  for (const fn of listeners.message ?? []) fn({ data, origin: from.origin ?? ORIGIN, source: from.source ?? null });
};
const popped = (scope: string, tab = "browser") => ({ view: "side", tab, scope });
const draft = (to: string, text: string) => ({ to, text, images: [{ name: "pin-1-1.png", size: 3, data: "AAAA" }] });

test("before the runs load, a run's page gives the panel that run's key, and the panel waits instead of acting on the composer's scope", async () => {
  m.route.value = { view: "run", id: "r1" };
  assert.equal(m.runsLoaded.value, false);
  assert.equal(m.sideScope.value.key, "run:r1");
  assert.equal(m.sideScope.value.waiting, true);
  assert.equal(m.sideScope.value.run, undefined);

  answers["/api/runs"] = [run("r1"), run("r2")];
  await m.refreshRuns();
  assert.equal(m.sideScope.value.key, "run:r1");
  assert.equal(m.sideScope.value.run.id, "r1");
  assert.ok(!m.sideScope.value.waiting);

  // Once the runs are here, a run that isn't among them is no reason to wait.
  m.route.value = { view: "run", id: "gone" };
  assert.equal(m.sideScope.value.key, "none");
  assert.ok(!m.sideScope.value.waiting);

  // A popped-out panel on a project waits for the projects in the same way; an empty list that came is an answer.
  m.route.value = popped("project:p1");
  assert.equal(m.sideScope.value.key, "project:p1");
  assert.equal(m.sideScope.value.waiting, true);
  answers["/api/projects"] = [];
  await m.loadProjects();
  assert.equal(m.projectsLoaded.value, true, "the project page can say the project is gone instead of loading forever");
  assert.ok(!m.sideScope.value.waiting);
});

test("a popped-out panel's scope is its route: a window that stops being a popped-out panel follows again", () => {
  m.route.value = popped("run:r2", "chat");
  assert.equal(m.poppedScope.value, "run:r2");
  assert.equal(m.sideScope.value.key, "run:r2");
  assert.equal(m.sideScope.value.pinned, true);

  m.route.value = { view: "run", id: "r1" };
  assert.equal(m.poppedScope.value, null);
  assert.equal(m.sideScope.value.key, "run:r1");
  assert.equal(m.sideScope.value.pinned, false);
});

test("a popped-out panel stays a panel: the pages it opens, and the drafts for them, go to the main window that opened it", () => {
  const main = otherWindow();
  Object.assign(globalThis, { opener: main });
  m.route.value = popped("run:r1");

  // Browser pins for the run's main chat.
  const pins = draft("main:r1", "1. `header > button`: too small");
  m.navigate({ view: "run", id: "r1" }, [pins]);
  assert.deepEqual(m.route.value, popped("run:r1"), "still the panel");
  assert.equal(m.poppedScope.value, "run:r1");
  assert.deepEqual(main.sent[0], { msg: { type: "codeflow:open", route: { view: "run", id: "r1" }, drafts: [pins] }, target: ORIGIN });
  assert.equal(main.focused, 1);
  assert.equal(m.chatDrafts.value.length, 0, "nothing waits here for a message box this window doesn't have");

  // Full review from the Changes tab.
  m.navigate({ view: "review", id: "r1", branch: "codeflow/r1/claude" });
  assert.deepEqual(main.sent[1]!.msg.route, { view: "review", id: "r1", branch: "codeflow/r1/claude" });

  // A link to one of the app's pages: the run in the panel's header, a chat's Open.
  const click = (href: string | null, extra: Record<string, unknown> = {}) => {
    const link = { getAttribute: (name: string) => (name === "href" ? href : ((extra.attrs as Record<string, string>)?.[name] ?? null)) };
    const e = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: { closest: (selector: string) => (href?.startsWith("#/") && selector.includes("#/") ? link : null) },
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    m.handOffLink(e);
    return e.defaultPrevented;
  };
  assert.equal(click("#/run/r2"), true);
  assert.deepEqual(main.sent[2]!.msg.route, { view: "run", id: "r2" });
  assert.equal(click("#/run/r2", { metaKey: true }), false, "⌘-click opens a tab of its own, as the browser does it");
  assert.equal(click("#/run/r2", { attrs: { target: "_blank" } }), false);
  assert.equal(click("https://example.com/"), false);
  assert.equal(main.sent.length, 3);
  assert.deepEqual(m.route.value, popped("run:r1"));

  // In the main window, the same call just goes there, with the drafts for its boxes.
  Object.assign(globalThis, { opener: null });
  m.route.value = { view: "run", id: "r2" };
  m.navigate({ view: "composer" }, [draft("composer", "from notes")]);
  assert.deepEqual(m.route.value, { view: "composer" });
  assert.deepEqual(
    m.takeDrafts("composer").map((d: any) => d.text),
    ["from notes"],
  );
});

test("with no main window to hand to, a popped-out panel opens one and hands over what waits once it says it's ready", () => {
  const closed = Object.assign(otherWindow(), { closed: true });
  Object.assign(globalThis, { opener: closed });
  const fresh = otherWindow();
  openReturns = fresh;
  m.route.value = popped("run:r1");

  m.navigate({ view: "composer" }, [draft("composer", "first")]);
  m.navigate({ view: "run", id: "r1" }, [draft("main:r1", "second")]);
  assert.deepEqual(opens, [{ url: `${ORIGIN}/#/`, target: "_blank" }], "one new window, at the first page asked for");
  assert.equal(fresh.sent.length, 0, "it can't take a message before it has loaded");
  assert.equal(closed.sent.length, 0);

  // Ready, from a window this panel didn't open: nothing goes to it.
  message({ type: "codeflow:ready" }, { source: otherWindow() });
  assert.equal(fresh.sent.length, 0);
  message({ type: "codeflow:ready" }, { source: fresh });
  assert.deepEqual(
    fresh.sent.map((s) => [s.msg.route.view, s.msg.drafts[0].text, s.target]),
    [
      ["composer", "first", ORIGIN],
      ["run", "second", ORIGIN],
    ],
  );

  // From now on it's the main window.
  m.navigate({ view: "settings", section: "automations" });
  assert.equal(fresh.sent.length, 3);
  assert.equal(opens.length, 1);

  // An opener that's another site's page doesn't count; with pop-ups blocked, the panel says so.
  fresh.closed = true;
  Object.assign(globalThis, { opener: anotherSite });
  openReturns = null;
  m.navigate({ view: "run", id: "r2" });
  assert.equal(opens.length, 2);
  assert.match(m.toast.value.text, /allow pop-ups/);
  assert.deepEqual(m.route.value, popped("run:r1"));
  const anotherComputer = otherWindow();
  anotherComputer.location.pathname = "/computer/0123456789abcdef/";
  Object.assign(globalThis, { opener: anotherComputer });
  m.navigate({ view: "run", id: "r2" });
  assert.equal(anotherComputer.sent.length, 0, "a panel never hands drafts to another computer on the same origin");
  assert.equal(opens.length, 3);
  Object.assign(globalThis, { opener: null });
});

test("the main window takes what a popped-out panel hands over, and nothing from a page of another origin", () => {
  m.route.value = { view: "composer" };
  const handed = { type: "codeflow:open", route: { view: "run", id: "r2" }, drafts: [draft("main:r2", "pins")] };

  // The app in the Browser tab is another origin, though it can reach this window.
  message(handed, { origin: "http://localhost:5173" });
  assert.deepEqual(m.route.value, { view: "composer" });
  assert.equal(m.chatDrafts.value.length, 0);

  message(handed);
  assert.deepEqual(m.route.value, { view: "run", id: "r2" });
  assert.deepEqual(
    m.takeDrafts("main:r2").map((d: any) => d.text),
    ["pins"],
  );

  // Never a popped-out panel's address, and a popped-out panel takes nothing (nor passes it on).
  message({ type: "codeflow:open", route: popped("run:r1"), drafts: [] });
  assert.deepEqual(m.route.value, { view: "run", id: "r2" });
  const main = otherWindow();
  Object.assign(globalThis, { opener: main });
  m.route.value = popped("run:r1");
  message({ type: "codeflow:open", route: { view: "composer" }, drafts: [] });
  assert.deepEqual(m.route.value, popped("run:r1"));
  assert.equal(main.sent.length, 0);
  Object.assign(globalThis, { opener: null });

  // A side chat to show: the main window's panel moves to its run, even from a pin, and opens on it.
  m.route.value = { view: "run", id: "r1" };
  m.pinSide(true);
  m.route.value = { view: "composer" };
  m.sideOpen.value = false;
  message({ type: "codeflow:open", route: { view: "run", id: "r2" }, drafts: [], sideChat: { run: "r2", chat: "c1" } });
  assert.deepEqual(m.route.value, { view: "run", id: "r2" });
  assert.equal(m.sideScope.value.key, "run:r2");
  assert.equal(m.sideScope.value.pinned, false);
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:c1");
  assert.equal(m.sideTab.value, "chat");
  assert.equal(m.sideOpen.value, true);
});

test("a side chat's link shows that run's chat wherever the panel is, and setSideChat writes into the scope it's for", () => {
  // The panel pinned to r2 while you look at r1.
  m.route.value = { view: "run", id: "r2" };
  m.pinSide(true);
  m.route.value = { view: "run", id: "r1" };
  m.setSideChat("side:keep");
  assert.equal(m.sideScope.value.key, "run:r2");
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:keep");

  // The link in r1's thread: the panel follows r1 again, on that chat, and r2 keeps its own.
  m.openSideChat("r1", "c1");
  assert.equal(m.sideScope.value.key, "run:r1");
  assert.equal(m.sideScope.value.pinned, false);
  assert.equal(m.sideMemory.value["run:r1"].chat, "side:c1");
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:keep");
  assert.equal(m.sideTab.value, "chat");

  // From a page that isn't the run's (a chat of its own shown in the panel): the panel is pinned to the run.
  m.route.value = { view: "composer" };
  m.openSideChat("r2", "c2");
  assert.equal(m.sideScope.value.key, "run:r2");
  assert.equal(m.sideScope.value.pinned, true);
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:c2");

  // A chat started while the panel moved on lands in the run it was started for.
  m.setSideChat("side:c3", "run:r1");
  m.setSideChat("r9", "run:r1");
  assert.equal(m.sideMemory.value["run:r1"].chat, "r9");
  assert.deepEqual(m.sideMemory.value["run:r1"].chats, ["r9"]);
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:c2");
  assert.equal(m.sideMemory.value["run:r2"].chats, undefined);

  // A popped-out panel shows only its own run: another run's chat is the main window's to show.
  const main = otherWindow();
  Object.assign(globalThis, { opener: main });
  m.route.value = popped("run:r1", "chat");
  m.openSideChat("r2", "c4");
  assert.deepEqual(main.sent[0]!.msg, { type: "codeflow:open", route: { view: "run", id: "r2" }, drafts: [], sideChat: { run: "r2", chat: "c4" } });
  assert.equal(m.sideMemory.value["run:r1"].chat, "r9");
  assert.equal(m.sideMemory.value["run:r2"].chat, "side:c2");
  m.openSideChat("r1", "c5");
  assert.equal(m.sideMemory.value["run:r1"].chat, "side:c5");
  assert.equal(main.sent.length, 1);
  Object.assign(globalThis, { opener: null });
});

test("notifications: a run's review page counts as looking at the run", () => {
  const finished = run("r1", { status: "done", verdict: "passed" });
  m.route.value = { view: "review", id: "r1", branch: "codeflow/r1/claude" };
  m.notifyFinished(finished);
  m.route.value = { view: "run", id: "r1" };
  m.notifyFinished(finished);
  assert.deepEqual(notified, []);

  m.route.value = { view: "review", id: "r2", branch: "codeflow/r2/claude" };
  m.notifyFinished(finished);
  m.route.value = { view: "composer" };
  m.notifyFinished(finished);
  assert.deepEqual(notified, ["code-flow: run finished, with passing checks", "code-flow: run finished, with passing checks"]);
});
