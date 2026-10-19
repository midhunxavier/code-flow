import { mkdtemp, mkdir, writeFile, appendFile, stat, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { RunIndex } from "../src/run-history.js";
import type { RunSummary } from "../src/engine.js";

// Synthetic data only; never read or mutate the user's actual CODEFLOW_HOME.
const home = await mkdtemp(join(tmpdir(), "codeflow-benchmark-")); process.env.CODEFLOW_HOME = home;
const { transcriptPage, TRANSCRIPT_LIMITS } = await import("../src/transcript.js");
const { RUNS_DIR } = await import("../src/store.js");
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;
try {
  const index = new RunIndex(); let start = performance.now();
  for (let i = 0; i < 10_000; i++) index.set({ id: `run-${i}`, createdAt: i, task: `Improve project ${i % 100}, task ${i}`, repo: `/fixture/repo-${i % 100}`, worktrees: [], pattern: "solo", branchPrefix: `fixture/${i}` } as unknown as RunSummary);
  const indexBuildMs = elapsed(start); index.values(); start = performance.now();
  for (let i = 0; i < 100; i++) index.values().filter((run) => index.matches(run.id, ["project", "42"])).slice(0, 50);
  const historyQueryAverageMs = elapsed(start) / 100;
  await mkdir(RUNS_DIR, { recursive: true }); const file = join(RUNS_DIR, "benchmark.jsonl");
  await writeFile(file, "");
  for (let batch = 0; batch < 100; batch++) {
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ type: "agent", runId: "benchmark", stepId: `step-${Math.floor((batch * 1000 + i) / 1000)}`, seq: batch * 1000 + i + 1, ts: i, event: { kind: "text", text: "Synthetic transcript output. ".repeat(8) } })).join("\n") + "\n";
    await appendFile(file, lines);
  }
  start = performance.now(); const first = await transcriptPage("benchmark"); const firstPageMs = elapsed(start);
  start = performance.now(); const older = await transcriptPage("benchmark", { before: first.before }); const olderPageMs = elapsed(start);
  if (first.events.length !== TRANSCRIPT_LIMITS.events || older.events.length !== TRANSCRIPT_LIMITS.events || first.bytes > TRANSCRIPT_LIMITS.bytes) throw new Error("Transcript page budget regressed");
  const assets: { name: string; bytes: number; gzipBytes: number }[] = [];
  try { for (const name of JSON.parse(await readFile("public/assets.json", "utf8")).files) { const bytes = await readFile(join("public/assets", name)); assets.push({ name, bytes: bytes.length, gzipBytes: gzipSync(bytes).length }); } } catch { /* Build UI first to include bundle sizes. */ }
  console.log(JSON.stringify({ fixture: { runs: 10_000, events: 100_000, logBytes: (await stat(file)).size }, history: { indexBuildMs, queryAverageMs: historyQueryAverageMs }, transcript: { firstPageMs, olderPageMs, events: first.events.length, responseBytes: first.bytes, scannedBytes: first.scannedBytes }, memory: process.memoryUsage(), assets }, null, 2));
} finally { await rm(home, { recursive: true, force: true }); }
