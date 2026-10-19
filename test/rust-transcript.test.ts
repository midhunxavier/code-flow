import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("experimental Rust reader matches TypeScript pages, previews and byte cursors", { skip: process.env.CODEFLOW_TEST_RUST !== "1" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "cf-rust-parity-")); process.env.CODEFLOW_HOME = home;
  const { transcriptPage } = await import("../src/transcript.js");
  const { rustReverseLines } = await import("../experiments/rust-transcript/reader.js");
  const runs = join(home, "runs"); await mkdir(runs, { recursive: true });
  const event = (seq: number) => ({ type: "agent", runId: "parity", stepId: seq % 2 ? "odd" : "even", seq, ts: seq, event: { kind: "text", text: `Item ${seq} 🦊` } });
  try {
    const lines = Array.from({ length: 1300 }, (_, i) => JSON.stringify(event(i + 1)));
    lines.splice(200, 0, "bad record", "null", "", JSON.stringify({ ...event(1), type: "run-patch" }));
    lines.push(JSON.stringify({ ...event(1301), event: { kind: "text", text: "🦊\n".repeat(200_000) } }), "torn{");
    await writeFile(join(runs, "parity.jsonl"), lines.join("\n"));
    for (const step of [undefined, "odd", "missing"]) {
      let before: string | undefined;
      do {
        const expected = await transcriptPage("parity", { before, step, limit: 127 });
        assert.deepEqual(await transcriptPage("parity", { before, step, limit: 127 }, rustReverseLines), expected);
        before = expected.before;
      } while (before);
    }
    for (const after of [1, 1295, 1301, 99999]) assert.deepEqual(await transcriptPage("parity", { after }, rustReverseLines), await transcriptPage("parity", { after }));
    await writeFile(join(runs, "parity.jsonl"), "\n".repeat(200_000));
    assert.deepEqual(await transcriptPage("parity", {}, rustReverseLines), await transcriptPage("parity"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
