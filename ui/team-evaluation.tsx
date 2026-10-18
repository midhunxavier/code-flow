import { useEffect, useState } from "preact/hooks";
import type { RolloutAssessment, RolloutStage, TeamEvaluation, TeamRollout } from "../src/team-evaluation.js";
import { api, duration, fmtSize, pct, post, SHORT } from "./lib.js";
import { loadTeamRollout, teamRollout } from "./state.js";
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

export function TeamRolloutNotice() {
  const rollout = teamRollout.value;
  if (!rollout) return null;
  return <section class="at-notice" aria-label="Auto team availability"><b>Auto team · {rollout.enabled ? rollout.stage === "beta" ? "opt-in beta" : rollout.stage : "new runs disabled"}</b><p>{rollout.reason}</p><a href="#/insights">View evaluation evidence</a></section>;
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
    void load(); const timer = running ? setInterval(load, 5000) : undefined;
    return () => { active = false; clearInterval(timer); };
  }, [runId, running, opened]);
  return <details class="at-section" onToggle={(event) => setOpened(event.currentTarget.open)}><summary>Coordination and recovery measurements</summary>
    {error ? <p class="help">Measurements unavailable: {error}</p> : !report ? <p class="help">Loading measurements…</p> : <>
      <div class="at-metrics"><span>Coordinator calls: <b>{report.metrics.coordinatorFraction === null ? "unknown" : pct(report.metrics.coordinatorFraction, 1)}</b> of all invocations</span><span>Peer questions: <b>{report.metrics.peerQuestions}</b></span><span>Peer wait: <b>{report.metrics.peerWaitingMs === undefined ? "not measured" : duration(report.metrics.peerWaitingMs)}</b></span><span>Dispatch delay after an answer: <b>{report.metrics.avoidableBarrierEstimateMs === undefined ? "not measured" : duration(report.metrics.avoidableBarrierEstimateMs)}</b></span><span>Worker turns: <b>{report.metrics.workerTurns}</b></span><span>Repair turns: <b>{report.metrics.repairTurns}</b></span></div>
      {report.metrics.replay ? <p class="help">{report.metrics.replay.kind === "journal-load" ? "Journal load" : "Execution replay"}: {report.metrics.replay.durationMs.toFixed(1)} ms · {fmtSize(report.metrics.replay.bytes)} · {report.metrics.replay.records} records</p> : <p class="help">Recovery has not been measured for this run.</p>}
      <p class="help">Peer wait excludes questions to you. Dispatch delay is the time from an answer arriving to the next turn of its task, not a measured speedup. {report.mode === "unknown" ? "This run has not been registered as a controlled evaluation." : `Evaluation source: ${report.mode}.`}</p>
    </>}
  </details>;
}

interface EvaluationsResponse { reports: TeamEvaluation[]; assessment: RolloutAssessment; rollout: TeamRollout }

export function TeamEvaluations() {
  const [data, setData] = useState<EvaluationsResponse | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [stage, setStage] = useState<RolloutStage>("experimental");
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const load = async () => { try { setData(await api<EvaluationsResponse>("/api/team-evaluations")); setError(""); } catch (problem) { setError((problem as Error).message); } };
  useEffect(() => { void load(); }, []);
  const decide = async () => {
    if (!rationale.trim() || saving) return;
    setSaving(true);
    try { await post("/api/team-rollout", { stage, rationale, evaluationIds: [...chosen] }); await Promise.all([load(), loadTeamRollout()]); setRationale(""); }
    catch (problem) { setError((problem as Error).message); }
    finally { setSaving(false); }
  };
  return <section class="ins-section" aria-label="Team evaluations"><h2>Auto team evaluation</h2><p class="help">Controlled local comparisons use the same task and starting commit. Fake trials verify behavior; only explicitly recorded real CLI trials inform rollout. These records cover this installation, across projects.</p>
    <TeamRolloutNotice />
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <button class="btn small" onClick={load}>Refresh evaluations</button>
    {data ? <><div class="at-metrics"><span><b>{data.assessment.realAutoRuns}</b> real Auto runs</span><span><b>{data.assessment.realWorkerTurns}</b> real worker turns</span><span><b>{data.assessment.matchedPairs}</b> matched comparisons</span><span>Multi-worker coordination: <b>{data.assessment.overheadFraction === null ? "unknown" : pct(data.assessment.overheadFraction, 1)}</b></span></div>
      {data.reports.length ? <div class="table-wrap"><table class="ins-table"><thead><tr><th>Evidence</th><th>Trial</th><th>Pattern</th><th>Verified</th><th class="num">Calls</th><th class="num">Coordinator</th><th class="num">Peer wait</th></tr></thead><tbody>{data.reports.map((report) => <tr key={report.id}><td><input type="checkbox" aria-label={`Use evaluation ${report.id}`} checked={chosen.has(report.id)} onChange={(event) => setChosen((before) => { const next = new Set(before); if (event.currentTarget.checked) next.add(report.id); else next.delete(report.id); return next; })} /><span class={`badge ${report.mode === "real" ? "" : "warn"}`}>{report.mode.charAt(0).toUpperCase() + report.mode.slice(1)}</span></td><td><b>{report.caseId}</b><div class="help">{report.pairId ?? "unpaired"} · {report.runId}</div></td><td>{report.pattern}</td><td>{report.verified ? "Yes" : "No"}</td><td class="num">{report.metrics.invocations}</td><td class="num">{report.metrics.coordinatorFraction === null ? "unknown" : pct(report.metrics.coordinatorFraction, 1)}</td><td class="num">{report.metrics.peerWaitingMs === undefined ? "unknown" : duration(report.metrics.peerWaitingMs)}</td></tr>)}</tbody></table></div> : <p class="help">No controlled trials recorded. Use <code>npm run evaluate:teams -- --fake</code> to validate the harness, or <code>--real</code> for bounded trials with your signed-in CLIs.</p>}
      <details><summary>Rollout decision and requirements</summary><p class="help">An explicit decision is required. The server checks selected real evidence before allowing beta or default. Missing results and unverified outcomes cannot become passes.</p>
        {data.assessment.blockers.length ? <ul>{data.assessment.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p>Recorded evidence meets the default criteria.</p>}
        <label>Requested stage<select class="field" aria-label="Auto team rollout stage" value={stage} onChange={(event) => setStage(event.currentTarget.value as RolloutStage)}><option value="experimental">Experimental</option><option value="beta">Opt-in beta</option><option value="default">Default for new users</option></select></label>
        <label>Decision rationale<textarea class="field" aria-label="Rollout rationale" rows={3} maxLength={4000} value={rationale} onInput={(event) => setRationale(event.currentTarget.value)} /></label><button class="btn small" disabled={saving || !rationale.trim()} onClick={decide}>{saving ? "Recording…" : "Record rollout decision"}</button>
        {data.rollout.decision ? <p class="help">Last decision: {new Date(data.rollout.decision.at).toLocaleString()} · {data.rollout.decision.rationale}</p> : null}
      </details>
    </> : null}
  </section>;
}
