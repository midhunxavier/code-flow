/** Real HTTP/browser comparison. Isolated fixtures; never uses the owner's run data. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, cp, symlink, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir, cpus, totalmem, platform, arch, loadavg } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name: string, fallback: string) => process.argv[process.argv.indexOf(name) + 1] && process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const ref = execFileSync("git", ["rev-parse", "--verify", `${arg("--baseline", "origin/main")}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
const trials = Number(arg("--trials", "7")); assert.ok(Number.isInteger(trials) && trials >= 3 && trials <= 30);
const output = resolve(arg("--output", "output/performance/comparison.json"));
const temp = await mkdtemp(join(tmpdir(), "codeflow-comparison-"));
const token = "isolated-performance-fixture";
const headers = { authorization: `Bearer ${token}` };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number) => Math.round(value * 100) / 100;
const stats = (values: number[]) => { if (!values.length) return null; const ordered = [...values].sort((a, b) => a - b); return { median: round(ordered[Math.floor(ordered.length / 2)]!), min: round(ordered[0]!), max: round(ordered.at(-1)!), samples: values.map(round) }; };
const port = () => new Promise<number>((accept) => { const server = createServer().listen(0, "127.0.0.1", () => { const value = (server.address() as AddressInfo).port; server.close(() => accept(value)); }); });
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  await exited; clearTimeout(timer);
}
async function fixture(home: string, repo: string, count: number, events: number) {
  await mkdir(join(home, "runs"), { recursive: true });
  const timestamp = 1_700_000_000_000;
  const base = { task: "Benchmark transcript", pattern: "solo", repo, baseRef: "main", baseLabel: "main", branchPrefix: "codeflow/benchmark", worktreeDir: join(home, "worktrees"), roles: { worker: ["codex"] }, options: {}, context: { paths: [], attachments: [] }, agentSettings: {}, roleSettings: {}, trust: "standard", loop: { check: "", setup: "", maxSteps: 10, maxMinutes: 10 }, usage: { agentSteps: 0, checks: 0 }, status: "done", createdAt: timestamp, endedAt: timestamp + 100, seen: true, archived: false, worktrees: [], steps: [], notes: [], approvals: {}, followUps: [], merges: [], prs: {}, watches: {}, artifacts: [] };
  for (let i = 0; i < count; i++) {
    const run = { ...base, id: `fixture-${i}`, task: `Fixture task ${i} searchable project ${i % 10}`, createdAt: timestamp - i - 1 };
    await writeFile(join(home, "runs", `${run.id}.jsonl`), JSON.stringify({ type: "run", runId: run.id, seq: i + 1, ts: timestamp, run }) + "\n");
  }
  const id = "benchmark", file = join(home, "runs", id + ".jsonl");
  const step = { id: "benchmark-step", kind: "agent", title: "Measured transcript", role: "worker", agent: "codex", mode: "write", status: "done", worktree: "", startedAt: timestamp, endedAt: timestamp + 100, finalText: "Benchmark complete" };
  await writeFile(file, [JSON.stringify({ type: "run", runId: id, seq: count + 1, ts: timestamp, run: { ...base, id } }), JSON.stringify({ type: "step", runId: id, seq: count + 2, ts: timestamp, step })].join("\n") + "\n");
  for (let start = 0; start < events; start += 1000) await appendFile(file, Array.from({ length: Math.min(1000, events - start) }, (_, i) => JSON.stringify({ type: "agent", runId: id, stepId: step.id, seq: count + 3 + start + i, ts: timestamp, event: { kind: "text", text: text(start + i + 1) } })).join("\n") + "\n");
}
function text(seq: number) { return `BENCHMARK_EVENT_${seq} ` + "Synthetic output for a reproducible app benchmark. ".repeat(4); }

async function launch(directory: string, home: string) {
  const address = `http://localhost:${await port()}`;
  const started = performance.now(); let log = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: directory, env: { ...process.env, PORT: new URL(address).port, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  const record = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8000); };
  child.stdout!.on("data", record); child.stderr!.on("data", record);
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error(`Benchmark server exited: ${log}`);
    if (await fetch(`${address}/api/health`, { headers }).then((response) => response.ok, () => false)) return { child, address, startupMs: performance.now() - started };
    await sleep(100);
  }
  await stop(child); throw new Error(`Benchmark startup timed out: ${log}`);
}

async function browserTrial(browser: Browser, address: string, repo: string, events: number) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: headers });
  await context.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable"); await cdp.send("Performance.enable");
  let receivedBytes = 0;
  cdp.on("Network.dataReceived", (event) => { receivedBytes += event.dataLength; });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    const start = performance.now();
    await page.goto(`${address}/#/run/benchmark`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator(".runview .run-head h2").waitFor({ timeout: 30_000 });
    const shellMs = performance.now() - start;
    await page.getByRole("button", { name: /^Show work/ }).click();
    await page.getByText(text(events), { exact: true }).waitFor({ timeout: 30_000 });
    const transcriptMs = performance.now() - start, bytesToTranscript = receivedBytes;
    await sleep(200); await cdp.send("HeapProfiler.collectGarbage");
    const metrics = await cdp.send("Performance.getMetrics");
    assert.deepEqual(errors, [], "browser raised no exceptions");
    return { shellMs, transcriptMs, receivedBytes: bytesToTranscript, heapBytes: metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")!.value, rows: await page.locator(".transcript .ev").count() };
  } catch (error) {
    throw new Error(`${String(error)}; page errors: ${JSON.stringify(errors)}; received bytes: ${receivedBytes}`);
  } finally { await context.close(); }
}

async function transcriptRequest(address: string, legacy: boolean, events: number) {
  const endpoint = legacy ? "/api/runs/benchmark/events" : "/api/runs/benchmark/transcript?step=benchmark-step";
  const response = await fetch(address + endpoint, { headers, signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200);
  if (!legacy) {
    const payload = await response.text(), page = JSON.parse(payload);
    assert.equal(page.events.at(-1).event.text, text(events)); return Buffer.byteLength(payload);
  }
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "", bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) throw new Error("Legacy stream ended before latest event");
      bytes += next.value.byteLength; buffer += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: ")); if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type === "agent" && event.event.text === text(events)) return bytes;
      }
    }
  } finally { await reader.cancel(); }
}

const processes: ChildProcess[] = [];
let browser: Browser | undefined;
try {
  const baseline = join(temp, "baseline"), native = join(temp, "native"), repo = join(temp, "repo");
  await mkdir(baseline); await mkdir(native); await mkdir(repo);
  execFileSync("tar", ["-xf", "-", "-C", baseline], { input: execFileSync("git", ["archive", ref], { cwd: root, maxBuffer: 128 * 1024 * 1024 }) });
  assert.deepEqual(JSON.parse(await readFile(join(baseline, "package.json"), "utf8")).dependencies, JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies, "baseline dependency versions must match");
  await symlink(join(root, "node_modules"), join(baseline, "node_modules"));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: baseline, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, stdio: "inherit" });
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", "experiments/rust-transcript/Cargo.toml"], { cwd: root, stdio: "inherit" });
  await cp(join(root, "src"), join(native, "src"), { recursive: true });
  for (const name of ["node_modules", "public", "scripts", "experiments", "dist"]) await symlink(join(root, name), join(native, name));
  await cp(join(root, "package.json"), join(native, "package.json"));
  const source = await readFile(join(native, "src/transcript.ts"), "utf8");
  assert.ok(source.includes("reader: typeof reverseLines = reverseLines"));
  await writeFile(join(native, "src/transcript.ts"), 'import { rustReverseLines } from "../experiments/rust-transcript/reader.js";\n' + source.replace("reader: typeof reverseLines = reverseLines", "reader: typeof reverseLines = rustReverseLines"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); await writeFile(join(repo, "README.md"), "Benchmark fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const result: any = { baseline: ref, optimized: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), trials, machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version, browser: browser.version(), rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(), loadAverage: loadavg() }, method: "One unmeasured browser warmup per variant, then fresh browser context per trial; OS filesystem caches are not flushed. Variant order rotates each round. Timings include HTTP, JS parsing, rendering and native process startup/IPC. Browser heap is collected after GC. API requests are warm. Synthetic data; no provider inference.", scenarios: [] };
  for (const scenario of [{ name: "small", runs: 20, events: 1000 }, { name: "medium", runs: 200, events: 5000 }, { name: "stress", runs: 200, events: 100_000 }].filter((entry) => arg("--scenarios", "small,medium,stress").split(",").includes(entry.name))) {
    const sourceHome = join(temp, `${scenario.name}-fixture`); await fixture(sourceHome, repo, scenario.runs, scenario.events);
    const variants: any[] = [];
    for (const [name, directory] of [["baseline", baseline], ["typescript", root], ["rust", native]]) {
      const home = join(temp, `${scenario.name}-${name}`); await cp(sourceHome, home, { recursive: true });
      const server = await launch(directory!, home); processes.push(server.child);
      variants.push({ name, ...server, browser: [], historyMs: [], transcriptApiMs: [], transcriptApiBytes: [], failures: [], browserFailed: false, apiFailed: false });
    }
    for (const variant of variants) {
      console.error(`${scenario.name} ${variant.name}: browser warmup`);
      try { await browserTrial(browser, variant.address, repo, scenario.events); }
      catch (error) { variant.browserFailed = true; variant.failures.push({ phase: "browser warmup", error: String(error) }); console.error(String(error)); await stop(variant.child); }
    }
    for (let round = 0; round < trials; round++) {
      for (let index = 0; index < variants.length; index++) {
        const variant = variants[(index + round) % variants.length]!;
        console.error(`${scenario.name} ${variant.name}: starting trial ${round + 1}/${trials}`);
        if (variant.browserFailed) continue;
        if (!variant.browserFailed) {
          try { variant.browser.push(await browserTrial(browser, variant.address, repo, scenario.events)); }
          catch (error) { variant.browserFailed = true; variant.failures.push({ phase: `browser trial ${round + 1}`, error: String(error) }); console.error(String(error)); await stop(variant.child); continue; }
        }
        for (let repeat = 0; repeat < 5; repeat++) {
          let start = performance.now();
          const page = await fetch(`${variant.address}/api/runs?limit=50&q=Fixture%201`, { headers, signal: AbortSignal.timeout(30_000) }).then((response) => { assert.equal(response.status, 200); return response.json(); });
          variant.historyMs.push(performance.now() - start); assert.ok(page.total > 0);
          start = performance.now();
          if (!variant.apiFailed) {
            try {
              const bytes = await transcriptRequest(variant.address, variant.name === "baseline", scenario.events);
              variant.transcriptApiMs.push(performance.now() - start); variant.transcriptApiBytes.push(bytes);
            } catch (error) { variant.apiFailed = true; variant.failures.push({ phase: "transcript API", error: String(error) }); }
          }
        }
        console.error(`${scenario.name} ${variant.name}: trial ${round + 1}/${trials}, transcript ${variant.browser.length ? roundValue(variant.browser.at(-1).transcriptMs) : "failed"} ms`);
      }
    }
    result.scenarios.push({ ...scenario, variants: variants.map((variant) => ({ name: variant.name, failures: variant.failures, startupMs: roundValue(variant.startupMs), browser: Object.fromEntries(["shellMs", "transcriptMs", "receivedBytes", "heapBytes", "rows"].map((metric) => [metric, stats(variant.browser.map((trial: any) => trial[metric]))])), historyMs: stats(variant.historyMs), transcriptApiMs: stats(variant.transcriptApiMs), transcriptApiBytes: stats(variant.transcriptApiBytes) })) });
    for (const variant of variants) await stop(variant.child);
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
} finally { for (const process of processes) await stop(process); await browser?.close(); await rm(temp, { recursive: true, force: true }); }
function roundValue(value: number) { return Math.round(value * 100) / 100; }
