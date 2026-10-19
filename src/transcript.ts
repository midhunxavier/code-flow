import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "./engine.js";
import { RUNS_DIR, waitForRunWrites } from "./store.js";

export const TRANSCRIPT_LIMITS = { events: 500, bytes: 1024 * 1024, recordBytes: 64 * 1024 * 1024, scanBytes: 16 * 1024 * 1024, fieldChars: 32 * 1024 };
export interface TranscriptPage { events: RunEvent[]; before?: string; latestSeq: number; bytes: number; scannedBytes: number; resumed: boolean }
interface Cursor { run: string; dev: string; ino: string; offset: number }
export class TranscriptCursorError extends Error {}

/** Only presentation text is shortened. The authoritative log and export remain complete. */
export function transcriptPreview(event: RunEvent): RunEvent {
  const shorten = (value: string) => value.length > TRANSCRIPT_LIMITS.fieldChars ? value.slice(0, TRANSCRIPT_LIMITS.fieldChars) + "\n[Preview shortened; the complete event is in the run export.]" : value;
  if (event.type === "log") return { ...event, text: shorten(event.text) };
  if (event.type !== "agent") return event;
  return { ...event, event: Object.fromEntries(Object.entries(event.event).map(([key, value]) => [key, typeof value === "string" ? shorten(value) : value])) as typeof event.event };
}

/** Reverse byte-offset paging needs no initial whole-file scan or retained event index. */
async function* reverseLines(file: FileHandle, end: number): AsyncGenerator<{ text: string; offset: number }> {
  let position = end, pending: Buffer[] = [], pendingBytes = 0;
  while (position > 0) {
    const size = Math.min(position, 64 * 1024); position -= size;
    const chunk = Buffer.allocUnsafe(size); const { bytesRead } = await file.read(chunk, 0, size, position);
    if (bytesRead !== size) throw new TranscriptCursorError("Transcript changed; reload its latest page");
    let right = size;
    for (let index = size - 1; index >= 0; index--) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(index + 1, right);
      if (part.length + pendingBytes > TRANSCRIPT_LIMITS.recordBytes) throw new Error("Transcript record exceeds the 64 MiB bound");
      if (part.length || pendingBytes) {
        const text = pending.length ? Buffer.concat([part, ...pending.reverse()], part.length + pendingBytes).toString("utf8") : part.toString("utf8");
        yield { text, offset: position + index + 1 };
      } else {
        // Coalesce blank lines, but still expose their byte cost to the page budget.
        while (index > 0 && chunk[index - 1] === 10) index--;
        yield { text: "", offset: position === 0 && index === 0 ? 0 : position + index + 1 };
      }
      pending = []; pendingBytes = 0; right = index;
    }
    if (right) { const part = chunk.subarray(0, right); pending.push(part); pendingBytes += part.length; }
    if (pendingBytes > TRANSCRIPT_LIMITS.recordBytes) throw new Error("Transcript record exceeds the 64 MiB bound");
  }
  if (pendingBytes) yield { text: Buffer.concat(pending.reverse(), pendingBytes).toString("utf8"), offset: 0 };
}

/** Reader injection supports measuring native I/O without changing validation or page semantics. */
export async function transcriptPage(id: string, input: { before?: string; after?: number; step?: string; signal?: AbortSignal; limit?: number } = {}, reader: typeof reverseLines = reverseLines): Promise<TranscriptPage> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id)) throw new TranscriptCursorError("Invalid run ID");
  const limit = input.limit ?? TRANSCRIPT_LIMITS.events;
  if (!Number.isInteger(limit) || limit < 1 || limit > TRANSCRIPT_LIMITS.events) throw new TranscriptCursorError("Invalid transcript page size");
  await waitForRunWrites(id); input.signal?.throwIfAborted();
  const file = await open(join(RUNS_DIR, `${id}.jsonl`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true }); if (!info.isFile()) throw new Error("Transcript must be a regular file");
    let end = Number(info.size);
    if (input.before) {
      let cursor: Cursor;
      try { if (input.before.length > 1024) throw new Error(); cursor = JSON.parse(Buffer.from(input.before, "base64url").toString()); } catch { throw new TranscriptCursorError("Invalid transcript cursor"); }
      if (!cursor || cursor.run !== id || cursor.dev !== String(info.dev) || cursor.ino !== String(info.ino) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > end) throw new TranscriptCursorError("Transcript changed; reload its latest page");
      end = cursor.offset;
      if (end) { const byte = Buffer.alloc(1); await file.read(byte, 0, 1, end - 1); if (byte[0] !== 10) throw new TranscriptCursorError("Invalid transcript boundary"); }
    }
    const events: RunEvent[] = []; let bytes = 0, offset = end, latestSeq = 0, resumed = input.after === 0;
    for await (const line of reader(file, end)) {
      input.signal?.throwIfAborted();
      // Damaged/foreign lines count against the same scan budget as valid records.
      const skip = () => { offset = line.offset; return end - offset >= TRANSCRIPT_LIMITS.scanBytes; };
      if (!line.text.trim()) { if (skip()) break; continue; }
      let event: RunEvent; try { event = JSON.parse(line.text); } catch { if (skip()) break; continue; }
      if (!event || event.runId !== id || !Number.isSafeInteger(event.seq)) { if (skip()) break; continue; }
      latestSeq = Math.max(latestSeq, event.seq);
      if (input.after !== undefined && event.seq <= input.after) { resumed = true; break; }
      if ((event.type === "agent" || event.type === "log") && (!input.step || event.type === "agent" && event.stepId === input.step)) {
        if (event.type === "agent" && (!event.event || typeof event.event !== "object") || event.type === "log" && typeof event.text !== "string") { if (skip()) break; continue; }
        let preview = transcriptPreview(event), size = Buffer.byteLength(JSON.stringify(preview));
        if (size > TRANSCRIPT_LIMITS.bytes) {
          // Even an unusual structured provider payload must allow the cursor to advance.
          const text = "[Preview omitted because this event exceeds the display limit; the complete event is in the run export.]";
          const ts = Number.isFinite(event.ts) ? event.ts : 0;
          preview = event.type === "agent" ? { type: "agent", runId: id, stepId: typeof event.stepId === "string" ? event.stepId.slice(0, 200) : "", seq: event.seq, ts, event: { kind: "status", text } } : { type: "log", runId: id, seq: event.seq, ts, level: "info", text };
          size = Buffer.byteLength(JSON.stringify(preview));
        }
        if (events.length >= limit || bytes + size > TRANSCRIPT_LIMITS.bytes) break;
        events.push(preview); bytes += size;
      }
      offset = line.offset;
      if (end - offset >= TRANSCRIPT_LIMITS.scanBytes) break;
    }
    const after = await file.stat({ bigint: true });
    if (after.size < info.size) throw new TranscriptCursorError("Transcript changed; reload its latest page");
    const before = offset > 0 ? Buffer.from(JSON.stringify({ run: id, dev: String(info.dev), ino: String(info.ino), offset } satisfies Cursor)).toString("base64url") : undefined;
    return { events: events.reverse(), before, latestSeq, bytes, scannedBytes: end - offset, resumed: input.after !== undefined && input.after <= latestSeq && (resumed || !before) };
  } finally { await file.close(); }
}
