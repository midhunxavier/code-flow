import { pollVisible } from "./polling.js";
import { useEffect, useState } from "preact/hooks";
import type { TeamEvaluation } from "../src/team-evaluation.js";
import { api, duration, fmtSize, pct, SHORT } from "./lib.js";
import type { AdapterTeamCapabilities } from "../src/adapters/team-tools.js";
import type { AgentId } from "./types.js";

/** "tested" → "Tested": capability states, shown in sentence case. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function TeamCapabilities({ providers }: { providers: AgentId[] }) {
  const [items, setItems] = useState<AdapterTeamCapabilities[] | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let active = true;
    setError("");
    api<AdapterTeamCapabilities[]>("/api/team-capabilities").then((result) => { if (active) setItems(result); }, (problem: Error) => { if (active) setError(problem.message); });
    return () => { active = false; };
  }, [opened]);
  return <details class="at-section" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Agent collaboration capabilities</summary>{error ? <p class="help">{error}</p> : !items ? <p class="help">Checking installed CLI capabilities…</p> : <><div class="table-wrap"><table class="ins-table"><thead><tr><th>Provider</th><th>Member tools</th><th>Live input</th><th>Native child controls</th><th>Child usage</th></tr></thead><tbody>{items.filter((item) => providers.includes(item.provider)).map((item) => <tr key={item.provider}><td>{SHORT[item.provider] ?? item.provider}<div class="help">{item.version ?? "Version unknown"}</div></td><td>{cap(item.scopedTools)}</td><td>{cap(item.liveInput)}</td><td>{cap(item.nestedAgentControl)}</td><td>{cap(item.nestedUsage)}</td></tr>)}</tbody></table></div><p class="help">Unsupported live tools use queued messages and structured outcomes. Protocol tests and installed CLI probes establish capability; separate child-agent usage is unknown.</p></>}</details>;
}

/** Runtime facts, not provider claims. Missing measurements remain visibly unknown. */
export function TeamRunMetrics({ runId, running }: { runId: string; running: boolean }) {
  const [report, setReport] = useState<TeamEvaluation | null>(null);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  // The report is built from the whole journal on each request: fetch it only while someone is looking.
  useEffect(() => {
    if (!opened) return;
    let active = true;
    const load = () => api<TeamEvaluation>(`/api/runs/${encodeURIComponent(runId)}/evaluation`).then((value) => { if (active) { setReport(value); setError(""); } }, (problem: Error) => { if (active) setError(problem.message); });
    const stop = pollVisible(load, running ? 5000 : 0);
    return () => { active = false; stop(); };
  }, [runId, running, opened]);
  return <details class="at-section" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Coordination and recovery measurements</summary>
    {error ? <p class="help">Measurements unavailable: {error}</p> : !report ? <p class="help">Loading measurements…</p> : <>
      <div class="at-metrics"><span>Coordinator calls: <b>{report.metrics.coordinatorFraction === null ? "unknown" : pct(report.metrics.coordinatorFraction, 1)}</b> of all invocations</span><span>Peer questions: <b>{report.metrics.peerQuestions}</b></span><span>Peer wait: <b>{report.metrics.peerWaitingMs === undefined ? "not measured" : duration(report.metrics.peerWaitingMs)}</b></span><span>Dispatch delay after an answer: <b>{report.metrics.avoidableBarrierEstimateMs === undefined ? "not measured" : duration(report.metrics.avoidableBarrierEstimateMs)}</b></span><span>Worker turns: <b>{report.metrics.workerTurns}</b></span><span>Repair turns: <b>{report.metrics.repairTurns}</b></span></div>
      {report.metrics.replay ? <p class="help">{report.metrics.replay.kind === "journal-load" ? "Journal load" : "Execution replay"}: {report.metrics.replay.durationMs.toFixed(1)} ms · {fmtSize(report.metrics.replay.bytes)} · {report.metrics.replay.records} records</p> : <p class="help">Recovery has not been measured for this run.</p>}
      <p class="help">Peer wait excludes questions to you. Dispatch delay is the time from an answer arriving to the next turn of its task, not a measured speedup.</p>
    </>}
  </details>;
}
