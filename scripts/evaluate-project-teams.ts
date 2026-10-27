/** Bounded end-to-end standing-team pilot; synthetic by default, real CLIs only on explicit opt-in. */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("Usage: npm run evaluate:project-teams -- [--fake | --real --confirm] [--cycles 10] [--out DIR]\nUses two isolated fixture repositories and a private CODEFLOW_HOME. Real mode consumes at most cycles × 24 CLI invocations and cycles × 60 allocated minutes, and never merges or pushes. Fake evidence tests mechanics, not product quality. Keep owner usefulness/acceptance feedback separate."); process.exit(0); }
const value = (name: string, fallback: string) => { const index = args.indexOf(name); if (index < 0) return fallback; if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Missing ${name} value`); return args[index + 1]!; };
for (const arg of args.filter((arg) => arg.startsWith("--"))) if (!["--fake", "--real", "--confirm", "--cycles", "--out"].includes(arg)) throw new Error(`Unknown option ${arg}`);
const real = args.includes("--real"), count = Number(value("--cycles", "10"));
if (real && args.includes("--fake")) throw new Error("Choose fake or real providers");
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Choose 1–10 cycles");
if (real && !args.includes("--confirm")) throw new Error("Real evaluation consumes CLI quota. Add --confirm after reviewing the limits in --help.");
const root = fileURLToPath(new URL("..", import.meta.url));
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const provenance = (() => {
  try { return { applicationRevision: git(root, "rev-parse", "HEAD"), applicationDirty: !!git(root, "status", "--porcelain") }; }
  catch { return { applicationRevision: "unknown", applicationDirty: null }; }
})();
if (provenance.applicationRevision === "unknown") {
  if (real) throw new Error("Real evaluation requires a Git checkout with a committed revision so its evidence is attributable.");
  console.warn("Application revision unavailable; the synthetic report will record unknown provenance.");
}
const output = resolve(args.includes("--out") ? value("--out", "") : await mkdtemp(join(tmpdir(), "codeflow-project-team-evaluation-")));
await mkdir(output, { recursive: true });
process.env.CODEFLOW_HOME = join(output, "home"); process.env.CODEFLOW_PROJECT_TEAMS_ENABLED = "true";
if (!real) process.env.PATH = `${join(root, "test/fake-bin")}:${process.env.PATH}`;
else if ((process.env.PATH ?? "").split(":").some((p) => p.endsWith("/fake-bin"))) throw new Error("Fake providers cannot produce real pilot evidence");
const { RunManager } = await import("../src/engine.js"), { findPattern } = await import("../src/patterns/index.js"), { Projects } = await import("../src/projects.js"), { Automations } = await import("../src/automation.js"), { ProjectTeams } = await import("../src/project-teams.js"), { flushWrites } = await import("../src/store.js");
const projects = new Projects(); await projects.load();
const manager = new RunManager(findPattern, projects), automations = new Automations(manager, async () => { throw new Error("Managed cycle bypass"); }); await automations.load();
const service = new ProjectTeams({ manager, projects, automations, build: async (body) => ({ ...body, pattern: findPattern(body.pattern)! }) as import("../src/engine.js").StartRunInput }); await service.load(); service.start();
const teamIds: string[] = [];
for (let n = 0; n < 2; n++) {
  const repo = join(output, `fixture-${n + 1}`); await mkdir(repo); git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "Empty input is valid.\nA small text-normalization library for developers.\n");
  await writeFile(join(repo, "index.mjs"), 'export const normalize = (text) => text.trim().toLowerCase();\n');
  await writeFile(join(repo, "sample.test.mjs"), 'import {test} from "node:test";import assert from "node:assert/strict";import {normalize} from "./index.mjs";test("empty and case",()=>{assert.equal(normalize(""),"");assert.equal(normalize(" Hi "),"hi")});\n');
  await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false })); git(repo, "add", "."); git(repo, "-c", "user.name=Pilot", "-c", "user.email=pilot@local", "commit", "-qm", "baseline");
  const project = await projects.create({ name: `Pilot ${n + 1}`, repos: [repo] });
  const draft = await service.create({ operationId: `setup-${n}`, projectId: project.id, repo, name: `Pilot team ${n + 1}`, mission: { mission: "Improve the documented input contract with small tests or documentation changes; keep runtime behavior stable.", users: "Developers integrating the library", baseBranch: "main", mode: "build-within-scope", check: "node --test", coordinator: "claude", pool: ["claude", "codex"], schedule: { every: 10080 }, budget: { weeklyCalls: 120, weeklyMinutes: 300 } } });
  teamIds.push((await service.update(draft.id, { operationId: `activate-${n}`, revision: draft.revision, status: "active" })).id);
}
const cliVersions = Object.fromEntries(["claude", "codex"].map((provider) => [provider, execFileSync(provider, ["--version"], { encoding: "utf8", timeout: 15000 }).trim()]));
if (real && Object.values(cliVersions).some((version) => /fake/i.test(version))) throw new Error("Fake CLI cannot produce real evidence");
const results: unknown[] = [];
let failure: unknown;
try {
  for (let i = 0; i < count; i++) {
    const id = teamIds[i % 2]!, started = Date.now(); await service.cycle(id, `pilot-${i}`);
    for (;;) { await service.reconcile(); const team = service.store.get(id), cycle = team.cycles.at(-1)!; if (!["requested", "discovering", "selecting", "building"].includes(cycle.status)) { results.push({ cycle: cycle.id, team: id, status: cycle.status, reason: cycle.reason, durationMs: Date.now() - started, claims: cycle.launches, opportunities: team.opportunities.filter((o) => o.cycleId === cycle.id).map((o) => ({ id: o.id, status: o.status, evidenceVerified: o.evidenceVerified, result: o.result })) }); break; } if (Date.now() - started > (real ? 65 * 60_000 : 60_000)) throw new Error("Pilot cycle exceeded its wall-clock bound"); await new Promise((r) => setTimeout(r, 200)); }
    console.log(`Completed pilot cycle ${i + 1}/${count}`);
  }
} catch (error) { failure = error; }
finally {
  try { await service.stop(); } catch (error) { failure ??= error; }
  try { await flushWrites(); } catch (error) { failure ??= error; }
  const report = { version: 1, mode: real ? "real" : "fake", ...provenance, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), at: new Date().toISOString(), cliVersions, modelSettings: "Provider defaults; aliases are not pinned snapshots", repositoryTrees: teamIds.map((id) => { try { return git(service.store.get(id).repo, "rev-parse", "main^{tree}"); } catch { return null; } }), repositories: teamIds.map((id) => service.store.get(id).repo), cycles: results, interpretation: real ? "Owner usefulness, novelty and approval feedback is still required. CLI completion alone does not establish product value." : "Synthetic mechanics evidence only. No model quality, owner acceptance or real-provider reliability claim." };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(`Report: ${join(output, "report.json")}`);
}
if (failure) throw failure;
