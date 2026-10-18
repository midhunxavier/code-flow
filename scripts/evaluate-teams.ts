/** Bounded, local Auto/Supervisor comparisons. No paid calls without --real. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write("Usage: npm run evaluate:teams -- [--fake | --real --confirm] [--runs 1] [--providers claude,codex] [--max-steps 12] [--max-minutes 5] [--out DIR] [--register-home DIR]\nEach run is one matched Auto/Supervisor pair in an isolated generated repository. --real uses the official signed-in CLIs and consumes subscription quota (up to runs × 2 × max-steps invocations), so it also needs --confirm. Defaults to fake. Results, repositories and CLI versions remain local in DIR. --register-home explicitly copies only measurement reports into another code-flow installation; it never changes rollout.\n");
  process.exit(0);
}
const option = (name: string, fallback: string) => { const index = argv.indexOf(name); if (index < 0) return fallback; if (!argv[index + 1] || argv[index + 1]!.startsWith("--")) throw new Error(`Missing ${name} value`); return argv[index + 1]!; };
const numberOption = (name: string, fallback: number, min: number, max: number) => { const value = Number(option(name, String(fallback))); if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`); return value; };
const allowed = new Set(["--fake", "--real", "--confirm", "--runs", "--providers", "--max-steps", "--max-minutes", "--out", "--register-home"]);
for (const argument of argv.filter((value) => value.startsWith("--"))) if (!allowed.has(argument)) throw new Error(`Unknown option ${argument}`);
if (argv.includes("--real") && argv.includes("--fake")) throw new Error("Choose --real or --fake");
const mode = argv.includes("--real") ? "real" : "fake";
const runs = numberOption("--runs", 1, 1, 50);
const maxSteps = numberOption("--max-steps", 12, 4, 40);
const maxMinutes = numberOption("--max-minutes", 5, .1, 30);
if (!Number.isInteger(runs) || !Number.isInteger(maxSteps)) throw new Error("--runs and --max-steps must be integers");
// Spending is bounded but real: say how much before anyone can start it by accident.
if (mode === "real" && !argv.includes("--confirm")) throw new Error(`--real spends signed-in CLI quota: up to ${runs * 2 * maxSteps} invocations across ${runs} matched pair(s). Add --confirm to proceed.`);
const providers = [...new Set(option("--providers", "claude,codex").split(","))];
if (!providers.length || providers.some((id) => !["claude", "codex", "agy"].includes(id))) throw new Error("Providers must be claude,codex,agy");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Only make a temporary directory when none was given; an eager default leaves an empty one behind on every run.
const output = resolve(argv.includes("--out") ? option("--out", "") : await mkdtemp(join(tmpdir(), `codeflow-team-${mode}-evaluation-`)));
const registerHome = argv.includes("--register-home") ? resolve(option("--register-home", "")) : undefined;
await mkdir(output, { recursive: true });
// Must precede dynamic imports: run storage is deliberately separate from the user's app.
process.env.CODEFLOW_HOME = join(output, "home");
if (mode === "fake") process.env.PATH = `${join(root, "test", "fake-bin")}:${process.env.PATH}`;
else if ((process.env.PATH ?? "").split(":").some((part) => /[/\\]fake-bin\/?$/.test(part))) throw new Error("Refusing --real with fake-bin on PATH");
process.env.CODEFLOW_STEP_TIMEOUT_MIN = String(maxMinutes);
process.env.CODEFLOW_STEP_IDLE_MIN = String(Math.min(maxMinutes, 3));
process.env.CODEFLOW_RETRY_DELAYS_MS = "1000";
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { buildTeamEvaluation, TeamEvaluationStore, assessTeamRollout } = await import("../src/team-evaluation.js");
const { flushWrites, loadJournal, RUNS_DIR } = await import("../src/store.js");
const { memoryStore } = await import("../src/memory.js");
const { Projects } = await import("../src/projects.js");
type Run = import("../src/engine.js").Run;
type AgentId = import("../src/adapters/types.js").AgentId;
type TeamEvaluation = import("../src/team-evaluation.js").TeamEvaluation;
const ids = providers as AgentId[];
const versions: Record<string, string> = {};
for (const id of ids) versions[id] = execFileSync(id, ["--version"], { encoding: "utf8", timeout: 15_000, maxBuffer: 64_000 }).trim().slice(0, 1000) || "version not reported";
if (mode === "real" && Object.values(versions).some((version) => /fake/i.test(version))) throw new Error("A fake CLI cannot produce real evaluation evidence");
// Everything a reader needs to interpret the numbers: the settings that differ from the app's defaults are recorded, not implied.
const settings = {
  approvals: { plan: false },
  autoTeam: { maxWaves: 4, maxRepairs: 1, eventDriven: true },
  supervisor: { maxSubtasks: 2 },
  models: "provider defaults; no agentSettings or roleSettings are passed",
  loop: { check: "node --test", maxSteps, maxMinutes, maxInvocations: maxSteps },
};
await writeFile(join(output, "configuration.json"), JSON.stringify({ version: 1, mode, runs, providers, maxSteps, maxMinutes, registerHome, cliVersions: versions, settings, seededMemory: "Synthetic accepted repository rule: use dependency-free node:test; no usefulness claim", at: new Date().toISOString() }, null, 2));
const evaluations = new TeamEvaluationStore(join(output, "reports"));
const appEvaluations = new TeamEvaluationStore(join(process.env.CODEFLOW_HOME, "team-evaluations"));
const registration = registerHome ? new TeamEvaluationStore(join(registerHome, "team-evaluations")) : undefined;
const reports: TeamEvaluation[] = [];
const batchId = randomUUID();
const projects = new Projects(); await projects.load();
const manager = new RunManager(findPattern, projects);
let activeRun: Run | undefined;
let interrupted = false;
const stop = () => { interrupted = true; if (activeRun?.status === "running") manager.cancel(activeRun.id); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

async function ended(run: Run) {
  if (run.status !== "running") return;
  await new Promise<void>((done) => {
    const deadline = setTimeout(() => manager.cancel(run.id), Math.ceil(maxMinutes * 60_000));
    const inspect = () => { if (run.status !== "running") { clearTimeout(deadline); unsubscribe(); done(); } };
    const unsubscribe = manager.subscribe(run.id, inspect); inspect();
  });
}
try {
  trials: for (let index = 0; index < runs; index++) {
    if (interrupted) break;
    const repo = join(output, `case-${index + 1}`); await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "team-evaluation-fixture", type: "module", private: true, scripts: { test: "node --test" } }, null, 2));
    let task: string;
    if (mode === "real") {
      await writeFile(join(repo, "numbers.js"), "export function sumNumbers(values) { return 0; }\n");
      await writeFile(join(repo, "README.md"), "A dependency-free JavaScript numeric utility. Use node --test. Do not access external services.\n");
      task = "Implement sumNumbers(values) in numbers.js. It accepts an array and sums finite numbers, ignores nonnumeric values, NaN and infinities, returns 0 for an empty array, throws TypeError for non-arrays, and never mutates the input. Add tests for all these behaviors using node:test. Keep this a small dependency-free change, without network access or publishing. Verify with node --test.";
    } else {
      await writeFile(join(repo, "README.md"), "Empty input is valid.\n");
      await writeFile(join(repo, "implemented.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { readdirSync } from "node:fs"; test("implementation exists", () => assert.ok(readdirSync(".").some((name) => /^(claude|codex|agy)-.*\\.txt$/.test(name))));\n');
      task = "AUTO-QUESTION Implement the sample with evidence and preserve the accepted empty-input contract.";
    }
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=code-flow evaluation", "-c", "user.email=evaluation@localhost", "commit", "-qm", "Evaluation baseline"], { cwd: repo });
    const project = await projects.create({ name: `Evaluation case ${index + 1}`, repos: [repo] });
    const canonicalRepo = project.repos[0]!;
    await memoryStore.propose({ scope: "project", repo: canonicalRepo, projectId: project.id, title: "Synthetic evaluation fixture: test convention", body: "This generated evaluation repository is dependency-free. Use node:test and node --test; do not install packages or contact external services.", tags: ["test", "dependency-free", "evaluation-fixture"], paths: [], applicability: { kind: "repository" }, sourceRefs: ["Evaluation fixture setup; synthetic accepted seed, not a learned result"] }, { kind: "user", repo: canonicalRepo, projectId: project.id });
    const pairId = `${batchId}-pair-${index + 1}`;
    // Alternate order to reduce a fixed warm-cache/order bias. Each run starts from main.
    const patterns = index % 2 ? ["supervisor", "auto-team"] : ["auto-team", "supervisor"];
    for (const pattern of patterns) {
      if (interrupted) break trials;
      process.stdout.write(`${mode}: ${pairId} ${pattern}, at most ${maxSteps} steps and ${maxMinutes} minutes\n`);
      activeRun = await manager.start({ pattern: findPattern(pattern)!, repo, project: project.id, baseRef: "main", task,
        roles: pattern === "auto-team" ? { coordinator: [ids[0]!], pool: ids } : { supervisor: [ids[0]!], workers: ids, reviewer: [ids[1] ?? ids[0]!] },
        options: pattern === "auto-team" ? { maxWaves: 4, maxRepairs: 1, eventDriven: true } : { maxSubtasks: 2 },
        approvals: { plan: false }, loop: { check: "node --test", maxSteps, maxMinutes, maxInvocations: maxSteps },
        group: { id: pairId, label: pattern },
      });
      // A signal can arrive while start() is preparing the run, before activeRun is assigned.
      if (interrupted) manager.cancel(activeRun.id);
      await ended(activeRun); await flushWrites();
      const file = join(RUNS_DIR, `${activeRun.id}.journal.jsonl`);
      const started = performance.now(); const journal = await loadJournal(activeRun.id, { strict: pattern === "auto-team" });
      const bytes = await stat(file).then((info) => info.size, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0; throw error; });
      const replay = { bytes, records: journal.size, durationMs: performance.now() - started, kind: "journal-load" as const };
      const report = buildTeamEvaluation(activeRun, { mode, cliVersions: versions, caseId: mode === "real" ? "sum-numbers-v2-seeded-memory" : "fake-peer-question-v2-seeded-memory", pairId, replay, journal, memoryEntries: await memoryStore.list({ repo: activeRun.repo, scope: "project", projectId: activeRun.project }, { kind: "user", repo: activeRun.repo, projectId: activeRun.project }) });
      report.limitations.push("This trial seeds one synthetic accepted repository memory about dependency-free node:test. Selection measures retrieval plumbing, not learned-memory usefulness.");
      await evaluations.record(report); await appEvaluations.record(report); if (registration) await registration.record(report); reports.push(report);
      process.stdout.write(`${activeRun.id}: ${activeRun.status}, verified=${report.verified}, calls=${report.metrics.invocations}, coordinator=${report.metrics.coordinatorInvocations}\n`);
    }
  }
} finally { if (activeRun?.status === "running") manager.cancel(activeRun.id); await manager.shutdown(); await flushWrites(); }
const assessment = assessTeamRollout(reports);
await writeFile(join(output, "comparison.json"), JSON.stringify({ version: 1, mode, interrupted, reports, assessment }, null, 2));
const lines = ["# Local team comparison", "", `Mode: **${mode}**. ${mode === "fake" ? "These fixtures do not measure real-agent quality or cost." : "These bounded generated tasks are not a representative product benchmark."}`, "", "One synthetic accepted repository memory about dependency-free node:test is seeded before each pair. Selection measures retrieval plumbing, not learned-memory usefulness.", "", "| Case | Pattern | Status | Verified | Calls | Coordinator | Worker turns | Selected memory | Elapsed ms | Journal bytes | Journal load ms |", "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|", ...reports.map((report) => `| ${report.pairId} | ${report.pattern} | ${report.status} | ${report.verified} | ${report.metrics.invocations} | ${report.metrics.coordinatorInvocations} | ${report.metrics.workerTurns} | ${report.metrics.selectedMemories} | ${report.metrics.elapsedMs ?? "unknown"} | ${report.metrics.replay?.bytes ?? "unknown"} | ${report.metrics.replay?.durationMs.toFixed(2) ?? "unknown"} |`), "", "## Rollout assessment", "", ...assessment.blockers.map((blocker) => `- ${blocker}`), "", "No rollout stage was changed. Reports contain task hashes and measurements; source run transcripts remain in this evaluation directory.", `To inspect these runs in the app, start it with CODEFLOW_HOME set to ${process.env.CODEFLOW_HOME}.`, ...(registerHome ? [`Measurement reports were also registered in ${registerHome}; run transcripts were not copied.`] : []), "", "## CLI versions", "", ...Object.entries(versions).map(([provider, version]) => `- ${provider}: ${version.replaceAll("\n", " ")}`), ""];
await writeFile(join(output, "comparison.md"), lines.join("\n"));
process.stdout.write(`Results: ${join(output, "comparison.md")}\n`);
if (interrupted || reports.some((report) => !report.verified)) process.exitCode = 1;
