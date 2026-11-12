/**
 * Live canary for the conversational CLI integration: one real review per provider on a disposable repository.
 * It spends real provider calls, so it only runs when CODEFLOW_CANARY=1 is set by the operator.
 * That explicit opt-in accepts these fixed, read-only review proposals through the owner API.
 * It does not exercise or certify a host's native approval form.
 *
 *   CODEFLOW_CANARY=1 npm run canary:cli -- [--providers claude,codex] [--model claude=MODEL_ID] [--timeout 10] [--output FILE]
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
if (process.env.CODEFLOW_CANARY !== "1") throw new Error("Set CODEFLOW_CANARY=1 to spend real provider calls on a disposable repository");
const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const all = (key: string) => args.flatMap((a, i) => a === key && args[i + 1] ? [args[i + 1]!] : []);
const directory = await mkdtemp(join(tmpdir(), "codeflow-canary-")), repo = join(directory, "repo");
process.env.CODEFLOW_HOME = join(directory, "state"); process.env.CODEFLOW_METRICS = "0";
await mkdir(repo);
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
await writeFile(join(repo, "total.mjs"), "export function total(prices) {\n  let sum = 0;\n  for (let i = 0; i < prices.length; i++) sum += prices[i];\n  return sum;\n}\n");
await writeFile(join(repo, "README.md"), "Disposable canary repository. Nothing here is to be changed, pushed or deployed.\n");
git("add", "."); git("-c", "user.name=Canary", "-c", "user.email=canary@localhost", "commit", "-qm", "initial");
// The uncommitted change under review has a planted off-by-one: the last price is skipped.
await writeFile(join(repo, "total.mjs"), "export function total(prices) {\n  let sum = 0;\n  for (let i = 0; i < prices.length - 1; i++) sum += prices[i];\n  return sum;\n}\n");

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { getAdapter } = await import("../src/adapters/index.js");
const { CliTeamsService } = await import("../src/cli-teams/service.js");
const { proposeRecipe, runStatus } = await import("../src/cli-teams/simple.js");
const { PROVIDERS, isProvider } = await import("../src/cli-teams/model.js");
const { acquireLock, flushWrites } = await import("../src/store.js");
const release = await acquireLock(0);
const manager = new RunManager(findPattern), service = new CliTeamsService(manager);
await service.load();
const connection = await service.connect(repo), call = (name: string, a: unknown) => service.call(connection, name, a) as Promise<any>;
const models = Object.fromEntries(all("--model").map(entry => entry.split("=") as [string, string]));
const minutes = Number(option("--timeout") ?? 10);
const requested = option("--providers")?.split(",") ?? [...PROVIDERS].filter(p => p !== "agy");
const version = (provider: string) => { try { return execFileSync(provider, ["--version"], { encoding: "utf8", timeout: 15000 }).trim().split("\n")[0]; } catch { return undefined; } };
const results: any[] = [];
try {
  for (const provider of requested) {
    if (!isProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
    const began = Date.now(), entry: any = { provider, cliVersion: version(provider) };
    results.push(entry);
    try {
      if (!await getAdapter(provider).available()) { entry.state = "skipped"; entry.reason = "CLI not installed"; continue; }
      const proposal = await proposeRecipe(call, { operationId: `canary-${provider}-${began}`, task: "Review the uncommitted change to total.mjs. Report any bug with file and line.", mode: "review", team: [{ provider, ...(models[provider] ? { model: models[provider] } : {}) }] });
      await service.accept(connection, proposal.proposalId, proposal.revision, proposal.proposalHash);
      const { runId } = await call("codeflow_start_run", { operationId: `canary-start-${provider}-${began}`, proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
      let status = await runStatus(call, { runId, waitSeconds: 25 });
      while (status.state === "working" && Date.now() - began < minutes * 60_000) status = await runStatus(call, { runId, waitSeconds: 25 });
      if (status.state === "working") await call("codeflow_control_run", { operationId: `canary-cancel-${provider}-${began}`, runId, action: "cancel" });
      const text = status.resultFile ? await readFile(status.resultFile, "utf8") : "";
      Object.assign(entry, { state: status.state, outcome: status.outcome, model: status.usage?.participants[0]?.model, calls: status.usage?.calls, resultFile: !!status.resultFile,
        // A soft signal, not a pass condition: models word findings differently.
        mentionsPlantedBug: /length\s*-\s*1|off.by.one|last (price|element|item)|skips?/i.test(text), ...(status.state === "finished" ? {} : { reason: status.message }) });
    } catch (error) { entry.state = "error"; entry.reason = error instanceof Error ? error.message : String(error); }
    finally { entry.seconds = Math.round((Date.now() - began) / 1000); }
  }
} finally {
  await manager.shutdown(); await flushWrites(); release();
  if (!args.includes("--keep")) await rm(directory, { recursive: true, force: true });
}
const report = { at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version, codeFlow: JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version, results };
const output = resolve(option("--output") ?? "output/cli-canary.json");
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
for (const r of results) console.log(`${r.provider}${r.cliVersion ? ` (${r.cliVersion})` : ""}: ${r.state}${r.outcome ? ` · ${r.outcome}` : ""}${r.model ? ` · ${r.model}` : ""} · ${r.seconds}s${r.state === "finished" ? ` · planted bug ${r.mentionsPlantedBug ? "mentioned" : "not mentioned"}` : r.reason ? ` · ${r.reason}` : ""}`);
console.log(`Report: ${output}`);
const ran = results.filter(r => r.state !== "skipped");
process.exit(ran.length && ran.every(r => r.state === "finished") ? 0 : 1);
