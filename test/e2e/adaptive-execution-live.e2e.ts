import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.CODEFLOW_TEST_ADAPTIVE_EXECUTION === "1";

test("real adaptive Antigravity implementation and independent review retain checks and fail-to-pass proof", { skip: !enabled, timeout: 600000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cf-adaptive-execution-")), repo = join(home, "repo");
  console.log("Evidence:", home);
  process.env.CODEFLOW_HOME = join(home, "state");
  mkdirSync(join(repo, ".codeflow"), { recursive: true });
  writeFileSync(join(repo, ".codeflow/config.json"), '{"prove":true}');
  writeFileSync(join(repo, "greet.mjs"), 'export function greet(name) { return `Hello, ${name}!`; }\n');
  writeFileSync(join(repo, "greet.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./greet.mjs";\ntest("greets a name", () => assert.equal(greet("Ada"), "Hello, Ada!"));\n');
  writeFileSync(join(repo, "keep.txt"), "Preserve this file byte for byte.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=f@f", "commit", "-qm", "Fixture");
  const { RunManager } = await import("../../src/engine.js");
  const { findPattern } = await import("../../src/patterns/index.js");
  const manager = new RunManager(findPattern);
  let run: import("../../src/engine.js").Run | undefined;
  try {
    run = await manager.start({
      pattern: findPattern("auto-team")!, repo, trust: "standard",
      task: "Update greet(name) in greet.mjs to trim leading/trailing whitespace, collapse internal whitespace runs to one space, and greet empty or whitespace-only names as 'Hello, friend!'. Preserve case and existing normal-name behavior. Add regression tests in greet.test.mjs for these behaviors. Keep keep.txt and all other files unchanged. This is a small scoped code change: exactly one implementation task owning greet.mjs and greet.test.mjs and a separate independent reviewer suffice. No packages, publishing, or external services. Code Flow runs node --test and fail-to-pass proof after integration. Workers should submit the files for those gates.",
      roles: { coordinator: ["codex"], pool: ["agy"] },
      roleSettings: { coordinator: { codex: { model: "gpt-6-luna", effort: "medium" } }, pool: { agy: { model: "gemini-3.8-flash-high" } } },
      options: { eventDriven: true, maxMembers: 3, maxTasks: 1, maxRepairs: 1, providerFailover: false },
      approvals: { plan: false }, loop: { check: "node --test", maxSteps: 10, maxMinutes: 8 },
    });
    const deadline = Date.now() + 540000;
    while (run.status === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(run.status, "done", run.error);
    assert.equal(run.team?.status, "completed", run.team?.gaps.join("; "));
    assert.equal(run.lastCheck?.ok, true);
    assert.equal(run.team?.verification?.proof, "proven");
    assert.equal(run.usage.checks, 2, "one passing completion check plus a failing baseline proof; the unchanged final commit reuses its completion check");
    assert.equal(run.steps.filter(step => step.title === "Auto team final check").length, 0);
    const worker = run.steps.find(step => step.title.startsWith("Auto task:"))!;
    const reviewer = run.steps.find(step => step.title.startsWith("Auto team independent review"))!;
    assert.equal(worker.agent, "agy"); assert.equal(reviewer.agent, "agy");
    assert.equal(worker.settings?.model, "gemini-3.8-flash-high"); assert.equal(reviewer.settings?.model, "gemini-3.8-flash-high");
    assert.notEqual(worker.memberId, reviewer.memberId);
    assert.equal(reviewer.mode, "read");
    const integration = run.worktrees.find(tree => tree.name === "integration")!;
    assert.equal(readFileSync(join(integration.path, "keep.txt"), "utf8"), "Preserve this file byte for byte.\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", 'import assert from "node:assert/strict";import {greet} from "./greet.mjs";assert.equal(greet("  Ada\\tLovelace  "),"Hello, Ada Lovelace!");assert.equal(greet(" \\t\\n "),"Hello, friend!");assert.equal(greet("Ada"),"Hello, Ada!");'], { cwd: integration.path });
    console.log("Execution timing:", JSON.stringify(run.steps.map(step => ({ title: step.title, agent: step.agent, ms: step.endedAt! - step.startedAt, promptBytes: step.contextInput?.promptBytes }))));
  } finally {
    if (run) writeFileSync(join(home, "run.json"), JSON.stringify(run, null, 2));
    await manager.shutdown();
  }
});
