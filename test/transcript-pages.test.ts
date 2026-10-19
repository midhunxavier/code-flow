import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = await mkdtemp(join(tmpdir(), "cf-transcript-")); process.env.CODEFLOW_HOME = home;
const { transcriptPage, TRANSCRIPT_LIMITS } = await import("../src/transcript.js");
const { RUNS_DIR, flushWrites } = await import("../src/store.js");
await mkdir(RUNS_DIR, { recursive: true });
after(async () => { await flushWrites(); await rm(home, { recursive: true, force: true }); });
const event = (seq: number, text = `event ${seq} 🦊`) => ({ type: "agent", runId: "r", stepId: seq % 2 ? "odd" : "even", seq, ts: seq, event: { kind: "text", text } });
const file = join(RUNS_DIR, "r.jsonl");

test("byte cursors page every event once with Unicode and interspersed snapshots", async () => {
  const lines = Array.from({ length: 1200 }, (_, index) => JSON.stringify(event(index + 1)));
  lines.splice(700, 0, JSON.stringify({ type: "run-patch", runId: "r", seq: 700, set: { task: "ignored metadata" } }));
  await writeFile(file, lines.join("\n") + "\n");
  let before: string | undefined; const seen: number[] = [];
  do {
    const page = await transcriptPage("r", { before, limit: 71 });
    assert.ok(page.events.length <= 71); assert.ok(page.bytes <= TRANSCRIPT_LIMITS.bytes);
    seen.push(...page.events.map((entry) => entry.seq)); before = page.before;
  } while (before);
  assert.equal(seen.length, 1200); assert.equal(new Set(seen).size, 1200);
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 1200 }, (_, i) => i + 1));
  const filtered = await transcriptPage("r", { step: "odd" });
  assert.ok(filtered.events.every((entry) => entry.type === "agent" && entry.stepId === "odd"));
});
test("reconnect explicitly reports a gap and cursors remain stable across append", async () => {
  const latest = await transcriptPage("r"); assert.equal(latest.events.length, 500);
  const resumed = await transcriptPage("r", { after: 1190 }); assert.equal(resumed.resumed, true); assert.equal(resumed.events.length, 10);
  assert.equal((await transcriptPage("r", { after: 1 })).resumed, false);
  await appendFile(file, JSON.stringify(event(1201)) + "\n");
  const older = await transcriptPage("r", { before: latest.before }); assert.ok(older.events.every((entry) => entry.seq <= 700));
  await assert.rejects(transcriptPage("another", { before: latest.before }), /ENOENT|changed/);
  const replacement = file + ".new"; await writeFile(replacement, JSON.stringify(event(1)) + "\n"); await rename(replacement, file);
  await assert.rejects(transcriptPage("r", { before: latest.before }), /changed/);
});
test("large event previews are bounded without modifying authoritative text", async () => {
  const text = "long 🦊 output\n".repeat(100_000);
  await writeFile(file, JSON.stringify(event(1, text)) + "\n");
  const page = await transcriptPage("r"); assert.equal(page.events.length, 1); assert.ok(page.bytes < TRANSCRIPT_LIMITS.bytes);
  const preview = page.events[0]!; assert.equal(preview.type, "agent");
  if (preview.type === "agent" && preview.event.kind === "text") assert.match(preview.event.text, /Preview shortened/);
  await assert.rejects(transcriptPage("r", { before: "invalid" }), /cursor/);
  await assert.rejects(transcriptPage("r", { limit: 501 }), /page size/);
});

test("damaged records respect the scan budget and oversized structured events advance", async () => {
  const original = TRANSCRIPT_LIMITS.scanBytes;
  try {
    TRANSCRIPT_LIMITS.scanBytes = 1024;
    await writeFile(file, JSON.stringify(event(1)) + "\n" + "broken record\n".repeat(1000));
    const damaged = await transcriptPage("r");
    assert.equal(damaged.events.length, 0); assert.ok(damaged.before);
    assert.ok(damaged.scannedBytes >= 1024 && damaged.scannedBytes < 1100);
    await writeFile(file, "\n".repeat(200_000));
    const blank = await transcriptPage("r");
    assert.equal(blank.events.length, 0); assert.ok(blank.before);
    assert.ok(blank.scannedBytes <= 64 * 1024);
    await writeFile(file, "\n"); assert.equal((await transcriptPage("r")).before, undefined);
  } finally { TRANSCRIPT_LIMITS.scanBytes = original; }
  await writeFile(file, JSON.stringify({ ...event(1), event: { kind: "quota", status: "ok", windows: { large: { extra: "x".repeat(2 * 1024 * 1024) } } } }) + "\nnull\n");
  const page = await transcriptPage("r");
  assert.equal(page.events.length, 1); assert.equal(page.before, undefined);
  assert.ok(page.bytes < TRANSCRIPT_LIMITS.bytes); assert.match(JSON.stringify(page.events), /Preview omitted/);
  await writeFile(file, JSON.stringify({ ...event(2), stepId: "x".repeat(2 * 1024 * 1024), ts: { invalid: "x".repeat(1024 * 1024) } }) + "\n");
  const metadata = await transcriptPage("r");
  assert.ok(metadata.bytes < TRANSCRIPT_LIMITS.bytes); assert.equal(metadata.events.length, 1); assert.equal(metadata.before, undefined);
  await assert.rejects(transcriptPage("r", { before: Buffer.from("null").toString("base64url") }), /changed/);
});
