import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "codeflow-agy-recovery-"));
process.env.CODEFLOW_HOME = root;
const { createAgyAdapter } = await import("../src/adapters/agy.js");
const { createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;
type RunOptions = import("../src/adapters/types.js").RunOptions;
after(async () => { await rm(root, { recursive: true, force: true }); });

// Inject a synthetic process at the construction boundary: no real login, secrets or network.
function fixture(stdout: unknown[], stderr = "", mode: "read" | "write" = "write", holdOpen = false, nativeLog = "") {
  let prepared = 0, cleaned = 0;
  const launches: RunOptions[] = [];
  const adapter = createAgyAdapter(async opts => {
    prepared++; launches.push(opts);
    await writeFile(join(root, "native-auth.log"), nativeLog, { mode: 0o600 });
    return {
      root, paths: { workspace: root, home: join(root, `fresh-${prepared}`), scratch: root, binary: process.execPath, keychains: root, securityCache: root, securityLock: root },
      command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(stdout.map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n") + "\n")});process.stderr.write(${JSON.stringify(stderr)});${holdOpen ? "setInterval(() => {}, 1000);" : ""}`, "--"], env: {},
      cleanup: async () => { cleaned++; await rm(join(root, "native-auth.log"), { force: true }); },
    };
  });
  // Receipt construction is platform independent; real runtime validation remains in production.
  const permissions: RunOptions["permissions"] = { ...resolveRunPermissions({ policy: createRunPermissions("standard", false, false), provider: "codex", mode, currentTrust: "standard", currentTools: false }), provider: "agy", isolation: "os-sandbox", implementation: "macos-file-only-v1", commandNetwork: "denied", externalTools: "disabled" };
  const opts: RunOptions = { cwd: root, prompt: "Portable checkpoint: preserve existing changes", mode, trust: "standard", permissions };
  const run = async (patch: Partial<RunOptions> = {}) => {
    const events: AgentEvent[] = [];
    const result = await adapter.run({ ...opts, ...patch }, e => events.push(e));
    return { result, events };
  };
  return { adapter, opts, run, launches, counts: () => ({ prepared, cleaned }) };
}

test("expired, revoked and locked logins are auth failures without persisted native diagnostics", async () => {
  for (const detail of ["authentication failed or timed out", "Please sign in", "invalid_grant", "failed to retrieve token: secret keyring is locked", "failed to refresh access token", "User interaction is not allowed"]) {
    const sensitive = `${detail} SYNTHETIC_SECRET https://example.invalid/oauth?code=SYNTHETIC_CODE`;
    const f = fixture([sensitive, { event: "init", conversation_id: "private-native-session" }, { event: "step_update", step_update: { step_type: "agent_response", text_delta: sensitive } }, { event: "result", result: { status: "ERROR", error: sensitive, response: sensitive } }], sensitive);
    const { result, events } = await f.run();
    assert.equal(result.ok, false, detail);
    assert.equal(result.errorKind, "auth", detail);
    assert.equal(result.sessionId, undefined);
    assert.equal(result.finalText, "");
    assert.match(result.error!, /fresh isolated turn/);
    assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET|SYNTHETIC_CODE|private-native-session/);
    assert.deepEqual(f.counts(), { prepared: 1, cleaned: 1 });
  }
});

test("authentication failures without a result and other native errors remain private", async () => {
  for (const [stderr, expected] of [["Error: 401 Unauthorized SYNTHETIC_SECRET", "auth"], ["Error: failed to retrieve token: keychain locked SYNTHETIC_SECRET", "auth"], ["Error: unexpected native error SYNTHETIC_SECRET", "other"]]) {
    const f = fixture([], stderr);
    const { result, events } = await f.run();
    assert.equal(result.errorKind, expected);
    assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET/);
  }
});

test("recovery refuses native sessions and starts fresh with the same effective permissions", async () => {
  const f = fixture([{ event: "init", conversation_id: "native" }, { event: "result", result: { status: "SUCCESS", response: "Recovered" } }]);
  assert.equal((await f.run({ resumeSessionId: "old-native" })).result.errorKind, "session_not_found");
  assert.deepEqual(f.counts(), { prepared: 0, cleaned: 0 });
  for (let i = 0; i < 2; i++) {
    const { result, events } = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, undefined);
    assert.ok(events.every(e => e.kind !== "session"));
  }
  assert.deepEqual(f.counts(), { prepared: 2, cleaned: 2 });
  for (const launch of f.launches) {
    assert.deepEqual(launch.permissions, f.opts.permissions);
    assert.match(launch.prompt, /Portable checkpoint/);
    assert.equal(launch.resumeSessionId, undefined);
  }
});

test("unexpected tools fail closed even if followed by success; read turns also reject write tools", async () => {
  for (const [name, mode] of [["run_command", "write"], ["browser_subagent", "write"], ["invoke_subagent", "write"], ["call_mcp_tool", "write"], ["write_to_file", "read"]] as const) {
    const f = fixture([{ event: "step_update", step_update: { step_type: "tool", tool_name: name, state: "ACTIVE", tool_info: { parameters: "SYNTHETIC_SECRET" } } }, { event: "result", result: { status: "SUCCESS", response: "done" } }], "", mode);
    const { result, events } = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "cli_incompatible");
    assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET/);
    assert.deepEqual(f.counts(), { prepared: 1, cleaned: 1 });
  }
});

test("callback failure still cleans up the freshly prepared home", async () => {
  const f = fixture([]);
  await assert.rejects(f.adapter.run(f.opts, () => { throw new Error("listener failed"); }), /listener failed/);
  assert.deepEqual(f.counts(), { prepared: 1, cleaned: 1 });
});


test("a stalled native login prompt is auth, preventing automatic transient retries", async () => {
  const f = fixture(["Please sign in SYNTHETIC_SECRET"], "", "write", true);
  // Allow the synthetic CLI to start under the parallel suite before testing an idle login prompt.
  const { result, events } = await f.run({ idleTimeoutMs: 1000 });
  assert.equal(result.errorKind, "auth");
  assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET/);
  assert.deepEqual(f.counts(), { prepared: 1, cleaned: 1 });
});


test("native credential persistence failures override successful inference without leaking diagnostics", async () => {
  for (const source of ["stderr", "native-log"] as const) {
    const warning = "Failed to save refreshed token: SYNTHETIC_SECRET";
    const f = fixture([{ event: "result", result: { status: "SUCCESS", response: "completed", structured_output: { secret: "SYNTHETIC_SECRET" } } }], source === "stderr" ? warning : "", "write", false,
      source === "native-log" ? `W1021 10:00:00.000001 123 auth.go:123] ${warning}\n` : "");
    const { result, events } = await f.run();
    assert.equal(result.ok, false, source);
    assert.equal(result.errorKind, "auth", source);
    assert.equal(result.finalText, "");
    assert.equal(result.structured, undefined);
    assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET/);
    assert.deepEqual(f.counts(), { prepared: 1, cleaned: 1 });
  }
});
