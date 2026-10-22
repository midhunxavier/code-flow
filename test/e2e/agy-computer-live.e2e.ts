import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real Antigravity Agent and teammate operate the native computer through shared task tools", { skip: process.platform !== "darwin" || process.env.CODEFLOW_TEST_AGY_COMPUTER !== "1", timeout: 900000 }, async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "cf-agy-computer-")), repo = join(dir, "repo");
  console.log("Evidence:", dir); process.env.CODEFLOW_HOME = join(dir, "state");
  await mkdir(join(repo, ".codeflow"), { recursive: true }); await writeFile(join(repo, "README.md"), "Synthetic native computer fixture\n"); await writeFile(join(repo, ".codeflow/config.json"), '{"prove":false}');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }); git("init", "-q", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=f@f", "commit", "-qm", "Fixture");
  const app = join(dir, "Codeflow Computer Fixture.app", "Contents"); await mkdir(join(app, "MacOS"), { recursive: true });
  await writeFile(join(app, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Codeflow Computer Fixture</string><key>CFBundleIdentifier</key><string>dev.codeflow.computer-fixture</string><key>CFBundleExecutable</key><string>CodeflowComputerFixture</string></dict></plist>');
  const binary = join(app, "MacOS", "CodeflowComputerFixture"); execFileSync("/usr/bin/swiftc", [join(root, "test/fixtures/computer-use.swift"), "-o", binary], { timeout: 60000 });
  const { RunManager } = await import("../../src/engine.js"), { findPattern } = await import("../../src/patterns/index.js"), { agentToolBridge } = await import("../../src/agent-tools.js");
  const manager = new RunManager(findPattern);
  const done = async (id: string) => { const deadline = Date.now() + 600000; while (Date.now() < deadline) { const r = manager.get(id)!; if (r.status !== "running") { assert.equal(r.status, "done", r.error); return r; } await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error("Computer turn timed out"); };
  try {
    const run = await manager.start({ pattern: findPattern("solo")!, repo, roles: { agent: ["agy"] }, options: {}, task: "Reply Ready, no tools yet.", trust: "full", agentSettings: { agy: { model: "gemini-3.8-flash-low" } }, loop: { maxMinutes: 10, maxSteps: 18 } }); await done(run.id);
    for (const phase of ["agent", "team"] as const) {
      const result = join(dir, `${phase}.txt`), phrase = `codeflow-native-${phase}`;
      if (phase === "team") await manager.configureTaskTeam(run.id, { enabled: true, preset: "build-review", coordinator: "codex", providers: ["agy", "codex"], settings: { agy: { model: "gemini-3.8-flash-low" }, codex: { model: "gpt-6-luna", effort: "medium" } }, maxMembers: 3, maxCalls: 14, maxMinutes: 8, approvePlan: false });
      const child = spawn(binary, [result, "540"], { stdio: ["ignore", "pipe", "pipe"] });
      try {
        const ready = await new Promise<any>((resolve, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error("Fixture did not become ready")), 10000); child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } }); child.once("error", reject); });
        assert.equal(ready.foreground, ready.app, "Fixture must own foreground before provider invocation");
        run.loop.check = `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('${result}','utf8'),'${phrase}')"`;
        const message = `${phase === "team" ? "Assign one WRITE task to an Antigravity worker and a separate read-only review to Codex. " : ""}Use only codeflow_agent computer_screenshot and computer_action on the foreground synthetic app named ${ready.app}. Take the screenshot with app=${ready.app}; if another app is foreground, stop. Click the Test phrase field, type exactly ${phrase}, then click Finish test once. Take a fresh screenshot before every action. The fixture then closes automatically; do not take more screenshots or act on other apps after Finish. Do not use shell, browser, native agents, or edit source files. Code Flow's configured check verifies the fixture result; reviewers should use that check evidence without repeating computer actions. This is an authorized temporary computer-control test.`;
        await manager.followUp(run.id, { kind: "reply", agent: "agy", worktree: "solo", message }); await done(run.id);
        await writeFile(join(dir, `${phase}-parent.json`), JSON.stringify(run, null, 2));
        assert.equal(run.followUps.at(-1)?.status, "done", run.followUps.at(-1)?.result);
        assert.equal(await readFile(result, "utf8"), phrase);
        const execution = phase === "team" ? manager.get(run.teamTurns!.at(-1)!.executionId)! : run;
        assert.equal(execution.status, "done", execution.error);
        assert.ok(execution.steps.some(step => step.agent === "agy" && step.permissions?.implementation === "macos-task-tools-v2"));
        await writeFile(join(dir, `${phase}-run.json`), JSON.stringify(execution, null, 2));
        console.log(phase, "Antigravity entered the exact phrase and clicked Finish through task-scoped computer tools");
      } finally { child.kill("SIGTERM"); }
    }
  } finally { await manager.shutdown(); await agentToolBridge.close(); }
});
