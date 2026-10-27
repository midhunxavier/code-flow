// The composer's Improve (src/improve.ts): what the rewrite turn is told, how each CLI is asked
// (read-only, a schema, a fast model for Quick), and how failures are reported. Fake CLIs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-improve-home-"));
process.env.CODEFLOW_CODEX_TRANSPORT = "exec";

const { assertImproveEnvironment, improveInstructions, improvePrompt, ImproveError, IMPROVE_SNAPSHOT_LIMITS } = await import("../src/improve.js");
const { registerProviderAdapters } = await import("../src/adapters/index.js");
type AgentId = import("../src/adapters/types.js").AgentId;
type AgentAdapter = import("../src/adapters/types.js").AgentAdapter;
let providerNumber = 0;
function fixtureProvider(run: AgentAdapter["run"]): AgentId {
  const id: AgentId = `plugin:improve-fixture/${++providerNumber}`;
  registerProviderAdapters([{ id, displayName: "Fixture provider", binary: "fixture", available: async () => true, catalog: async () => ({ models: [], efforts: [], allowCustom: true }), run }]); return id;
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-improve-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return repo;
}

/** Run `fn` with these environment variables set (the fake CLIs read them when they start). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The arguments each fake CLI was started with, from FAKE_RECORD_DIR. */
async function recorded<T>(fn: () => Promise<T>): Promise<{ result: T; calls: { vendor: string; args: string[]; prompt: string; cwd: string }[] }> {
  const dir = mkdtempSync(join(tmpdir(), "codeflow-improve-rec-"));
  const result = await withEnv({ FAKE_RECORD_DIR: dir }, fn);
  return { result, calls: readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) };
}

test("the instructions keep the author's intent, say how to work, and end with the task itself", () => {
  const quick = improveInstructions({ text: "  make login faster \n", repo: "/r", mode: "quick" });
  assert.match(quick, /Don't do the task/);
  assert.match(quick, /Add no requirements/);
  assert.match(quick, /Open questions:/);
  assert.match(quick, /don't use tools or read files/);
  assert.doesNotMatch(quick, /look around the repository/);
  assert.ok(quick.endsWith("## Task to improve\n\nmake login faster"));

  const repo = improveInstructions({
    text: "fix it",
    repo: "/r",
    mode: "repo",
    context: ["src/login.ts", "notes.pdf"],
    source: { kind: "issue", number: 6, title: "Login is slow" },
  });
  assert.match(repo, /look around the repository first \(read-only/);
  assert.match(repo, /Name only files you've seen/);
  assert.match(repo, /GitHub issue #6\./);
  assert.doesNotMatch(repo, /Login is slow/);
  assert.match(repo, /- src\/login\.ts\n- notes\.pdf/);
  assert.ok(repo.endsWith("## Task to improve\n\nfix it"));
});

test("Quick asks Claude for a schema answer in a private empty repository; Repo uses a stronger model", async () => {
  const repo = makeRepo();
  const quick = await recorded(() => improvePrompt("claude", { text: "add rate limits", repo, mode: "quick" }));
  assert.equal(quick.result.prompt, "Goal: add rate limits\n\nDone when: the tests pass.");
  assert.equal(quick.result.summary, "Stated the goal and when it's done (quick, claude). Context: your text only; the project was not read.");
  const [call] = quick.calls;
  assert.ok(call);
  assert.notEqual(call.cwd, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim()); assert.equal(existsSync(call.cwd), false, "private context is removed after completion");
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert.equal(flag("--model"), "haiku");
  assert.ok(!call.args.includes("--effort"));
  assert.equal(flag("--permission-mode"), "default");
  assert.match(flag("--disallowedTools")!, /Edit/);
  assert.deepEqual(JSON.parse(flag("--json-schema")!).required, ["prompt", "summary"]);

  const deep = await recorded(() => improvePrompt("claude", { text: "add rate limits", repo, mode: "repo" }));
  const args = deep.calls[0]!.args;
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  assert.match(deep.result.summary, /\(repo, claude\)/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString(), "", "Improve changes nothing in the repository");
});

test("Improve forwards model and effort overrides, supports CLI defaults and refuses unsupported effort", async () => {
  const repo = makeRepo();
  try {
    for (const agent of ["claude", "codex", "agy"] as const) {
      const { calls } = await recorded(() => improvePrompt(agent, { text: "clarify this", repo, mode: "quick", settings: { model: agent === "claude" ? "sonnet" : "custom-model", effort: "high" } }));
      assert.ok(calls[0]!.args.includes(agent === "claude" ? "sonnet" : "custom-model"));
      assert.match(calls[0]!.args.join(" "), agent === "codex" ? /model_reasoning_effort="high"/ : /--effort high/);
    }
    const { calls } = await recorded(() => improvePrompt("claude", { text: "clarify", repo, mode: "repo", settings: { model: "", effort: "" } }));
    assert.ok(!calls[0]!.args.includes("--model")); assert.ok(!calls[0]!.args.includes("--effort"));
    await assert.rejects(improvePrompt("claude", { text: "clarify", repo, mode: "quick", settings: { model: "haiku", effort: "high" } }), /does not support high effort/);
    await assert.rejects(improvePrompt("codex", { text: "clarify", repo, mode: "quick", settings: { effort: "bogus" } }), /does not support bogus effort/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

for (const agent of ["codex", "agy"] as AgentId[]) {
  test(`${agent} rewrites the task too, read-only at low effort`, async () => {
    const repo = makeRepo();
    const { result, calls } = await recorded(() => improvePrompt(agent, { text: "speed up the build", repo, mode: "quick" }));
    assert.equal(result.prompt, "Goal: speed up the build\n\nDone when: the tests pass.");
    assert.match(result.summary, new RegExp(`quick, ${agent}`));
    const args = calls[0]!.args.join(" ");
    if (agent === "codex") assert.match(args, /sandbox_mode="read-only"/);
    else assert.match(args, /--sandbox/);
    assert.match(args, agent === "codex" ? /model_reasoning_effort="low"/ : /--effort low/);
  });
}

test("an answer without a rewritten task, a used-up plan and a signed-out CLI each fail with a reason", async () => {
  const repo = makeRepo();
  await assert.rejects(improvePrompt("claude", { text: "IMPROVE-EMPTY", repo, mode: "quick" }), (err: Error) => {
    assert.ok(err instanceof ImproveError);
    assert.equal(err.message, "Claude Code didn't return a rewritten task. Try again.");
    return true;
  });
  await withEnv({ FAKE_CLAUDE_FAIL: "rejected", FAKE_CLAUDE_RESETS_AT: "1792092600" }, () =>
    assert.rejects(improvePrompt("claude", { text: "x", repo, mode: "quick" }), (err: InstanceType<typeof ImproveError>) => {
      assert.equal(err.kind, "usage_limit");
      assert.equal(err.resetsAt, 1792092600 * 1000);
      assert.match(err.message, /Claude Code hit its usage limit/);
      return true;
    }),
  );
  await withEnv({ FAKE_CLAUDE_FAIL: "auth" }, () =>
    assert.rejects(improvePrompt("claude", { text: "x", repo, mode: "quick" }), (err: InstanceType<typeof ImproveError>) => {
      assert.equal(err.kind, "auth");
      assert.match(err.message, /isn't signed in/);
      return true;
    }),
  );
});

test("stopping the request stops the turn", async () => {
  const repo = makeRepo();
  const stop = new AbortController();
  const started = Date.now();
  const turn = withEnv({ FAKE_SLEEP_MS: "20000" }, () => improvePrompt("claude", { text: "x", repo, mode: "quick" }, { signal: stop.signal }));
  setTimeout(() => stop.abort(), 300);
  await assert.rejects(turn, (err: InstanceType<typeof ImproveError>) => {
    assert.equal(err.kind, "cancelled");
    return true;
  });
  assert.ok(Date.now() - started < 10_000, "the CLI was stopped, not waited for");
});

test("private improvement discards a fake CLI's edits and commits without touching pre-existing source work", async () => {
  const repo = makeRepo(), git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    writeFileSync(join(repo, "README.md"), "staged work\n"); git("add", "README.md"); const staged = git("write-tree"), head = git("rev-parse", "HEAD"); writeFileSync(join(repo, "README.md"), "unstaged work\n"); writeFileSync(join(repo, "draft.txt"), "draft work\n");
    await improvePrompt("claude", { text: "SNEAKY COMMITS-IN-READ improve the description", repo, mode: "repo" });
    assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("write-tree"), staged); assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "unstaged work\n"); assert.equal(readFileSync(join(repo, "draft.txt"), "utf8"), "draft work\n"); assert.equal(existsSync(join(repo, "sneaky.txt")), false); assert.equal(existsSync(join(repo, "committed-in-read.txt")), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

for (const outcome of ["failure", "throw", "cancel"] as const) test(`plugin providers keep safe read-only options and discard private edits on ${outcome}`, async () => {
  const repo = makeRepo(), stop = new AbortController(); let privatePath = "";
  try {
    writeFileSync(join(repo, "draft.txt"), "existing draft\n");
    const provider = fixtureProvider(async (options) => {
      privatePath = options.cwd; assert.notEqual(privatePath, repo); assert.deepEqual(execFileSync("git", ["ls-files"], { cwd: privatePath, encoding: "utf8" }).trim(), "", "Quick copies no source files");
      assert.equal(options.mode, "read"); assert.equal(options.trust, "safe"); assert.equal(options.interactiveApprovals, false); assert.equal(options.questionProtocol, "structured"); assert.equal(options.model, undefined); assert.equal(options.effort, undefined);
      writeFileSync(join(options.cwd, "README.md"), "provider edit\n"); writeFileSync(join(options.cwd, "draft.txt"), "provider draft edit\n"); writeFileSync(join(options.cwd, "sneaky.txt"), "new edit\n");
      if (outcome === "throw") throw new Error("fixture dispatch threw");
      if (outcome === "failure") return { ok: false, finalText: "", error: "fixture failure", errorKind: "transient" };
      stop.abort(); return { ok: true, finalText: "", structured: { prompt: "stale result", summary: "must be discarded" } };
    });
    await assert.rejects(improvePrompt(provider, { text: "rewrite", repo, mode: "quick" }, { signal: stop.signal }), (error: InstanceType<typeof ImproveError>) => { assert.ok(error instanceof ImproveError); assert.equal(error.kind, outcome === "cancel" ? "cancelled" : outcome === "throw" ? "other" : "transient"); return true; });
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "hi\n"); assert.equal(readFileSync(join(repo, "draft.txt"), "utf8"), "existing draft\n"); assert.equal(existsSync(join(repo, "sneaky.txt")), false); assert.equal(existsSync(privatePath), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("missing providers, pre-aborted requests and oversized or extra answer fields fail closed", async () => {
  const repo = makeRepo(); let calls = 0;
  try {
    await assert.rejects(improvePrompt("plugin:improve-missing", { text: "rewrite", repo, mode: "quick" }), (error: InstanceType<typeof ImproveError>) => error instanceof ImproveError && /unavailable/.test(error.message));
    const provider = fixtureProvider(async () => { calls++; return { ok: true, finalText: "", structured: { prompt: "x", summary: "done" } }; }), stop = new AbortController(); stop.abort();
    await assert.rejects(improvePrompt(provider, { text: "rewrite", repo, mode: "quick" }, { signal: stop.signal }), (error: InstanceType<typeof ImproveError>) => error.kind === "cancelled"); assert.equal(calls, 0);
    for (const answer of [{ prompt: "x".repeat(20_001), summary: "done" }, { prompt: "x", summary: "x".repeat(1001) }, { prompt: "x", summary: "done", command: "must not run" }]) {
      const invalid = fixtureProvider(async () => ({ ok: true, finalText: "", structured: answer })); await assert.rejects(improvePrompt(invalid, { text: "rewrite", repo, mode: "quick" }), /didn't return a rewritten task/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("Repo context has a private Git namespace, omits executable settings and preserves real external source edits during the turn", async () => {
  const repo = makeRepo(), git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" }).trim();
  let enter!: () => void, release!: () => void, privatePath = ""; const entered = new Promise<void>((done) => enter = done), released = new Promise<void>((done) => release = done);
  try {
    for (const path of [".claude/settings.json", ".codex/config.toml", ".gemini/settings.json"]) { mkdirSync(join(repo, path.split("/")[0]!), { recursive: true }); writeFileSync(join(repo, path), "SOURCE_EXECUTABLE_SETTINGS_SENTINEL"); }
    writeFileSync(join(repo, ".mcp.json"), "SOURCE_MCP_SENTINEL"); writeFileSync(join(repo, ".gitattributes"), "README.md filter=source-hook\n"); writeFileSync(join(repo, ".env"), "SOURCE_SECRET_SENTINEL"); writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 255, 1, 128])); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "committed context"); git("remote", "add", "origin", "https://example.invalid/SOURCE_REMOTE_SENTINEL.git"); const pinned = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "preexisting staged work\n"); git("add", "README.md"); writeFileSync(join(repo, "README.md"), "preexisting unstaged work\n"); writeFileSync(join(repo, "draft.txt"), "preexisting draft\n");
    const provider = fixtureProvider(async (options) => {
      privatePath = options.cwd; assert.notEqual(privatePath, repo); assert.equal(readFileSync(join(privatePath, "README.md"), "utf8"), "hi\n"); assert.deepEqual(readFileSync(join(privatePath, "binary.bin")), Buffer.from([0, 255, 1, 128]));
      for (const path of [".claude", ".codex", ".gemini", ".mcp.json", ".gitattributes", ".env", "draft.txt"]) assert.equal(existsSync(join(privatePath, path)), false, path);
      assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: privatePath, encoding: "utf8" }).trim(), "1"); assert.equal(execFileSync("git", ["remote"], { cwd: privatePath, encoding: "utf8" }).trim(), ""); assert.doesNotMatch(readFileSync(join(privatePath, ".git/config"), "utf8"), /SOURCE_REMOTE_SENTINEL/); assert.match(options.prompt, new RegExp(pinned));
      enter(); await released; writeFileSync(join(privatePath, "README.md"), "private provider edit\n"); return { ok: true, finalText: "", structured: { prompt: "Rewrite complete", summary: "s".repeat(1000) } };
    });
    const turn = improvePrompt(provider, { text: "rewrite", repo, mode: "repo" }); await entered;
    writeFileSync(join(repo, "README.md"), "external committed work\n"); git("add", "README.md"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "external user commit"); const liveHead = git("rev-parse", "HEAD"); writeFileSync(join(repo, "README.md"), "external staged work\n"); git("add", "README.md"); writeFileSync(join(repo, "README.md"), "external unstaged work\n"); writeFileSync(join(repo, "draft.txt"), "external updated draft\n"); writeFileSync(join(repo, "new-user-file.txt"), "external new draft\n"); const index = readFileSync(join(repo, ".git/index")), status = git("status", "--porcelain");
    release(); const result = await turn; assert.equal(git("rev-parse", "HEAD"), liveHead); assert.deepEqual(readFileSync(join(repo, ".git/index")), index); assert.equal(git("status", "--porcelain"), status); assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "external unstaged work\n"); assert.equal(readFileSync(join(repo, "draft.txt"), "utf8"), "external updated draft\n"); assert.equal(readFileSync(join(repo, "new-user-file.txt"), "utf8"), "external new draft\n"); assert.equal(existsSync(privatePath), false); assert.match(result.summary, new RegExp(`committed HEAD ${pinned}`)); assert.doesNotMatch(result.summary, new RegExp(liveHead)); assert.match(result.summary, /6 provider, credential or Git configuration files excluded/); assert.ok(result.summary.length <= 1000);
  } finally { release?.(); rmSync(repo, { recursive: true, force: true }); }
});

test("Repo snapshots refuse symlinks, Gitlinks and oversized committed files before provider dispatch", async () => {
  for (const kind of ["symlink", "Gitlink", "large file"] as const) {
    const repo = makeRepo(), git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); let calls = 0;
    try {
      if (kind === "symlink") symlinkSync("README.md", join(repo, "link")); else if (kind === "Gitlink") git("update-index", "--add", "--cacheinfo", "160000", git("rev-parse", "HEAD"), "submodule"); else writeFileSync(join(repo, "large.bin"), Buffer.alloc(IMPROVE_SNAPSHOT_LIMITS.fileBytes + 1));
      if (kind !== "Gitlink") git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "unsupported context"); const provider = fixtureProvider(async () => { calls++; return { ok: true, finalText: "", structured: { prompt: "x", summary: "done" } }; });
      await assert.rejects(improvePrompt(provider, { text: "rewrite", repo, mode: "repo" }), /refuses symlinks and Gitlinks|snapshot exceeds/); assert.equal(calls, 0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test("inherited Git routing, object, namespace and configuration overrides refuse dispatch without exposing values", async () => {
  const repo = makeRepo(); let calls = 0; const provider = fixtureProvider(async () => { calls++; return { ok: true, finalText: "", structured: { prompt: "x", summary: "done" } }; });
  try {
    for (const variable of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_EXEC_PATH", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_GLOBAL"]) await withEnv({ [variable]: "PRIVATE_OVERRIDE_VALUE" }, () => assert.rejects(improvePrompt(provider, { text: "rewrite", repo, mode: "quick" }), (error: Error) => error instanceof ImproveError && error.message.includes(variable) && !error.message.includes("PRIVATE_OVERRIDE_VALUE")));
    assert.equal(calls, 0); assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "hi\n");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("relative or empty PATH cannot execute committed Git/provider impostors, and Windows lookup fails closed", async () => {
  const repo = makeRepo(), marker = join(repo, "IMPOSTOR_EXECUTED"); let calls = 0;
  try {
    for (const binary of ["git", "claude", "codex", "agy"]) writeFileSync(join(repo, binary), `#!/bin/sh\nprintf 'bad' > '${marker.replace(/'/g, "'\\''")}'\nexit 1\n`, { mode: 0o700 }); execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "executable impostors"], { cwd: repo });
    const provider = fixtureProvider(async () => { calls++; return { ok: true, finalText: "", structured: { prompt: "x", summary: "done" } }; });
    for (const prefix of [".", "relative-bin", ""]) await withEnv({ PATH: `${prefix}:${process.env.PATH}` }, () => assert.rejects(improvePrompt(provider, { text: "rewrite", repo, mode: "repo" }), (error: Error) => error instanceof ImproveError && /PATH/.test(error.message) && !error.message.includes("relative-bin")));
    assert.equal(calls, 0); assert.equal(existsSync(marker), false); assert.throws(() => assertImproveEnvironment({ PATH: "/usr/bin" }, "win32"), /Windows is unavailable/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
