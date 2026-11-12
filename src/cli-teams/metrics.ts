import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CODEFLOW_HOME } from "../config.js";

/**
 * Local funnel metrics for the CLI connection: which step hosts reach and where they stop.
 * One line per tool call, kept on this computer only. No task text, file names or results are recorded.
 * Set CODEFLOW_METRICS=0 to turn it off.
 */
export interface Metric { at: number; session: string; host?: string; hostVersion?: string; tool: string; ok: boolean; code?: string; ms: number; proposalId?: string; runId?: string; state?: string }
export const METRICS_FILE = join(resolve(CODEFLOW_HOME), "cli-teams-metrics.jsonl");
const LIMIT = 2 * 1024 * 1024;

export async function recordMetric(metric: Metric, file = METRICS_FILE) {
  if (process.env.CODEFLOW_METRICS === "0") return;
  try {
    await mkdir(resolve(file, ".."), { recursive: true });
    if (((await stat(file).catch(() => undefined))?.size ?? 0) > LIMIT) await rename(file, `${file}.1`).catch(() => undefined);
    await appendFile(file, `${JSON.stringify(metric)}\n`, { mode: 0o600 });
  } catch { /* metrics never get in the way of a tool call */ }
}

const median = (values: number[]) => { if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]!; };
export async function readMetrics(file = METRICS_FILE): Promise<Metric[]> {
  const lines: string[] = [];
  for (const path of [`${file}.1`, file]) lines.push(...(await readFile(path, "utf8").catch(() => "")).split("\n"));
  return lines.flatMap(line => { try { const m = JSON.parse(line); return m && typeof m.tool === "string" && typeof m.at === "number" ? [m as Metric] : []; } catch { return []; } });
}

/** Per host: how many proposals were made, approved and finished, how long each step took, and which errors occurred. */
export function summarizeMetrics(metrics: Metric[]) {
  const hosts = new Map<string, Metric[]>();
  for (const m of metrics) { const key = m.host ?? "unknown"; hosts.set(key, [...(hosts.get(key) ?? []), m]); }
  return [...hosts].map(([host, rows]) => {
    const proposed = new Map<string, number>(), started = new Map<string, { at: number; proposalId?: string }>(), finished = new Map<string, number>(), errors: Record<string, number> = {};
    let declined = 0;
    for (const m of rows) {
      if (!m.ok && m.code) errors[m.code] = (errors[m.code] ?? 0) + 1;
      if (m.ok && m.proposalId && ["codeflow_run", "codeflow_propose_run"].includes(m.tool) && !proposed.has(m.proposalId)) proposed.set(m.proposalId, m.at);
      if (m.tool === "codeflow_start_run") {
        if (m.ok && m.runId && !started.has(m.runId)) started.set(m.runId, { at: m.at, proposalId: m.proposalId });
        else if (!m.ok && (m.code === "acceptance_declined" || m.code === "acceptance_cancelled")) declined++;
      }
      if (m.ok && m.runId && m.state === "finished" && !finished.has(m.runId)) finished.set(m.runId, m.at);
    }
    const approval = [...started.values()].flatMap(s => s.proposalId && proposed.has(s.proposalId) ? [(s.at - proposed.get(s.proposalId)!) / 1000] : []);
    const duration = [...finished].flatMap(([runId, at]) => started.has(runId) ? [(at - started.get(runId)!.at) / 1000] : []);
    return {
      host, versions: [...new Set(rows.map(m => m.hostVersion).filter(Boolean))], sessions: new Set(rows.map(m => m.session)).size, toolCalls: rows.length,
      proposals: proposed.size, started: started.size, declined, finished: finished.size,
      callsPerStartedTask: started.size ? Number((rows.length / started.size).toFixed(1)) : undefined,
      medianSecondsToApproval: median(approval), medianSecondsToResult: median(duration), errors,
    };
  });
}

export function formatMetrics(summary: ReturnType<typeof summarizeMetrics>): string {
  if (!summary.length) return "No CLI metrics recorded yet. They are written when a host calls a Code Flow tool.";
  return summary.map(h => [
    `${h.host}${h.versions.length ? ` (${h.versions.join(", ")})` : ""}: ${h.sessions} session${h.sessions === 1 ? "" : "s"}, ${h.toolCalls} tool calls`,
    `  Proposed ${h.proposals} · started ${h.started} · declined ${h.declined} · finished ${h.finished}`,
    h.callsPerStartedTask !== undefined ? `  Tool calls per started task: ${h.callsPerStartedTask}` : undefined,
    h.medianSecondsToApproval !== undefined ? `  Median time from proposal to start: ${Math.round(h.medianSecondsToApproval)} s` : undefined,
    h.medianSecondsToResult !== undefined ? `  Median time from start to result: ${Math.round(h.medianSecondsToResult)} s` : undefined,
    Object.keys(h.errors).length ? `  Errors: ${Object.entries(h.errors).map(([code, n]) => `${code} ×${n}`).join(", ")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n\n");
}
