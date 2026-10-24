/** Browser-safe saved retraining policy and its durable occurrence ledger. */
import { DATA_LIMIT, digest, integer, MlError, object, string, type Dataset, type Experiment } from "./model.js";
import type { Planner, SearchLimits } from "./cycle-model.js";
export type Cadence = { every: number } | { at: string; timezone: string; days?: number[] };
export interface Fingerprint { hash: string; bytes: number; format: Dataset["format"] }
export interface TrainingSchedule {
  id: string; revision: number; operationId: string; requestHash: string; name: string;
  template: Experiment; datasetId: string; modelId?: string; objective: string; planner: Planner; limits: SearchLimits;
  source: { path: string; location: "target" | "controller" }; cadence: Cadence;
  stabilitySeconds: number; maxCycles: number; createdAt: number; nextAt: number;
  state: "enabled" | "paused" | "exhausted"; reason?: string;
  lastCheckedAt?: number; lastOutcome?: string;
  candidate?: Fingerprint & { firstSeenAt: number };
  pending?: { id: string; startedAt: number };
  runs: { cycleId: string; occurrence: string; hash: string; at: number }[];
}
export function fingerprint(raw: unknown): Fingerprint {
  const v = object(raw, ["hash", "bytes", "format"]);
  if (!["csv", "parquet", "jsonl"].includes(v.format)) throw new MlError("Invalid dataset format");
  return { hash: digest(v.hash), bytes: integer(v.bytes, 1, v.format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT, "Dataset size"), format: v.format };
}
export function cadence(raw: unknown): Cadence {
  const v = object(raw, ["every", "at", "days", "timezone"], "check schedule");
  if (v.every !== undefined) {
    if (v.at !== undefined || v.days !== undefined || v.timezone !== undefined) throw new MlError("Choose an interval or a calendar schedule");
    return { every: integer(v.every, 5, 10080, "Check interval in minutes") };
  }
  const at = string(v.at, "check time", 5), timezone = string(v.timezone, "time zone", 100);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new MlError("Use a 24-hour HH:MM check time");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new MlError("Enter a valid IANA time zone"); }
  if (v.days !== undefined && (!Array.isArray(v.days) || !v.days.length || v.days.length > 7 || new Set(v.days).size !== v.days.length || v.days.some((d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6))) throw new MlError("Choose unique weekdays from 0 (Sunday) to 6 (Saturday)");
  return { at, timezone, ...(v.days ? { days: [...v.days].sort() } : {}) };
}
