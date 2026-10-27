// A forked chat runs with the permissions chosen for it (never more than its source), and the doctor
// says up front when isolated Antigravity, the default for runs, can't start here. Fake CLIs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "cf-qa-agy-fork-home-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { adapters } = await import("../src/adapters/index.js");
const { doctor } = await import("../src/doctor.js");
type Run = import("../src/engine.js").Run;
type RunOptions = import("../src/adapters/types.js").RunOptions;
async function idle(run: Run) {
  const deadline = Date.now() + 15000;
  while (run.status === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(run.status, "done", run.error);
}
function repository() {
  const repo = mkdtempSync(join(tmpdir(), "cf-qa-agy-fork-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "README.md"), "Fixture\n"); git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return repo;
}

test("a forked chat runs with the chosen permissions, which may narrow but never raise the source's", async () => {
  const repo = repository();
  const manager = new RunManager(findPattern);
  const original = { codex: adapters.codex.run, claude: adapters.claude.run };
  const calls: RunOptions[] = [];
  adapters.codex.run = async (options) => { calls.push(options); return { ok: true, finalText: "Answered" }; };
  adapters.claude.run = async (options) => { calls.push(options); return { ok: true, finalText: "Forked" }; };
  try {
    const source = await manager.start({ pattern: findPattern("solo")!, repo, task: "Inspect the fixture", roles: { agent: ["codex"] }, options: {}, trust: "standard" });
    await idle(source);
    await manager.followUp(source.id, { kind: "reply", worktree: "solo", agent: "codex", message: "Go wider", trust: "full", tools: false });
    await idle(source);
    assert.equal(source.trust, "full", "a reply's explicit choice becomes the chat's level");

    const lowered = await manager.startProviderChat(source.id, { agent: "claude", message: "Continue carefully", trust: "standard", tools: false });
    await idle(lowered);
    assert.equal(lowered.trust, "standard");
    assert.equal(lowered.permissions?.trust, "standard");
    assert.equal(calls.at(-1)!.trust, "standard", "the provider gets the level chosen in the fork dialog");

    const inherited = await manager.startProviderChat(source.id, { agent: "claude", message: "Same access" });
    await idle(inherited);
    assert.equal(inherited.trust, "full", "without a choice the fork keeps the source's current level");

    await assert.rejects(manager.startProviderChat(lowered.id, { agent: "codex", message: "Escalate", trust: "full" }), /can't have more access/);
    await assert.rejects(manager.startProviderChat(lowered.id, { agent: "codex", message: "Approvals", tools: true }), /ask for approval only when/);
    await assert.rejects(manager.startProviderChat(lowered.id, { agent: "codex", message: "Bad", trust: "root" as never }), /Invalid permissions/);
    await assert.rejects(manager.startProviderChat(lowered.id, { agent: "codex", message: "Bad", tools: "yes" as never }), /Invalid approval preference/);
  } finally { adapters.codex.run = original.codex; adapters.claude.run = original.claude; await manager.shutdown(); }
});

test("doctor warns when isolated Antigravity can't run here, and says how to opt out", async () => {
  // The fake agy reports 1.3.6, which isn't a verified isolated runtime (and non-macOS never is).
  const agy = (await doctor({})).find((entry) => entry.id === "agy")!;
  assert.equal(agy.installed, true);
  assert.equal(agy.managedCompatible, false);
  assert.match(agy.warnings?.join(" ") ?? "", /isolated Antigravity by default, which isn't available here.*Use unrestricted Antigravity/);
});
