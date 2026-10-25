// The side panel's Browser, without a browser: which addresses from the previewed page are
// believed, how pins read as a message, and where pins can be sent. ui/browser.tsx is bundled
// with esbuild, with the UI modules it imports (state, lib, icons, side-chat) stubbed out, so
// only its own code and panel-bits run.
import { parseBrowserMessage } from "../ui/browser-context.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SideScope } from "../ui/state.js";
import type { RunSummary } from "../ui/types.js";

const root = fileURLToPath(new URL("..", import.meta.url));

// CommonJS stubs: a name the code imports that a stub doesn't have is undefined, not a build error.
const STUBS: Record<string, string> = {
  state: `
    const { signal } = require("@preact/signals");
    const sideMemo = signal({ at: 0 });
    module.exports = {
      runs: signal(new Map()),
      sideMemo,
      sideMemory: signal({}),
      sideScope: signal({ key: "none", kind: "project", repo: "", pinned: false }),
      route: signal({ view: "composer" }),
      rememberSide: (patch) => (sideMemo.value = { ...sideMemo.value, ...patch }),
      draftTo() {},
      openSide() {},
      setSideChat() {},
      projectKeyOf: () => "none",
    };`,
  lib: `module.exports = { onPhone: false, api: async () => [], post: async () => ({}), baseName: (p) => p.split("/").pop(), showToast() {} };`,
  icons: `module.exports = { Icon: () => null };`,
  "side-chat": `module.exports = { sideChatsOf: () => [] };`,
};

type Browser = typeof import("../ui/browser.js") & { state: { runs: { value: Map<string, RunSummary> }; sideMemo: { value: Record<string, unknown> } } };
let browser: Browser;

before(async () => {
  const result = await build({
    stdin: { contents: `export * from "./browser.tsx"; export * as state from "./state.js";`, resolveDir: join(root, "ui"), loader: "ts" },
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "stub-ui",
        setup(b) {
          b.onResolve({ filter: /^\.\/[\w-]+\.js$/ }, (args) => {
            const name = args.path.slice(2, -3);
            return ["panel-bits", "browser-context"].includes(name) ? undefined : { path: name, namespace: "stub" };
          });
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path] ?? "module.exports = {};", loader: "js", resolveDir: root }));
        },
      },
    ],
  });
  browser = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`);
});

test("Browser: an address from the previewed page is believed only on the preview's own origin", () => {
  const preview = "http://127.0.0.1:5555";
  const app = "http://localhost:3000";
  assert.equal(browser.appAddress("http://127.0.0.1:5555/dashboard?tab=1#top", preview, app), "http://localhost:3000/dashboard?tab=1#top");
  assert.equal(browser.appAddress("http://127.0.0.1:5555/?next=http://127.0.0.1:5555/x", preview, app), "http://localhost:3000/?next=http://127.0.0.1:5555/x", "only the origin in front is the preview's");
  assert.equal(browser.appAddress(preview, preview, app), app);
  for (const reported of [
    "https://phish.example/login",
    "javascript:alert(1)//http://127.0.0.1:5555/",
    "data:text/html,http://127.0.0.1:5555/",
    "http://127.0.0.1:55556/",
    "http://127.0.0.1:5555@phish.example/",
    undefined,
    42,
    { toString: () => "http://127.0.0.1:5555/" },
  ]) {
    assert.equal(browser.appAddress(reported, preview, app), undefined, String(reported));
  }
});

test("Browser: pins on different pages say where each was, and each lot's snapshots have names of their own", () => {
  type Pin = Parameters<typeof browser.pinsMessage>[0][number];
  const pin = (n: number, url: string, image?: string): Pin => ({ n, id: `d1:${n}`, kind: "element", selector: `#b${n}`, text: "", rect: { x: 0, y: 0, w: 10, h: 10 }, url, viewport: { w: 1200, h: 800 }, image, comment: `fix ${n}` });
  const first = browser.pinsMessage([pin(1, "http://localhost:3000/dashboard", "data:image/png;base64,AAAA"), pin(2, "http://localhost:3000/settings", "data:image/png;base64,BBBB")], [], 1);
  assert.deepEqual(parseBrowserMessage(first.text).contexts.map(c => [c.url, c.selector, c.comment, c.snapshot]), [
    ["http://localhost:3000/dashboard", "#b1", "fix 1", "pin-1-1.png"],
    ["http://localhost:3000/settings", "#b2", "fix 2", "pin-1-2.png"],
  ]);
  assert.deepEqual(
    first.images.map((i) => [i.name, i.data]),
    [
      ["pin-1-1.png", "AAAA"],
      ["pin-1-2.png", "BBBB"],
    ],
  );
  // A second lot for the same message box numbers its pins from 1 again, but its snapshots aren't the first lot's.
  const second = browser.pinsMessage([pin(1, "http://localhost:3000/dashboard", "data:image/png;base64,CCCC")], [], 2);
  assert.equal(parseBrowserMessage(second.text).contexts[0]?.snapshot, "pin-2-1.png");
  assert.deepEqual(second.images.map((i) => i.name), ["pin-2-1.png"]);
});

test("Browser: pins are offered only where a message box will take them", () => {
  const run = (over: Partial<RunSummary>) => ({ id: "r1", status: "done", task: "Build it", worktrees: [], artifacts: [], followUps: [], ...over }) as unknown as RunSummary;
  const scope = (r?: RunSummary): SideScope => ({ key: r ? `run:${r.id}` : "repo:/repo", kind: r ? "run" : "project", run: r, repo: "/repo", pinned: false });
  const keys = (s: SideScope) => browser.destinations(s).map((d) => d.key);
  const worktree = { name: "claude", path: "/repo/.worktrees/r1-claude", branch: "cf/r1-claude" } as RunSummary["worktrees"][number];

  assert.deepEqual(keys(scope(run({ worktrees: [worktree] }))), ["main:r1", "side:new", "composer"]);
  assert.deepEqual(keys(scope(run({ status: "running", worktrees: [worktree] }))), ["main:r1", "side:new", "composer"]);
  assert.deepEqual(keys(scope(run({}))), ["main:r1", "composer"], "no worktree for a new side chat to work in");
  assert.deepEqual(keys(scope(run({ status: "failed", worktrees: [worktree] }))), ["composer"], "a failed run has no message box");

  // Chats open in the strip: the ones going or finished; a failed or stopped one shows no message box.
  browser.state.runs.value = new Map((["failed", "done", "stopped", "running", "interrupted"] as const).map((status, i) => [`c${i}`, run({ id: `c${i}`, status })]));
  browser.state.sideMemo.value = { at: 0, chats: ["c0", "c1", "c2", "c3", "c4", "gone"] };
  assert.deepEqual(keys(scope()), ["main:c1", "main:c3", "composer"]);
});
