import type { RunEvent } from "./types.js";

/** A byte and count budget applies even while a run streams for hours. */
export class TranscriptCache {
  readonly records = new Map<number, { event: RunEvent; bytes: number }>();
  bytes = 0;
  constructor(readonly maxBytes = 8 * 1024 * 1024, readonly maxEvents = 10_000) {}
  add(event: RunEvent): RunEvent[] {
    if (this.records.has(event.seq)) return [];
    const bytes = JSON.stringify(event).length * 2;
    this.records.set(event.seq, { event, bytes }); this.bytes += bytes;
    const removed: RunEvent[] = [];
    if (this.bytes > this.maxBytes || this.records.size > this.maxEvents) {
      for (const [seq, entry] of this.records) {
        this.records.delete(seq); this.bytes -= entry.bytes; removed.push(entry.event);
        if (this.bytes <= this.maxBytes * .75 && this.records.size <= this.maxEvents * .75) break;
      }
    }
    return removed;
  }
  deleteStep(step: string): void {
    for (const [seq, entry] of this.records) if (entry.event.type === "agent" && entry.event.stepId === step) { this.records.delete(seq); this.bytes -= entry.bytes; }
  }
}
