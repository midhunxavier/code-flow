// The composer's Improve (src/improve.ts): what the rewrite turn is told, how each CLI is asked
// (read-only, a schema, a fast model for Quick), and how failures are reported. Fake CLIs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-improve-home-"));
process.env.CODEFLOW_CODEX_TRANSPORT = "exec";

const { improveInstructions, improvePrompt, ImproveError } = await import("../src/improve.js");
type AgentId = import("../src/adapters/types.js").AgentId;

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
  assert.match(repo, /GitHub issue #6: Login is slow/);
  assert.match(repo, /- src\/login\.ts\n- notes\.pdf/);
  assert.ok(repo.endsWith("## Task to improve\n\nfix it"));
});

test("Quick asks Claude for a schema answer from a fast model, read-only, in the repository; Repo uses a stronger one", async () => {
  const repo = makeRepo();
  const quick = await recorded(() => improvePrompt("claude", { text: "add rate limits", repo, mode: "quick" }));
  assert.equal(quick.result.prompt, "Goal: add rate limits\n\nDone when: the tests pass.");
  assert.equal(quick.result.summary, "Stated the goal and when it's done (quick, claude).");
  const [call] = quick.calls;
  assert.ok(call);
  assert.equal(call.cwd, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim());
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
