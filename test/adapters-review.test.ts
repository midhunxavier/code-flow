// Review follow-ups in the adapters: what Claude's read-only git commands may not do, error kinds
// read from the CLI's own words (not hooks' or MCP servers' stderr), Codex app-server falling back
// when it rejects a resume's parameters, and CLI output code-flow doesn't know made visible.
// Fake CLIs only (test/fake-bin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-adapters-review-home-"));

const { adapters, getAdapter } = await import("../src/adapters/index.js");
const { appServerCheck } = await import("../src/adapters/codex.js");
const { classifyError, cliErrorLine } = await import("../src/adapters/errors.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;
type AgentId = import("../src/adapters/types.js").AgentId;
type RunOptions = import("../src/adapters/types.js").RunOptions;

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `codeflow-adapters-review-${name}-`));
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

async function turn(agent: AgentId, extra: Partial<RunOptions> = {}, prompt = "Look around") {
  const events: AgentEvent[] = [];
  const result = await getAdapter(agent).run({ prompt, cwd: tmp("cwd"), mode: "read", ...extra }, (e) => events.push(e));
  return { result, events, statuses: events.flatMap((e) => (e.kind === "status" ? [e.text] : [])) };
}

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

test("Claude: git diff/log/show can't write with --output or read any file with --no-index, wherever the shell is limited", async () => {
  const dir = tmp("record");
  const modes: [string, Partial<RunOptions>][] = [
    ["read", { mode: "read" }],
    ["safe", { mode: "write", trust: "safe" }],
    ["standard", { mode: "write", trust: "standard" }],
    ["trusted", { mode: "write", trust: "trusted" }],
    ["full", { mode: "write", trust: "full" }],
  ];
  const denied: Record<string, string[]> = {};
  const allowed: Record<string, string[]> = {};
  for (const [name, extra] of modes) {
    const before = new Set(readdirSync(dir));
    await withEnv({ FAKE_RECORD_DIR: dir }, () => turn("claude", extra));
    const file = readdirSync(dir).find((f) => !before.has(f))!;
    const { args } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { args: string[] };
    // Every value the flag takes (`<tools...>`: up to the next option), each a comma-separated list.
    const value = (flag: string) => {
      if (!args.includes(flag)) return [];
      const rest = args.slice(args.indexOf(flag) + 1);
      const end = rest.findIndex((a) => a.startsWith("-"));
      return rest.slice(0, end === -1 ? undefined : end).flatMap((v) => v.split(","));
    };
    denied[name] = value("--disallowedTools");
    allowed[name] = value("--allowedTools");
  }
  for (const name of ["read", "safe", "standard"]) {
    assert.ok(allowed[name]!.includes("Bash(git log *)"), `${name}: git log is allowed`);
    for (const rule of ["Bash(git *--out*)", "Bash(git *--no-index*)"]) assert.ok(denied[name]!.includes(rule), `${name} denies ${rule}: ${denied[name]}`);
  }
  // Read steps still deny the edit tools first (other checks read the flag's start).
  assert.deepEqual(denied.read!.slice(0, 3), ["Edit", "Write", "NotebookEdit"]);
  // Trusted allows any command, and Full access skips permission checks: no git rules to add.
  assert.ok(allowed.trusted!.includes("Bash"));
  assert.ok(!denied.trusted!.some((r) => r.startsWith("Bash(git")));
  assert.deepEqual(denied.full, []);
});

test("Claude's rules, as globs, catch --output in any position and abbreviated, quoted or not", () => {
  // Claude Code's Bash rules: `*` matches any run of characters, the rest literally.
  const glob = (rule: string) => new RegExp(`^${rule.slice("Bash(".length, -1).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const deny = ["Bash(git *--out*)", "Bash(git *--no-index*)"].map(glob);
  for (const cmd of [
    "git log -1 --format=%B --output=/Users/me/.zshrc",
    "git diff --output /tmp/x",
    "git show HEAD --outp=/tmp/x",
    "git log '--output=/tmp/x'",
    "git diff --no-index /etc/passwd /dev/null",
    "git diff --stat --no-index a b",
  ]) {
    assert.ok(deny.some((re) => re.test(cmd)), cmd);
  }
  for (const cmd of ["git log --oneline -5", "git diff HEAD~1 -- src/output.ts", "git show HEAD:README.md", "git status --short"]) {
    assert.ok(!deny.some((re) => re.test(cmd)), cmd);
  }
});

test("error kinds come from the CLI's own error, not from what hooks and MCP servers print to stderr", async () => {
  const noise = [
    "[mcp:github] request failed: 401 Unauthorized",
    "[hook] You've hit your usage limit for the lint service",
    "RESOURCE_EXHAUSTED: quota exceeded",
  ].join("\n");
  for (const agent of ["claude", "codex", "agy"] as AgentId[]) {
    const { result } = await withEnv({ FAKE_CRASH_VENDOR: agent, FAKE_STDERR_NOISE: noise, CODEFLOW_CODEX_TRANSPORT: "exec" }, () => turn(agent));
    assert.equal(result.ok, false, agent);
    assert.equal(result.errorKind, "other", `${agent}: ${result.errorKind} from ${result.error}`);
    assert.equal(result.resetsAt, undefined, agent);
  }
  // The CLI's own error line still decides: a resume of a conversation that's gone.
  const gone = await withEnv({ FAKE_INVALID_SESSION_VENDOR: "codex", FAKE_STDERR_NOISE: noise, CODEFLOW_CODEX_TRANSPORT: "exec" }, () =>
    turn("codex", { resumeSessionId: "dead-thread" }),
  );
  assert.equal(gone.result.errorKind, "session_not_found", gone.result.error);

  assert.equal(cliErrorLine("[mcp] 401 Unauthorized\nerror: unexpected argument '--x' found\n\nUsage: codex exec [OPTIONS]"), "error: unexpected argument '--x' found");
  assert.equal(cliErrorLine("hook output\nNo conversation found with session ID: abc"), "No conversation found with session ID: abc");
  assert.equal(cliErrorLine(""), "");
});

test("a per-minute RESOURCE_EXHAUSTED is a rate limit; only the plan's or the day's quota is a usage limit", async () => {
  const cases: [string, string][] = [
    ["Quota exceeded for quota metric 'Generate Content API requests per minute' and limit 'GenerateContent request limit per minute'", "rate_limit"],
    ["Resource has been exhausted (e.g. check quota).", "rate_limit"],
    ["You have exhausted your daily quota for this model.", "usage_limit"],
    ["Your plan's usage limit has been reached. Try again in 3 hours.", "usage_limit"],
  ];
  for (const [message, kind] of cases) {
    const { result } = await withEnv({ FAKE_AGY_STATUS: "RESOURCE_EXHAUSTED", FAKE_AGY_ERROR: message }, () => turn("agy"));
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, kind, message);
  }

  const texts: [string, string][] = [
    ["429 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).", "rate_limit"],
    ["RESOURCE_EXHAUSTED: daily limit for this plan reached", "usage_limit"],
    ["Quota exceeded for quota metric 'requests' and limit 'requests per minute per user'", "rate_limit"],
    ["Context limit reached · /compact or /clear to continue", "other"],
    ["5-hour limit reached ∙ resets 3pm", "usage_limit"],
    ["Weekly limit reached ∙ resets Oct 9", "usage_limit"],
  ];
  for (const [text, kind] of texts) assert.equal(classifyError(text), kind, text);
});

test("Codex app-server: a resume whose parameters it rejects (-32602) falls back to codex exec resume", async () => {
  const dir = tmp("record");
  try {
    const first = await turn("codex", {}, "Look around");
    assert.ok(first.result.ok, first.result.error);
    const { result, statuses } = await withEnv({ FAKE_CODEX_RESUME_REJECTS_PARAMS: "1", FAKE_RECORD_DIR: dir }, () =>
      turn("codex", { resumeSessionId: first.result.sessionId }, "And again"),
    );
    assert.ok(result.ok, `${result.errorKind}: ${result.error}`);
    assert.ok(statuses.some((s) => /app-server isn't available \(Invalid request: unknown field `excludeTurns`\); using codex exec/.test(s)), statuses.join("\n"));
    const exec = recorded(dir).find((c) => c.args?.[0] === "exec");
    assert.deepEqual(exec?.args.slice(0, 2), ["exec", "resume"], "the thread is continued, not started over");
    assert.ok(exec?.args.includes(first.result.sessionId));
  } finally {
    appServerCheck.missing = undefined;
  }
  // A thread that's gone is still that, not a reason to fall back.
  const gone = await turn("codex", { resumeSessionId: "no-such-thread" });
  assert.equal(gone.result.errorKind, "session_not_found", gone.result.error);
  assert.equal(appServerCheck.missing, undefined);
});

test("events a CLI prints that code-flow doesn't know are named once per turn", async () => {
  const claude = await withEnv({ FAKE_DRIFT_VENDOR: "claude" }, () => turn("claude"));
  assert.ok(claude.result.ok, claude.result.error);
  assert.equal(claude.result.finalText, "claude handled the request.");
  const line = claude.statuses.filter((s) => /code-flow doesn't know/.test(s));
  assert.equal(line.length, 1, "one line per turn");
  assert.match(line[0]!, /^claude emitted 3 events code-flow doesn't know: future_event \(2\), citation block\./);
  assert.doesNotMatch(line[0]!, /stream_event/, "a type it ignores on purpose isn't reported");

  const agy = await withEnv({ FAKE_DRIFT_VENDOR: "agy" }, () => turn("agy"));
  assert.ok(agy.result.ok, agy.result.error);
  assert.ok(agy.statuses.some((s) => /^agy emitted 1 event code-flow doesn't know: future_event\./.test(s)), agy.statuses.join("\n"));

  // Nothing unknown, nothing said.
  for (const agent of ["claude", "codex", "agy"] as AgentId[]) {
    const plain = await withEnv({ CODEFLOW_CODEX_TRANSPORT: "exec" }, () => turn(agent));
    assert.ok(!plain.statuses.some((s) => /code-flow doesn't know/.test(s)), `${agent}: ${plain.statuses.join("\n")}`);
  }
  const served = await turn("codex");
  assert.ok(served.result.ok, served.result.error);
  assert.ok(!served.statuses.some((s) => /code-flow doesn't know/.test(s)), served.statuses.join("\n"));
});

test("Codex: a finished turn whose answer came in a form code-flow doesn't know fails as cli_incompatible, both transports", async () => {
  for (const transport of ["exec", "app-server"]) {
    const { result, statuses } = await withEnv({ FAKE_DRIFT_VENDOR: "codex", CODEFLOW_CODEX_TRANSPORT: transport }, () => turn("codex"));
    assert.equal(result.ok, false, transport);
    assert.equal(result.errorKind, "cli_incompatible", `${transport}: ${result.error}`);
    assert.match(result.error!, /didn't recognise its output.*Update codex-cli or code-flow/);
    assert.ok(result.sessionId, `${transport}: the thread is kept, a later turn can resume it`);
    const unknown = transport === "exec" ? /agent_reply item/ : /turn\/insights\/updated, agentReply item/;
    assert.ok(statuses.some((s) => /^codex emitted \d+ events? code-flow doesn't know/.test(s) && unknown.test(s)), `${transport}: ${statuses.join("\n")}`);
  }
});
