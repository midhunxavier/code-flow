import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-checkpoints-"));
const { appendLine, checkpointHealth, flushWrites, readJsonLines, readRunCheckpoint, RUNS_DIR, writeHealth } = await import("../src/store.js");
const snapshot = (id: string, text: string) => ({ id, steps: [{ id: "s1", finalText: text }], status: "done", summary: text });
const checkpointPath = (id: string) => join(RUNS_DIR, `${id}.checkpoint.json`);

test("checkpoint snapshots are captured when queued and correspond to the completed append", async () => {
  const run = snapshot("capture", "before");
  const written = appendLine("capture.jsonl", { seq: 8, type: "run", run }, { checkpoint: { seq: 8, run } });
  run.summary = "after"; run.steps[0]!.finalText = "after";
  await written;
  assert.deepEqual(await readRunCheckpoint("capture"), { seq: 8, run: snapshot("capture", "before") });
  assert.equal((await readJsonLines("capture.jsonl"))[0].run.summary, "before");
});

test("every later event invalidates the checkpoint and the next snapshot replaces it", async () => {
  await appendLine("append.jsonl", { seq: 1 }, { checkpoint: { seq: 1, run: snapshot("append", "one") } });
  assert.ok(await readRunCheckpoint("append"));
  await appendLine("append.jsonl", { seq: 2, type: "agent", event: "output" });
  assert.equal(await readRunCheckpoint("append"), undefined);
  await appendLine("append.jsonl", { seq: 3 }, { checkpoint: { seq: 3, run: snapshot("append", "three") } });
  assert.equal((await readRunCheckpoint("append"))?.seq, 3);
  await flushWrites();
});

test("invalid, tampered and replaced-source caches always fall back to journal reconstruction", async () => {
  for (const [id, corrupt] of [
    ["broken", () => "{"],
    ["sequence", (text: string) => { const data = JSON.parse(text); data.seq = 999; return JSON.stringify(data); }],
    ["snapshot", (text: string) => { const data = JSON.parse(text); data.run.summary = "corrupt"; return JSON.stringify(data); }],
    ["version", (text: string) => { const data = JSON.parse(text); data.version = 999; return JSON.stringify(data); }],
  ] as const) {
    await appendLine(`${id}.jsonl`, { seq: 1 }, { checkpoint: { seq: 1, run: snapshot(id, "original") } });
    await writeFile(checkpointPath(id), corrupt(await readFile(checkpointPath(id), "utf8")));
    assert.equal(await readRunCheckpoint(id), undefined, id);
  }
  const id = "replaced";
  await appendLine(`${id}.jsonl`, { seq: 1 }, { checkpoint: { seq: 1, run: snapshot(id, "original") } });
  const file = join(RUNS_DIR, `${id}.jsonl`);
  const previous = await stat(file);
  const contents = await readFile(file, "utf8");
  await rm(file); await writeFile(file, contents); await utimes(file, previous.atime, previous.mtime);
  assert.equal(await readRunCheckpoint(id), undefined, "replacement with the same size and mtime still has a different identity");
  assert.equal(await readRunCheckpoint("../outside"), undefined);
});

test("cache write errors do not reject strict journal writes or poison subsequent appends", async () => {
  await mkdir(checkpointPath("obstructed"), { recursive: true });
  const failures = writeHealth.failures;
  const optionalFailures = checkpointHealth.failures;
  await appendLine("obstructed.jsonl", { seq: 1 }, { strict: true, sync: true, checkpoint: { seq: 1, run: snapshot("obstructed", "one") } });
  assert.equal(writeHealth.failures, failures);
  assert.equal(checkpointHealth.failures, optionalFailures + 1);
  await rm(checkpointPath("obstructed"), { recursive: true });
  await appendLine("obstructed.jsonl", { seq: 2 }, { strict: true, checkpoint: { seq: 2, run: snapshot("obstructed", "two") } });
  assert.equal((await readRunCheckpoint("obstructed"))?.seq, 2);
  assert.equal((await readJsonLines("obstructed.jsonl")).length, 2);
});

test("inconsistent sequence metadata and large checkpoint files are ignored", async () => {
  await appendLine("wrong-seq.jsonl", { seq: 1 }, { checkpoint: { seq: 2, run: snapshot("wrong-seq", "one") } });
  assert.equal(await readRunCheckpoint("wrong-seq"), undefined);
  await appendLine("too-big.jsonl", { seq: 1 }, { checkpoint: { seq: 1, run: snapshot("too-big", "one") } });
  await appendFile(checkpointPath("too-big"), Buffer.alloc(16 * 1024 * 1024));
  assert.equal(await readRunCheckpoint("too-big"), undefined);
});
