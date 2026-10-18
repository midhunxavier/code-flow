import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { Run, RunEvent } from "./engine.js";
import { RunProjection, strip } from "./run-projection.js";
import { readRunCheckpoint, RUNS_DIR, visitJsonLines } from "./store.js";

export async function recoverRun(id: string) {
  const projection = new RunProjection(), checkpoint = await readRunCheckpoint<Run>(id);
  if (checkpoint) {
    projection.apply({ seq: checkpoint.seq, ts: checkpoint.run.createdAt, runId: id, type: "run", run: strip(checkpoint.run) });
    for (const step of checkpoint.run.steps) projection.apply({ seq: checkpoint.seq, ts: step.startedAt, runId: id, type: "step", step });
  } else await visitJsonLines<RunEvent>(`${id}.jsonl`, (event) => projection.apply(event));
  return { run: projection.finish(), seq: projection.seq, records: projection.records };
}

/** Rare synchronous compatibility path for a stale cold projection; memory stays one record. */
export function recoverRunSync(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new Error("Invalid run ID");
  const file = openSync(join(RUNS_DIR, `${id}.jsonl`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), projection = new RunProjection(), decoder = new StringDecoder("utf8"), chunk = Buffer.alloc(64 * 1024); let pending = "";
  const parse = (line: string) => { if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Run log record exceeds the 64 MiB recovery bound"); if (!line.trim()) return; let event: RunEvent; try { event = JSON.parse(line); } catch { return; } projection.apply(event); };
  try {
    const before = fstatSync(file, { bigint: true }); if (!before.isFile()) throw new Error("Run log must be a regular file"); let count: number;
    while ((count = readSync(file, chunk, 0, chunk.length, null))) { pending += decoder.write(chunk.subarray(0, count)); let index: number; while ((index = pending.indexOf("\n")) >= 0) { parse(pending.slice(0, index)); pending = pending.slice(index + 1); } if (Buffer.byteLength(pending) > 64 * 1024 * 1024) throw new Error("Run log record exceeds the 64 MiB recovery bound"); }
    parse(pending + decoder.end()); const after = fstatSync(file, { bigint: true }); if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("Run log changed while recovering; retry the read");
    return { run: projection.finish(), seq: projection.seq };
  } finally { closeSync(file); }
}
