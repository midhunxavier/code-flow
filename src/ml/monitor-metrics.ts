import { createHash } from "node:crypto";
import type { InferenceInput, ServingRelease } from "./deployment-model.js";
import type { ModelMonitor } from "./monitor-model.js";
/** Fixed coarse bins keep raw rows, prompt text and category values out of durable monitoring. */
export function bin(value: unknown, salt: string) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") { if (value === 0) return 1; return (value < 0 ? 26 : 2) + Math.max(0, Math.min(23, Math.floor(Math.log2(Math.abs(value))) + 8)); }
  return 50 + createHash("sha256").update(salt + JSON.stringify(value)).digest()[0]! % 16;
}
export function observe(m: ModelMonitor, r: ServingRelease, input: InferenceInput, result: any, elapsedMs: number) {
  const w = m.window;
  if (w.requests >= 100000 || w.samples + ("rows" in input ? input.rows.length : 1) > 1000000) throw new Error("Monitoring window capacity reached; use a shorter window");
  w.requests++; w.latencyMs += Math.max(0, Math.min(300000, Math.round(elapsedMs)));
  if (!result) { w.failures++; return; }
  const rows = "rows" in input ? input.rows : [{ promptCharacters: input.prompt?.length ?? input.messages!.reduce((n, x) => n + x.content.length, 0), inputTokens: result.inputTokens, outputTokens: result.outputTokens, emptyOutput: result.text.trim().length === 0 ? 1 : 0 }];
  for (const row of rows) { w.samples++; m.features.forEach((f, i) => { w.histograms[i]![bin(row[f as keyof typeof row], m.salt)]!++; }); }
}
