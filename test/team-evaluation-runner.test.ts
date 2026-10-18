import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TeamEvaluation } from "../src/team-evaluation.js";

test("fake evaluation runs paired workflows, retrieves canonical project memory and registers only reports", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-evaluation-runner-"));
  const output = join(directory, "trial"), registration = join(directory, "registered");
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/evaluate-teams.ts", "--fake", "--runs", "1", "--models", "claude=sonnet,codex=gpt-a", "--efforts", "claude=high,codex=high", "--max-steps", "12", "--max-minutes", "1", "--out", output, "--register-home", registration], { cwd: root, timeout: 75_000, maxBuffer: 500_000 });
    assert.match(result.stdout, /Results:/);
    const comparison = JSON.parse(await readFile(join(output, "comparison.json"), "utf8")) as { mode: string; reports: TeamEvaluation[]; assessment: { realRuns: number } };
    assert.equal(comparison.mode, "fake");
    assert.equal(comparison.reports.length, 2);
    assert.ok(comparison.reports.every((report) => report.mode === "fake" && report.verified && report.metrics.invocations <= 12));
    assert.equal(comparison.reports[0]!.taskHash, comparison.reports[1]!.taskHash);
    assert.equal(comparison.reports[0]!.baseRef, comparison.reports[1]!.baseRef);
    assert.match(comparison.reports[0]!.reproducibility!.fixtureTree!, /^[0-9a-f]{40,64}$/);
    assert.equal(comparison.reports[0]!.reproducibility!.fixtureTree, comparison.reports[1]!.reproducibility!.fixtureTree);
    assert.match(comparison.reports[0]!.reproducibility!.applicationRevision!, /^[0-9a-f]{40,64}$/);
    assert.deepEqual(comparison.reports[0]!.reproducibility!.requestedSettings, { claude: { model: "sonnet", effort: "high" }, codex: { model: "gpt-a", effort: "high" } });
    assert.ok(comparison.reports[0]!.reproducibility!.stepSettings.length > 0);
    assert.match(comparison.reports[0]!.pairId!, /^[0-9a-f-]{36}-pair-1$/, "pair identities include the unique evaluation batch");
    assert.equal(comparison.reports[0]!.pairId, comparison.reports[1]!.pairId);
    assert.equal(comparison.assessment.realRuns, 0, "fake trials never count toward rollout");
    const auto = comparison.reports.find((report) => report.pattern === "auto-team")!;
    assert.ok(auto.metrics.selectedMemories >= 1, "the generated repository's canonical path matches its accepted memory");
    assert.match(auto.limitations.join(" "), /synthetic accepted/);
    assert.ok(auto.metrics.replay!.bytes > 0);
    const listed = await readdir(join(registration, "team-evaluations"));
    assert.equal(listed.length, 2, "registration copies measurement reports only");
    for (const report of comparison.reports) {
      assert.deepEqual(JSON.parse(await readFile(join(registration, "team-evaluations", `${report.id}.json`), "utf8")), report);
      assert.deepEqual(JSON.parse(await readFile(join(output, "home", "team-evaluations", `${report.id}.json`), "utf8")), report);
    }
    assert.deepEqual(await readdir(registration), ["team-evaluations"], "registration never copies source run history or changes rollout");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("interrupting an evaluation cancels its current preparation and never starts another trial", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-evaluation-interrupt-"));
  const output = join(directory, "trial");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/evaluate-teams.ts", "--fake", "--runs", "2", "--max-minutes", "1", "--out", output], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", interrupted = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
  child.stdout!.on("data", (chunk) => {
    stdout += chunk.toString();
    if (!interrupted && /fake: .* auto-team, at most/.test(stdout)) { interrupted = true; child.kill("SIGINT"); }
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 1, `${stdout}\n${stderr}`);
    assert.equal(interrupted, true);
    assert.equal((stdout.match(/fake: .* at most/g) ?? []).length, 1, "SIGINT stops the entire batch, including later paid trials");
    const comparison = JSON.parse(await readFile(join(output, "comparison.json"), "utf8")) as { interrupted: boolean; reports: TeamEvaluation[] };
    assert.equal(comparison.interrupted, true);
    assert.equal(comparison.reports.length, 1);
    assert.equal(comparison.reports[0]!.verified, false);
    assert.notEqual(comparison.reports[0]!.status, "running");
  } finally { clearTimeout(timeout); child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
});
