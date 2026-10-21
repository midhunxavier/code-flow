// Fixes from a review of the UI, without a browser: agent output shown as markdown is never HTML
// and links only to http(s); links from the server only to http(s); answers that come back out of
// order; and "Edit & run again" from another repository keeping the run's own check, setup and
// settings. The UI is bundled the way build-ui does it and loaded with a stand-in window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const storage = new Map<string, string>();
/** What the stand-in server answers, by path (without the query); a function answers later. */
const answers: Record<string, (url: URL) => unknown | Promise<unknown>> = {};
const asked: string[] = [];
let m: any;

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    document: { addEventListener() {}, hidden: false },
    innerWidth: 1400,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/" },
    fetch: async (path: string) => {
      const url = new URL(path, "http://localhost");
      asked.push(`${url.pathname}${url.search}`);
      const answer = answers[url.pathname];
      if (!answer) return new Response(JSON.stringify({ error: "not here" }), { status: 404 });
      return new Response(JSON.stringify(await answer(url)), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export { markdownNodes } from "./bits.tsx";`,
        `export { latestOnly, safeHref } from "./lib.ts";`,
        `export { editAndRerun } from "./run.tsx";`,
        `export { applyPreset } from "./onboarding.tsx";`,
        `export { initializeProjectDrafts, checkCmd, limits, loadCheck, optionValues, patterns, repo, repoInfo, roleSel, route, setupCmd } from "./state.ts";`,
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
    loader: { ".png": "dataurl" },
    logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-ui-review-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
});

// ---------------------------------------------------------------- markdown
/** Every element and every piece of text in what Markdown shows for `text`. */
function rendered(text: string) {
  const elements: any[] = [];
  const texts: string[] = [];
  const walk = (node: any) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === "string" || typeof node === "number") texts.push(String(node));
    else if (node && typeof node === "object" && "props" in node) {
      elements.push(node);
      walk(node.props.children);
    }
  };
  walk(m.markdownNodes(text));
  return { elements, texts, types: new Set(elements.map((e) => e.type)), text: texts.join("") };
}

test("Markdown: raw HTML in agent output is text, never elements", () => {
  const out = rendered(
    [
      `Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>`,
      `- <a href="javascript:alert(3)">a list item</a>`,
      `> <iframe src="https://evil.example"></iframe>`,
      "`<b>code</b>` and **<u>bold</u>**",
      "```html\n<div onclick=\"alert(4)\">fenced</div>\n```",
    ].join("\n\n"),
  );
  for (const type of ["img", "script", "iframe", "u", "div"]) assert.ok(!out.types.has(type), `no <${type}> element`);
  assert.ok(!out.elements.some((e) => e.type === "a"), "the HTML link is not a link");
  for (const raw of [`<img src=x onerror="alert(1)">`, "<script>alert(2)</script>", `<a href="javascript:alert(3)">`, "<iframe", "<b>code</b>", "<u>bold</u>", `<div onclick="alert(4)">fenced</div>`]) {
    assert.ok(out.text.includes(raw), `shown as text: ${raw}`);
  }
  assert.ok(!out.elements.some((e) => Object.keys(e.props).some((k) => /^on|^dangerouslySetInnerHTML$/i.test(k))), "no handlers or inner HTML on any element");
});

test("Markdown: only http(s) links become links, opened without a referrer", () => {
  const out = rendered("[safe](https://example.com/a?b=1) [plain](http://localhost:3000/) [js](javascript:alert(1)) [JS](JAVASCRIPT:alert(1)) [data](data:text/html,hi) [vb](vbscript:msgbox) [rel](/etc/passwd)");
  const links = out.elements.filter((e) => e.type === "a");
  assert.deepEqual(
    links.map((a) => a.props.href),
    ["https://example.com/a?b=1", "http://localhost:3000/"],
  );
  for (const a of links) {
    assert.equal(a.props.rel, "noreferrer");
    assert.equal(a.props.target, "_blank");
  }
  for (const shown of ["[js](javascript:alert(1))", "[JS](JAVASCRIPT:alert(1))", "[data](data:text/html,hi)", "[vb](vbscript:msgbox)", "[rel](/etc/passwd)"]) {
    assert.ok(out.text.includes(shown), `left as text: ${shown}`);
  }
});

// ---------------------------------------------------------------- links from the server
test("safeHref: a server's link is a link only when it's http(s)", () => {
  for (const url of ["https://github.com/o/r/pull/1", "http://localhost:5173/", "HTTPS://GitHub.com/o/r/issues/2"]) assert.equal(m.safeHref(url), url);
  for (const url of ["javascript:alert(1)", " javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox", "file:///etc/passwd", "/relative/path", "#/run/x", "", "not a url", undefined, null, 42, { toString: () => "https://x.example" }]) {
    assert.equal(m.safeHref(url), undefined, `no link for ${String(url)}`);
  }
});

// ---------------------------------------------------------------- out-of-order answers
test("latestOnly: an older request's answer is stale once a newer one has started", () => {
  const begin = m.latestOnly();
  const first = begin();
  assert.equal(first(), true);
  const second = begin();
  assert.equal(first(), false, "the slow first answer is dropped");
  assert.equal(second(), true);
  // Each component (each tree, each viewer) counts its own.
  const other = m.latestOnly()();
  assert.equal(other(), true);
  assert.equal(second(), true);
});

// ---------------------------------------------------------------- edit & run again
test("Edit & run again from another repo: the run's check, setup, limits, team and options win, and persist", async () => {
  storage.clear();
  m.patterns.value = [{ id: "pipeline", name: "Plan → Build → Review", roles: [{ id: "planner", default: ["claude"] }, { id: "builder", default: ["claude"] }], options: [{ id: "rounds", default: 2 }] }];
  // The other repo has a setup in its config and a detected test command, found slowly: both
  // used to land after the run's own values and replace them.
  answers["/api/branches"] = (url) => ({ repo: url.searchParams.get("repo"), worktreeRoot: "/wt", current: "main", branches: [] });
  answers["/api/repo-config"] = () => ({ config: { setup: "npm ci" }, found: true });
  answers["/api/check"] = () => new Promise((resolve) => setTimeout(() => resolve({ command: "npm test", source: "package.json", setup: "npm ci" }), 40));
  assert.notEqual(m.repo.value, "/other");

  await m.initializeProjectDrafts();
  await m.editAndRerun({
    id: "r1",
    repo: "/other",
    task: "Fix the flaky test",
    pattern: "pipeline",
    roles: { builder: ["codex"] },
    options: { rounds: 3 },
    loop: { check: "make check", setup: "make deps", maxMinutes: 30, maxSteps: 12 },
    context: { paths: [{ path: "src/a.ts", type: "file" }] },
    worktrees: [],
    artifacts: [],
  });
  assert.deepEqual(m.route.value, { view: "composer", project: "" });

  assert.ok(asked.some((p) => p.startsWith("/api/check")), "the repo's own lookup ran");
  assert.equal(m.repo.value, "/other");
  assert.equal(m.checkCmd.value, "make check");
  assert.equal(m.setupCmd.value, "make deps");
  assert.equal(m.limits.value.maxMinutes, 30);
  assert.equal(m.limits.value.maxSteps, 12);
  assert.equal(m.limits.value.maxTokens, undefined);
  assert.equal(m.limits.value.maxCostUsd, undefined);
  // Through the setters: remembered like a choice made in the composer.
  assert.deepEqual(JSON.parse(storage.get("limits")!), { maxMinutes: 30, maxSteps: 12 });
  assert.deepEqual(JSON.parse(storage.get("roleSel")!).pipeline.builder, ["codex"]);
  assert.equal(m.roleSel.value.pipeline.builder[0], "codex");
  assert.equal(m.optionValues.value.pipeline.rounds, 3);
  assert.equal(storage.get("draftTask"), "Fix the flaky test");
});


test("preset command overrides survive late repository configuration without changing saved defaults", async () => {
  storage.clear();
  m.patterns.value = [{ id: "pipeline", roles: [{ id: "planner", default: ["agy"] }, { id: "builder", default: ["codex"] }], options: [] }];
  m.repoInfo.value = { repo: "/preset", current: "main", branches: [] };
  let respond!: (value: unknown) => void;
  answers["/api/repo-config"] = () => new Promise(resolve => { respond = resolve; });
  const loading = m.loadCheck();
  m.applyPreset({
    pattern: "pipeline", roles: { planner: ["agy"], builder: ["codex"] }, options: {},
    agentSettings: {}, roleSettings: {}, trust: "standard", limits: { maxMinutes: 30, maxSteps: 12 },
    approvePlan: false, check: "", setup: "",
  }, "Saved preset");
  respond({ config: { check: "repo-test", setup: "repo-setup" }, found: true });
  await loading;
  assert.equal(m.checkCmd.value, "", "the preset's intentional blank check wins");
  assert.equal(m.setupCmd.value, "", "the preset's intentional blank setup wins");
  assert.equal(storage.get(`check:${m.repo.value}`), undefined);
  assert.equal(storage.get(`setup:${m.repo.value}`), undefined);
});
