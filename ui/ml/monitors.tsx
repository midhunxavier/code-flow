import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc } from "../lib.js";
import type { Deployment } from "../../src/ml/deployment-model.js";
import { actionTerminal, type ModelMonitor } from "../../src/ml/monitor-model.js";
import type { RegisteredModel } from "../../src/ml/registry-model.js";
import type { TrainingSchedule } from "../../src/ml/schedule-model.js";
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export function MonitorPanel({ enabled, monitors, deployments, models, schedules, refresh }: { enabled: boolean; monitors: ModelMonitor[]; deployments: Deployment[]; models: RegisteredModel[]; schedules: TrainingSchedule[]; refresh: () => Promise<void> }) {
  const [deployment, setDeployment] = useState(""), [name, setName] = useState(""), [rollback, setRollback] = useState(""), [scheduleId, setSchedule] = useState(""), [downtime, setDowntime] = useState(false), [approved, setApproved] = useState(false);
  const [minutes, setMinutes] = useState(5), [requests, setRequests] = useState(20), [samples, setSamples] = useState(100), [windows, setWindows] = useState(2), [errors, setErrors] = useState(10), [latency, setLatency] = useState(30), [drift, setDrift] = useState(0.3), [cooldown, setCooldown] = useState(60), [actions, setActions] = useState(3);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const mounted = useRef(true), operation = useRef({ key: "", id: crypto.randomUUID() }); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choices = deployments.filter(d => d.enabled), d = choices.find(d => d.id === deployment) ?? choices[0], release = d?.releases.find(r => r.id === d.current), model = models.find(m => m.id === d?.modelId);
  const training = schedules.filter(s => s.state === "paused" && s.template.project === d?.project && s.template.repo === d?.repo && (s.template.intent.recipe ?? "tabular-autogluon-v1") === release?.recipe), schedule = training.find(s => s.id === scheduleId);
  const features = release?.base ? ["promptCharacters", "inputTokens", "outputTokens", "emptyOutput"] : release?.features.slice(0, 16) ?? [];
  const sameWorker = !!schedule && schedule.template.target.workerId === d?.target.workerId;
  async function act(label: string, work: () => Promise<unknown>, success: string) {
    if (busy) return; setBusy(label); setError(""); setMessage("");
    try { await work(); if (mounted.current) { await refresh(); setMessage(success); } } catch (e) { if (mounted.current) setError((e as Error).message); } finally { if (mounted.current) setBusy(""); }
  }
  const change = (m: ModelMonitor, action: "pause" | "resume" | "check" | "reference", stopActive = false, keepServingStopped = false) => void act("Updating monitor", () => post(`/api/ml/monitors/${enc(m.id)}/${action}`, { revision: m.revision, ...(action === "pause" ? { stopActive, keepServingStopped } : {}) }), action === "reference" ? "Reference captured from the reviewed traffic window." : "Monitor updated.");
  return <section class="pp-card" aria-label="Model monitoring"><h3>Monitor models and respond to drift</h3>
    <p>Track completed requests, failures, mean latency and changes in input distributions on local or SSH deployments. Code Flow retains aggregate counts, without saving prompts, rows, category values or generated text.</p>
    <p>Collect representative traffic and capture a reference for drift checks. Drift is a distribution warning, not evidence of accuracy loss. LLM checks measure text length and token counts; they do not assess meaning or answer quality.</p>
    {error ? <p role="alert">{error}</p> : null}{busy || message ? <p role="status">{busy ? `${busy}…` : message}</p> : null}
    {!choices.length ? <p>Enable a model deployment above before creating a monitor.</p> : <details open={!monitors.length}><summary>Create a monitor</summary><form onSubmit={event => {
      event.preventDefault(); if (!d) return;
      const body = { deploymentId: d.id, revision: d.revision, name: name.trim() || `${d.name} monitoring`, features, limits: { windowSeconds: minutes * 60, minRequests: requests, minSamples: samples, consecutiveWindows: windows, maxErrorRate: errors / 100, maxLatencyMs: latency * 1000, driftThreshold: drift, cooldownSeconds: cooldown * 60, maxActions: actions }, ...(rollback ? { rollbackVersionId: rollback } : {}), ...(schedule ? { retrain: { scheduleId: schedule.id, scheduleRevision: schedule.revision, allowServingPause: downtime } } : {}) };
      const key = JSON.stringify(body); if (key !== operation.current.key) operation.current = { key, id: crypto.randomUUID() };
      void act("Saving monitoring policy", () => post("/api/ml/monitors", { ...body, operationId: operation.current.id }), "Monitor enabled. Capture a representative traffic reference to begin drift checks.");
    }}>
      <div class="ml-grid">
        <label>Deployment to monitor<select value={d?.id} disabled={!enabled || !!busy} onChange={e => { setDeployment(e.currentTarget.value); setRollback(""); setSchedule(""); setApproved(false); setDowntime(false); }}>{choices.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label>
        <label>Monitor name<input value={name} maxLength={100} disabled={!enabled || !!busy} placeholder={`${d?.name} monitoring`} onInput={e => setName(e.currentTarget.value)} /></label>
        <label>Monitoring window (minutes)<input type="number" min="1" max="1440" value={minutes} onInput={e => setMinutes(Number(e.currentTarget.value))} /></label>
        <label>Minimum requests per window<input type="number" min="10" max="100000" value={requests} onInput={e => setRequests(Number(e.currentTarget.value))} /></label>
        <label>Minimum drift samples<input type="number" min="20" max="100000" value={samples} onInput={e => setSamples(Number(e.currentTarget.value))} /></label>
        <label>Consecutive failing windows<input type="number" min="2" max="10" value={windows} onInput={e => setWindows(Number(e.currentTarget.value))} /></label>
        <label>Failure threshold (%)<input type="number" min="0.1" max="100" step="0.1" value={errors} onInput={e => setErrors(Number(e.currentTarget.value))} /></label>
        <label>Mean latency threshold (seconds)<input type="number" min="0.01" max="180" step="0.01" value={latency} onInput={e => setLatency(Number(e.currentTarget.value))} /></label>
        <label>Drift distance threshold (0–1)<input type="number" min="0.01" max="1" step="0.01" value={drift} onInput={e => setDrift(Number(e.currentTarget.value))} /></label>
        <label>Action cooldown (minutes)<input type="number" min="1" max="10080" value={cooldown} onInput={e => setCooldown(Number(e.currentTarget.value))} /></label>
        <label>Lifetime automated actions<input type="number" min="1" max="20" value={actions} onInput={e => setActions(Number(e.currentTarget.value))} /></label>
      </div>
      <p>Monitored fields: {features.join(", ")}. Numeric values use coarse bins; categorical values use private hashed buckets. Distances compare these distributions with your captured reference.</p>
      <div class="ml-grid"><label>When inference is unhealthy<select value={rollback} disabled={!enabled || !!busy} onChange={e => { setRollback(e.currentTarget.value); setApproved(false); }}><option value="">Report only</option>{model?.versions.filter(v => v.id !== release?.versionId && d?.history.some(h => d.releases.find(r => r.id === h.to)?.versionId === v.id)).map(v => <option value={v.id} key={v.id}>Roll back to approved v{v.number}</option>)}</select></label>
        <label>When input drift persists<select value={scheduleId} disabled={!enabled || !!busy} onChange={e => { setSchedule(e.currentTarget.value); setApproved(false); setDowntime(false); }}><option value="">Report only</option>{training.map(s => <option key={s.id} value={s.id}>{s.name} · {s.template.target.name} · {s.maxCycles - s.runs.length} runs left</option>)}</select></label></div>
      <p>For automatic retraining, save and pause a retraining schedule above, then select it here. A new stable data version is required. Monitoring consumes that schedule's existing lifetime run budget; each search keeps its original iteration, training and elapsed limits.</p>
      {schedule ? <p>Retraining uses {schedule.planner.kind === "claude" ? `Claude (${schedule.planner.model})` : "built-in search"}: at most {schedule.limits.iterations} iterations, {schedule.limits.trainSeconds / 60} training minutes and {schedule.limits.elapsedSeconds / 60} elapsed minutes per run. New models remain available for review; monitoring does not promote them automatically.</p> : null}
      {sameWorker ? <label class="ml-check"><input type="checkbox" checked={downtime} onChange={e => setDowntime(e.currentTarget.checked)} />Allow serving to stop during retraining on this computer and restore its original release afterward.</label> : null}
      {rollback || schedule ? <label class="ml-check"><input type="checkbox" checked={approved} onChange={e => setApproved(e.currentTarget.checked)} />I authorize the selected automatic actions within these thresholds and limits.</label> : null}
      <button class="btn primary" disabled={!enabled || !!busy || !!(rollback || schedule) && !approved || sameWorker && !downtime}>Create monitor</button>
    </form></details>}
    {monitors.map(m => {
      const latest = m.reports.at(-1), active = m.actions.find(a => !actionTerminal(a)), enough = m.window.requests >= m.limits.minRequests && m.window.samples >= m.limits.minSamples || !!m.candidate;
      return <article class="ml-detail" key={m.id} aria-label={`${m.name} monitor`}><h4>{m.name} · {m.state}</h4>
        <p>Deployment revision {m.deploymentRevision} · {m.target.name} · {m.limits.windowSeconds / 60}-minute windows · {m.actions.length} / {m.limits.maxActions} automated actions</p>
        <p role="status">{m.reason ?? (active ? active.outcome ?? `Monitoring action: ${active.state}` : "Collecting traffic and checking thresholds")}</p>
        <p>Current window: {m.window.requests} requests, {m.window.failures} failures, {m.window.samples} drift samples. Reference: {m.reference ? `${m.reference.samples} samples from ${new Date(m.reference.start).toLocaleString()}` : "not captured"}.</p>
        {latest ? <p>Latest completed window: {(latest.errorRate * 100).toFixed(1)}% failures · {(latest.meanLatencyMs / 1000).toFixed(2)}s mean latency · {latest.drift === undefined ? "drift needs enough traffic and a reference" : `drift distance ${latest.drift.toFixed(3)}`}. {latest.shifted.length ? `Shifted fields: ${latest.shifted.join(", ")}.` : ""}</p> : null}
        <p>Confirmation: {m.healthStreak} unhealthy / {m.driftStreak} drift windows; {m.limits.consecutiveWindows} required. Cooldown {m.limits.cooldownSeconds / 60} minutes. Low traffic and monitoring gaps reset confirmation.</p>
        <div class="ml-actions">{m.state === "enabled" ? <><button class="btn" disabled={!!busy} onClick={() => change(m, "pause")}>Pause monitor</button><button class="btn" disabled={!enabled || !!busy} onClick={() => change(m, "check")}>Check monitor now</button><button class="btn" disabled={!enabled || !!busy || !!active || !enough} onClick={() => change(m, "reference")}>{m.reference ? "Replace reference with reviewed traffic" : "Capture reviewed traffic reference"}</button></> : <button class="btn" disabled={!enabled || !!busy || !!active} onClick={() => change(m, "resume")}>Resume monitor</button>}{active?.cycleId ? <button class="btn" disabled={!!busy} onClick={() => change(m, "pause", true)}>Pause and stop retraining</button> : null}{active?.stoppedRevision ? <button class="btn" disabled={!!busy} onClick={() => change(m, "pause", true, true)}>Stop retraining and keep serving stopped</button> : null}</div>
        {active ? <p>Pausing stops new actions. An admitted search continues within its limits unless stopped explicitly. Serving paused by this monitor is restored when that search finishes, provided the deployment has not changed manually.</p> : null}
        {m.reports.length ? <details><summary>Recent monitoring windows ({m.reports.length})</summary><div class="ml-table-scroll"><table><caption>Observed traffic and threshold checks</caption><thead><tr><th>Window ended</th><th>Requests</th><th>Failures</th><th>Mean latency</th><th>Drift distance</th><th>Signal</th></tr></thead><tbody>{m.reports.slice().reverse().map(r => <tr key={r.start}><td>{new Date(r.end).toLocaleString()}</td><td>{r.requests}</td><td>{(r.errorRate * 100).toFixed(1)}%</td><td>{(r.meanLatencyMs / 1000).toFixed(2)}s</td><td>{r.drift?.toFixed(3) ?? "Insufficient evidence"}</td><td>{!r.sufficient ? "Low traffic" : r.health ? "Unhealthy" : r.dataDrift ? "Drift" : "Within limits"}</td></tr>)}</tbody></table></div></details> : null}
        {m.actions.length ? <details><summary>Monitoring action history ({m.actions.length})</summary><ol>{m.actions.slice().reverse().map(a => <li key={a.id}>{new Date(a.at).toLocaleString()} · {a.kind} · {a.state}: {a.outcome ?? "Checking policy and resources"}{a.cycleId ? <> · <a href={`#ml-cycle-${a.cycleId}`}>Inspect bounded search</a></> : null}</li>)}</ol></details> : null}
      </article>;
    })}
  </section>;
}
