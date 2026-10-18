import type { RunEvent, RunSummary } from "./engine.js";

/**
 * What a window needs to show a run, from its event history: every agent event and log line, but
 * only the latest snapshot of the run and of each step. A run's log has a snapshot for every change
 * (each with the task, the issue's text, CI logs, the repository's conventions…), and a window
 * that connects only ever shows the last one, so sending the rest cost most of the bytes.
 * The events keep their order, so a window applies them as it would live ones.
 */
export function replayEvents(events: RunEvent[]): RunEvent[] {
  let lastRun = -1;
  const lastStep = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.type === "run") lastRun = i;
    else if (e.type === "step") lastStep.set(e.step.id, i);
  });
  return events.filter((e, i) => (e.type === "run" ? i === lastRun : e.type === "step" ? lastStep.get(e.step.id) === i : true));
}

// ---------------------------------------------------------------- run snapshots on disk
/**
 * In a run's log (`<id>.jsonl`), a snapshot that follows another is written as what changed since
 * the snapshot numbered `base`: the top-level fields set (`set`) or removed (`unset`), and for a
 * string or a list that kept its start (a summary with a line added, a follow-up appended or
 * finished), the index it changed from and the rest (`tail`). Fields that never change (the task,
 * the issue's text, CI logs, conventions) are then only in full snapshots: the first one this
 * code-flow writes for a run, the one at the end of each time it runs, one now and then (see
 * RunLogWriter), and the next one after a line failed to save. Reading a log turns patches back
 * into snapshots (`decodeRunLog`), so nothing else sees them, and logs written before this read
 * as they always did. A patch whose base isn't the snapshot before it in the log (that line was
 * lost) is skipped, and so is everything after it until the next full snapshot. An older
 * code-flow skips the patches and shows a run as of its last full snapshot.
 */
export type RunPatch = {
  seq: number;
  ts: number;
  runId: string;
  type: "run-patch";
  /** The `seq` of the snapshot this patch changes. */
  base: number;
  set?: Record<string, unknown>;
  tail?: Record<string, [number, unknown]>;
  unset?: string[];
};

/** A full snapshot after this many patches in a row, or once they add up to more than one. */
const MAX_PATCHES = 100;
/** A string's tail is written only when it keeps at least this much of the start. */
const MIN_STRING_KEPT = 64;

interface Written {
  seq: number;
  run: RunSummary;
  json: Map<string, string>;
  patches: number;
  /** Patches' bytes since the last full snapshot, and that snapshot's. */
  bytes: number;
  full: number;
}

/**
 * Turns a run's events into the lines written to its log, remembering each run's last snapshot.
 * `fullAtEnd`: a full snapshot each time a run stops running, so an older code-flow reads a log
 * that's still being written as of the run's last end.
 */
export class RunLogWriter {
  private last = new Map<string, Written>();

  constructor(private readonly fullAtEnd = true) {}

  /** A line for this run didn't make it to disk: its next snapshot is written whole. */
  forget(runId: string) {
    this.last.delete(runId);
  }

  encode(event: RunEvent, opts: { full?: boolean } = {}): RunEvent | RunPatch {
    if (event.type !== "run") return event;
    const json = fieldsOf(event.run);
    const prev = this.last.get(event.runId);
    const ended = this.fullAtEnd && prev?.run.status === "running" && event.run.status !== "running";
    if (!prev || opts.full || ended || prev.patches >= MAX_PATCHES || prev.bytes >= prev.full) {
      this.last.set(event.runId, { seq: event.seq, run: event.run, json, patches: 0, bytes: 0, full: sizeOf(json) });
      return event;
    }
    const patch: RunPatch = { seq: event.seq, ts: event.ts, runId: event.runId, type: "run-patch", base: prev.seq };
    for (const [key, value] of json) {
      const before = prev.json.get(key);
      if (before === value) continue;
      const tail = before === undefined ? undefined : tailOf((prev.run as Record<string, unknown>)[key], (event.run as Record<string, unknown>)[key], value);
      if (tail) (patch.tail ??= {})[key] = tail;
      else (patch.set ??= {})[key] = (event.run as Record<string, unknown>)[key];
    }
    for (const key of prev.json.keys()) if (!json.has(key)) (patch.unset ??= []).push(key);
    this.last.set(event.runId, { ...prev, seq: event.seq, run: event.run, json, patches: prev.patches + 1, bytes: prev.bytes + JSON.stringify(patch).length });
    return patch;
  }
}

/** A snapshot's top-level fields as JSON, as a full line would write them (undefined ones aren't). */
function fieldsOf(run: RunSummary): Map<string, string> {
  const json = new Map<string, string>();
  for (const [key, value] of Object.entries(run)) {
    const text = JSON.stringify(value);
    if (text !== undefined) json.set(key, text);
  }
  return json;
}

const sizeOf = (json: Map<string, string>) => [...json].reduce((n, [k, v]) => n + k.length + v.length + 4, 2);

/** Where a string or a list stopped matching, and the rest of the new one: when that's shorter than all of it. */
function tailOf(before: unknown, after: unknown, afterJson: string): [number, unknown] | undefined {
  let kept = 0;
  if (typeof before === "string" && typeof after === "string") {
    const n = Math.min(before.length, after.length);
    // By UTF-16 unit: an emoji split in two goes through JSON and back whole.
    while (kept < n && before.charCodeAt(kept) === after.charCodeAt(kept)) kept++;
    if (kept < MIN_STRING_KEPT) return undefined;
    return [kept, after.slice(kept)];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.min(before.length, after.length);
    while (kept < n && JSON.stringify(before[kept]) === JSON.stringify(after[kept])) kept++;
    if (!kept) return undefined;
    const rest = after.slice(kept);
    return JSON.stringify(rest).length < afterJson.length * 0.8 ? [kept, rest] : undefined;
  }
  return undefined;
}

/**
 * A run's log as events, with every patch turned back into the snapshot it describes. A patch
 * whose base isn't the snapshot before it (a line lost to a failed write or a crash) is skipped,
 * and so are the patches after it, until the next full snapshot: a run is never pieced together
 * from snapshots that don't follow each other. Unchanged fields are shared with the snapshot
 * before, so treat the snapshots as read-only.
 */
export function decodeRunLog(lines: unknown[]): RunEvent[] {
  const out: RunEvent[] = [];
  let current: RunSummary | undefined;
  let currentSeq = -1;
  for (const line of lines as (RunEvent | RunPatch)[]) {
    if (line?.type === "run") {
      current = line.run;
      currentSeq = line.seq;
      out.push(line);
    } else if (line?.type === "run-patch") {
      if (!current || current.id !== line.runId || line.base !== currentSeq) {
        current = undefined;
        continue;
      }
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(line.set ?? {})) next[key] = value;
      for (const [key, [at, rest]] of Object.entries(line.tail ?? {})) {
        const before = next[key];
        if (typeof before === "string" && typeof rest === "string" && before.length >= at) next[key] = before.slice(0, at) + rest;
        else if (Array.isArray(before) && Array.isArray(rest) && before.length >= at) next[key] = [...before.slice(0, at), ...rest];
      }
      for (const key of line.unset ?? []) delete next[key];
      current = next as unknown as RunSummary;
      currentSeq = line.seq;
      out.push({ seq: line.seq, ts: line.ts, runId: line.runId, type: "run", run: current });
    } else if (line) {
      out.push(line);
    }
  }
  return out;
}

/**
 * A log's lines with its snapshots written as patches (see RunLogWriter), for logs written before
 * this, or with too many full snapshots. The last snapshot stays a full one, so an older
 * code-flow still shows the run as it is.
 */
export function compactRunLog(events: RunEvent[]): (RunEvent | RunPatch)[] {
  const writer = new RunLogWriter(false);
  let lastRun = -1;
  events.forEach((e, i) => e.type === "run" && (lastRun = i));
  return events.map((e, i) => writer.encode(e, { full: i === lastRun }));
}
