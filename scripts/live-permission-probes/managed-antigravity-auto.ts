import "./environment.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunManager } from "../../src/engine.js";
import { findPattern } from "../../src/patterns/index.js";
import { flushWrites } from "../../src/store.js";

// Opt-in mixed-provider Auto acceptance. Uses Codex + Antigravity subscription usage.
const native = process.argv.includes("--native");
const repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-agy-auto-probe-")));
const exec = promisify(execFile);
await exec("git", ["init", "-q"], { cwd: repo });
await mkdir(join(repo, ".codeflow"));
await writeFile(join(repo, ".codeflow/config.json"), '{"prove":false}');
await writeFile(join(repo, "README.md"), "Fixture project.\n");
await writeFile(join(repo, "verify.test.mjs"), 'import {test} from "node:test";import assert from "node:assert/strict";import{readFileSync}from"node:fs";test("marker",()=>assert.match(readFileSync("README.md","utf8"),/AUTO_AGY_VERIFIED/));\n');
await exec("git", ["add", "."], { cwd: repo });
await exec("git", ["-c", "user.name=Code Flow Probe", "-c", "user.email=probe@example.invalid", "commit", "-qm", "Synthetic fixture"], { cwd: repo });
const manager = new RunManager(findPattern);
const run = await manager.start({
  pattern: findPattern("auto-team")!, repo,
  antigravityExecution: native ? "native" : "isolated",
  task: native ? "Append one line AUTO_AGY_VERIFIED to README.md. Preserve all other files. Assign the edit to an Antigravity worker and independent review to a separate Codex member. Ask Antigravity to run node --test verify.test.mjs using its terminal. Only operate on this synthetic fixture; do not inspect or change authentication, provider settings or other directories. Do not use browser, MCP or native agents for this task. Also use Code Flow’s configured check. Do not ask questions." : "Append one line AUTO_AGY_VERIFIED to README.md. Preserve all other files. Assign the file edit to an Antigravity worker and independent review to a separate Codex member. One file-editing task is enough. The Antigravity worker has file tools only; Code Flow must run node --test verify.test.mjs separately. Do not ask the worker to use terminal/browser/MCP/native agents. Use the configured check and independent review. Do not ask the user questions.",
  roles: { coordinator: ["codex"], pool: ["agy", "codex"] },
  agentSettings: { codex: { model: "gpt-6.1-sol", effort: "low" } },
  roleSettings: { pool: { agy: { model: "gemini-3.8-flash-low" } } },
  options: {}, trust: "standard", approvals: { plan: false },
  loop: { check: "node --test verify.test.mjs", maxSteps: 12 },
});
let last = "";
const unsubscribe = manager.subscribe(run.id, () => {
  const state = `${run.status}:${run.steps.filter(s => s.status === "done").length}:${run.steps.filter(s => s.status === "failed").length}`;
  if (state !== last) { last = state; console.log(JSON.stringify({ progress: state })); }
});
const timer = setTimeout(() => manager.cancel(run.id), 240000);
try {
  await new Promise<void>(resolve => {
    const poll = setInterval(() => { if (run.status !== "running" || run.awaiting) { if (run.awaiting) manager.cancel(run.id); clearInterval(poll); resolve(); } }, 500);
  });
  await flushWrites();
  const workers = run.steps.filter(s => s.agent === "agy");
  const output = run.artifacts.find(a => a.path)?.path;
  console.log(JSON.stringify({ repo, status: run.status, verdict: run.verdict, agyTurns: workers.length,
    permissions: workers.map(s => ({ mode: s.mode, isolation: s.permissions?.isolation, implementation: s.permissions?.implementation, nativeSession: !!s.sessionId, catalogRevision: s.modelAssignment?.catalogRevision })),
    marker: output ? (await readFile(join(output, "README.md"), "utf8").catch(() => "")).includes("AUTO_AGY_VERIFIED") : false,
  }, null, 2));
  if (run.status !== "done" || run.verdict !== "passed" || !workers.length || workers.some(s => s.permissions?.implementation !== (native ? "agy-native-v1" : "macos-file-only-v1") || s.sessionId)) process.exitCode = 1;
} finally { clearTimeout(timer); unsubscribe(); }
