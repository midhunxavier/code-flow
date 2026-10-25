import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.CODEFLOW_TEST_GITHUB_REPAIR === "1";
test("live Agent issue repair and cross-provider Team PR repair preserve the upgrade and checks", { skip: !enabled, timeout: 600000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cf-github-repair-live-")), repo = join(home, "repo"), origin = join(home, "origin.git"), bin = join(home, "bin");
  console.log("Evidence:", home);
  for (const path of [repo, origin, bin]) mkdirSync(path);
  process.env.CODEFLOW_HOME = join(home, "state");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("../fake-gh.mjs", import.meta.url)))} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "f@example.com");
  writeFileSync(join(repo, "dependency.mjs"), 'export function format(name) { return `Hello, ${name}!`; }\n');
  writeFileSync(join(repo, "app.mjs"), 'import {format} from "./dependency.mjs";\nexport function greet(name) { return format(name); }\n');
  writeFileSync(join(repo, "app.test.mjs"), 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {greet} from "./app.mjs";\ntest("greets a name", () => assert.equal(greet("Ada"), "Hello, Ada!"));\n');
  writeFileSync(join(repo, "keep.txt"), "Unrelated file stays unchanged.\n");
  git("add", "."); git("commit", "-qm", "fixture"); git("remote", "add", "origin", origin); git("push", "-q", "origin", "main");
  git("checkout", "-q", "-b", "dependabot/format-v2");
  const upgraded = 'export function format({name}) { return `Hello, ${name.trim()}!`; }\n';
  writeFileSync(join(repo, "dependency.mjs"), upgraded); git("commit", "-qam", "Upgrade format to v2 object argument");
  git("push", "-q", "origin", "HEAD:refs/pull/7/head", "HEAD:refs/heads/dependabot/format-v2"); git("checkout", "-q", "main");
  process.env.FAKE_GH_STATE = join(home, "github.json");
  writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ issues: [{ number: 11, title: "Greeting preserves unwanted whitespace", body: "Calling greet('  Ada  ') should return 'Hello, Ada!'. Fix app.mjs and add regression tests in app.test.mjs. Leave dependency.mjs and keep.txt unchanged.", url: "https://github.com/o/r/issues/11", labels: [{ name: "bug" }], author: { login: "owner" }, authorAssociation: "OWNER" }], prs: { 7: { number: 7, title: "Bump format to v2", body: "The dependency now accepts {name} instead of a string. Adapt app.mjs and add a focused regression test in app.test.mjs. Do not change dependency.mjs or keep.txt.", url: "https://github.com/o/r/pull/7", state: "OPEN", headRefName: "dependabot/format-v2", baseRefName: "main", author: { login: "app/dependabot" }, authorAssociation: "NONE", isDraft: false, isCrossRepository: false, failOn: "all", comments: [] } }, ciLogs: { 77: "node --test: TypeError: Cannot read properties of undefined (reading 'trim') at format (dependency.mjs:1), called by greet (app.mjs:2)." } }));
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { listSweep } = await import("../../src/sweeps.js");
  const manager = new RunManager(findPattern);
  const runs: import("../../src/engine.js").Run[] = [];
  try {
    for (const kind of ["issues", "dependabot"] as const) {
      const item = (await listSweep(repo, kind, [])).items.find(item => item.selected)!;
      const run = await manager.start({ pattern: findPattern(kind === "issues" ? "solo" : "fix-review")!, repo, task: item.task! + " This is a tiny local fixture. No packages, publishing or external services are needed.", source: item.source, trust: "standard", roles: kind === "issues" ? { agent: ["codex"] } : { builder: ["agy"], reviewer: ["claude"] }, roleSettings: kind === "issues" ? { agent: { codex: { model: "gpt-6-luna", effort: "medium" } } } : { builder: { agy: { model: "gemini-3.8-flash-high" } } }, options: { maxRounds: 2, checkFixes: 1 }, trigger: { id: "live-fixture", name: "Local repair QA", via: "sweep" }, loop: { check: "node --test", maxSteps: 8, maxMinutes: 5 } });
      runs.push(run);
      while (run.status === "running") await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(run.status, "done", run.error);
      assert.equal(run.lastCheck?.ok, true);
      assert.equal(run.triage?.state, "pending");
      const tree = run.worktrees.find(tree => tree.name === (kind === "issues" ? "solo" : "build"))!;
      assert.equal(readFileSync(join(tree.path, "keep.txt"), "utf8"), "Unrelated file stays unchanged.\n");
      execFileSync(process.execPath, ["--input-type=module", "-e", 'import assert from "node:assert/strict";import {greet} from "./app.mjs";assert.equal(greet("  Ada  "),"Hello, Ada!");assert.equal(greet("Ada"),"Hello, Ada!");'], { cwd: tree.path });
      if (kind === "dependabot") { assert.equal(run.facts?.approved, true); assert.equal(readFileSync(join(tree.path, "dependency.mjs"), "utf8"), upgraded); assert.ok(run.steps.some(step => step.agent === "claude" && step.role === "reviewer")); }
      console.log(kind, JSON.stringify(run.steps.map(step => ({ title: step.title, agent: step.agent, ms: step.endedAt! - step.startedAt }))));
    }
  } finally {
    for (const run of runs) writeFileSync(join(home, `${run.id}.json`), JSON.stringify(run, null, 2));
    await manager.shutdown();
  }
});
