// The Codex profile setting: where it is saved, what it accepts, and that a Codex turn runs
// through `codex --profile <name> exec`. Fake CLIs only (test/fake-bin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const home = mkdtempSync(join(tmpdir(), "codeflow-codex-profile-home-"));
const codexHome = mkdtempSync(join(tmpdir(), "codeflow-codex-profile-codex-"));
process.env.CODEFLOW_HOME = home;
process.env.CODEX_HOME = codexHome;
delete process.env.CODEFLOW_CODEX_PROFILE;

const { codexProfile, codexProfileProblem, codexProfileStatus, listCodexProfiles, saveCodexProfile } = await import("../src/codex-profile.js");
const { getAdapter } = await import("../src/adapters/index.js");
type AgentEvent = import("../src/adapters/types.js").AgentEvent;

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `codeflow-codex-profile-${name}-`));
const recorded = (dir: string) => readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
async function turn(extra: Record<string, unknown> = {}) {
  const events: AgentEvent[] = [];
  return getAdapter("codex").run({ prompt: "Look around", cwd: tmp("cwd"), mode: "read", timeoutMs: 10_000, ...extra }, (e) => events.push(e));
}

test("profiles are the <name>.config.toml files in Codex's home, and only an existing one can be saved", () => {
  assert.deepEqual(listCodexProfiles(), []);
  assert.deepEqual(codexProfile(), {});
  writeFileSync(join(codexHome, "config.toml"), 'model = "base"\n');
  writeFileSync(join(codexHome, "ollama.config.toml"), 'model_provider = "ollama"\n');
  writeFileSync(join(codexHome, "work.config.toml"), 'model = "work"\n');
  writeFileSync(join(codexHome, "not a name.config.toml"), "");
  assert.deepEqual(listCodexProfiles(), ["ollama", "work"], "the base config and unusable names are not profiles");
  assert.match(codexProfileProblem("../work")!, /plain name/);
  assert.match(codexProfileProblem("missing")!, /no profile “missing”.*missing\.config\.toml/);
  assert.throws(() => saveCodexProfile("missing"), /no profile/);
  assert.throws(() => saveCodexProfile("-p"), /plain name/);
  assert.deepEqual(codexProfile(), {}, "a refused profile is not saved");
  saveCodexProfile(" ollama ");
  assert.deepEqual(codexProfile(), { name: "ollama", source: "settings" });
  assert.deepEqual(codexProfileStatus(), { profile: "ollama", source: "settings", problem: null, available: ["ollama", "work"], codexHome });
});

test("the environment variable wins over the saved setting, and clearing goes back to Codex's default", () => {
  process.env.CODEFLOW_CODEX_PROFILE = "work";
  try { assert.deepEqual(codexProfile(), { name: "work", source: "environment" }); }
  finally { delete process.env.CODEFLOW_CODEX_PROFILE; }
  saveCodexProfile("");
  assert.deepEqual(codexProfile(), {});
  assert.equal(codexProfileStatus().profile, "");
});

test("a Codex turn runs through exec with the profile, even when app-server is asked for", async () => {
  const dir = tmp("record");
  saveCodexProfile("ollama");
  process.env.FAKE_RECORD_DIR = dir; process.env.CODEFLOW_CODEX_TRANSPORT = "app-server";
  try {
    const result = await turn();
    assert.equal(result.ok, true, result.error);
    const resumed = await turn({ resumeSessionId: result.sessionId ?? "thread-1" });
    assert.equal(resumed.ok, true, resumed.error);
  } finally { delete process.env.FAKE_RECORD_DIR; delete process.env.CODEFLOW_CODEX_TRANSPORT; }
  const calls = recorded(dir).filter(call => call.args?.includes("exec"));
  assert.equal(calls.length, 2, JSON.stringify(recorded(dir)));
  for (const call of calls) assert.deepEqual(call.args.slice(0, 3), ["--profile", "ollama", "exec"], "the profile is a top-level option, before the subcommand");
  assert.ok(calls.some(call => call.args[3] === "resume"), "a resumed turn keeps the profile");
  assert.equal(recorded(dir).some(call => call.args?.[0] === "app-server"), false, "app-server has no profile option, so it is not used");
});

test("a profile whose file has gone fails the turn instead of silently using the default account", async () => {
  process.env.CODEFLOW_CODEX_PROFILE = "gone";
  const dir = tmp("record-missing"); process.env.FAKE_RECORD_DIR = dir;
  try {
    const result = await turn();
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "cli_incompatible");
    assert.match(result.error!, /no profile “gone”.*clear the Codex profile in Settings/);
    assert.deepEqual(recorded(dir), [], "Codex is not started");
    // A run that asks you to approve each tool needs app-server, which a profile rules out.
    const { createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");
    const permissions = resolveRunPermissions({ policy: createRunPermissions("standard", true, true), provider: "codex", mode: "write", currentTrust: "standard", currentTools: true });
    process.env.CODEFLOW_CODEX_PROFILE = "work";
    const approvals = await turn({ mode: "write", trust: "standard", permissions, interactiveApprovals: true, onApproval: async () => "approve" });
    assert.equal(approvals.ok, false);
    assert.match(approvals.error!, /interactive approvals.*profile “work”/);
  } finally { delete process.env.CODEFLOW_CODEX_PROFILE; delete process.env.FAKE_RECORD_DIR; }
});

test("without a profile nothing about the Codex command changes", async () => {
  saveCodexProfile("");
  const dir = tmp("record-plain"); process.env.FAKE_RECORD_DIR = dir; process.env.CODEFLOW_CODEX_TRANSPORT = "exec";
  try { const result = await turn(); assert.equal(result.ok, true, result.error); }
  finally { delete process.env.FAKE_RECORD_DIR; delete process.env.CODEFLOW_CODEX_TRANSPORT; }
  const call = recorded(dir).find(item => item.args?.includes("exec"));
  assert.equal(call.args[0], "exec");
  assert.equal(call.args.includes("--profile"), false);
});
