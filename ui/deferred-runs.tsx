import { pollVisible } from "./polling.js";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentId } from "../src/adapters/types.js";
import type { DeferredRunJob, DeferredRunStatus } from "../src/deferred-runs.js";
import { ApiError, post, showToast, showError } from "./lib.js";
import { readDeferredRuns } from "./deferred-queue.js";
import { confirmAction } from "./confirm-state.js";

const LABELS: Record<DeferredRunStatus, string> = { queued: "Queued", "waiting-time": "Waiting for start time", "waiting-provider": "Waiting for provider capacity", claimed: "Starting", started: "Run started", failed: "Start rejected", unknown: "Launch outcome unknown", cancelled: "Cancelled" };
const ACTIVE = new Set<DeferredRunStatus>(["queued", "waiting-time", "waiting-provider", "claimed", "unknown"]);
/** The same rules as src/deferred-runs.ts: a rejection with attempts left waits for your review; only finished records can be removed. */
const retryable = (job: DeferredRunJob) => job.status === "failed" && job.attempts < job.maxAttempts;
const finished = (job: DeferredRunJob) => job.status === "started" || job.status === "cancelled" || job.status === "failed" && !retryable(job);
const when = (at: number) => new Date(at).toLocaleString();
const localTime = (at: number) => { const date = new Date(at); return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const suggestedStart = () => localTime(Date.now() + 60 * 60_000);
/** The server refuses these too: the engine runs an AI team only inside a live Agent conversation. */
export const SCHEDULED_TEAM_NOTICE = "AI team works only in a live Agent conversation, so scheduled runs cannot use it. Turn AI team off to schedule this task with one agent, or choose Team — dynamic plan in Advanced to schedule a team.";
export const usesTaskTeam = (run: unknown) => (run as { taskTeam?: { enabled?: unknown } } | undefined)?.taskTeam?.enabled === true;

/** Explicitly save a launch configuration, or inspect durable queued launches in this scope. */
export function DeferredRunsPanel({ runRequest, project, repo, unassigned = false }: { runRequest?: unknown; project?: string; repo?: string; unassigned?: boolean }) {
  const [jobs, setJobs] = useState<DeferredRunJob[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [timing, setTiming] = useState("ready");
  const [notBefore, setNotBefore] = useState(suggestedStart);
  // An untouched suggestion follows the clock; a time you typed is kept exactly.
  const chosenStart = useRef(false);
  const [providers, setProviders] = useState<AgentId[]>([]);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const operation = useRef<{ key: string; id: string }>();
  const teamProblem = usesTaskTeam(runRequest) ? SCHEDULED_TEAM_NOTICE : "";
  const load = async (signal?: AbortSignal) => {
    const value = await readDeferredRuns({ signal });
    setJobs(value); setError(""); return value;
  };
  useEffect(() => {
    let alive = true, pending = false, first = true;
    const controller = new AbortController();
    const poll = async () => {
      if (pending) return; pending = true;
      // Opening the panel and Refresh queue always ask; later ticks stop once the queue is unavailable.
      const background = !first; first = false;
      try { const value = await readDeferredRuns({ signal: controller.signal, background }); if (alive) { setJobs(value); setError(""); } }
      catch (problem) { if (alive) setError((problem as Error).message); }
      finally { pending = false; }
    };
    const stop = pollVisible(poll, 5000);
    return () => { alive = false; controller.abort(); stop(); };
  }, [refresh]);
  const chooseTiming = (value: string) => { setTiming(value); if (value === "at" && !chosenStart.current) setNotBefore(suggestedStart()); };
  const enqueue = async () => {
    if (!runRequest || saving || teamProblem) return;
    const at = timing === "at" ? new Date(notBefore).getTime() : undefined;
    if (timing === "at" && !chosenStart.current && at! <= Date.now()) { setNotBefore(suggestedStart()); setSaveError("The suggested start time passed while this was open. It now suggests an hour from now; review it, then save again."); return; }
    if (timing === "at" && (!Number.isFinite(at) || at! <= Date.now())) { setSaveError("Choose a future local start time."); return; }
    const body = { name: name.trim() || undefined, run: runRequest, notBefore: at, waitForProviders: providers };
    const key = JSON.stringify(body);
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    setSaving(true); setSaveError("");
    try { await post("/api/deferred-runs", { ...body, operationId: operation.current.id }); operation.current = undefined; showToast("Deferred run saved. It starts when this application is open and its conditions are ready."); }
    catch (problem) { setSaveError((problem as Error).message); return; }
    finally { setSaving(false); }
    await load().catch((problem) => setError((problem as Error).message));
  };
  const scoped = jobs.filter((job) => (!project || job.run.project === project) && (!unassigned || !job.run.project) && (!repo || job.run.repo === repo));
  const clearable = scoped.filter(finished);
  const clear = async () => {
    if (!clearable.length || clearing) return;
    const count = `${clearable.length} finished deferred ${clearable.length === 1 ? "record" : "records"}`;
    if (!await confirmAction(`Remove ${count} from this list? Started runs stay in your runs.`, { title: "Clear finished deferred runs?", confirmLabel: "Remove records", danger: true })) return;
    setClearing(true);
    try { await post("/api/deferred-runs/remove", { jobs: clearable.map((job) => ({ id: job.id, expectedRevision: job.revision })) }); showToast(`Removed ${count}`); }
    catch (problem) { showError(problem instanceof ApiError && problem.status === 409 ? "A deferred job changed. Review the refreshed queue, then clear again." : (problem as Error).message, 5000); }
    finally { setClearing(false); }
    await load().catch((problem) => setError((problem as Error).message));
  };
  return <section class="section deferred-runs" aria-label="Deferred runs">
    <div class="section-title">Deferred runs <span class="count">{scoped.filter((job) => ACTIVE.has(job.status) || retryable(job)).length}</span></div>
    <p class="help">Save a run for later, or wait for provider capacity. The queue survives restarts and runs while this application is open. Provider reset times come from reported usage; unknown reset times are rechecked.</p>
    {runRequest ? <details><summary>Queue this run configuration</summary>
      {teamProblem ? <p class="msg warn" role="status">{teamProblem}</p> : null}
      <p class="help">Deferred runs use Safe mode, suppress copied ignored files and disable approval waits. Files and source references are revalidated when launching; attachments cannot be deferred.</p>
      <p class="help">Task and command text is saved locally with this request. Reference environment variable names for credentials instead of putting their values in commands.</p>
      <div class="wb-fields"><label>Queue label (optional)<input class="field" maxLength={120} aria-label="Deferred run label" value={name} onInput={(event) => setName(event.currentTarget.value)} /></label>
      <label>Start condition<select class="field" aria-label="Deferred start condition" value={timing} onChange={(event) => chooseTiming(event.currentTarget.value)}><option value="ready">As soon as conditions are ready</option><option value="at">At or after a chosen time</option></select></label>
      {timing === "at" ? <label>Earliest start · local time<input class="field" type="datetime-local" aria-label="Deferred earliest start" min={localTime(Date.now())} value={notBefore} onInput={(event) => { chosenStart.current = true; setNotBefore(event.currentTarget.value); }} /></label> : null}</div>
      <fieldset class="deferred-providers"><legend>Wait for selected providers to have capacity</legend>{(["claude", "codex", "agy"] as AgentId[]).map((provider) => <label key={provider}><input type="checkbox" checked={providers.includes(provider)} onChange={(event) => setProviders((previous) => event.currentTarget.checked ? [...previous, provider] : previous.filter((value) => value !== provider))} /> {provider === "agy" ? "Antigravity" : provider === "claude" ? "Claude" : "Codex"}</label>)}</fieldset>
      <details><summary>Review saved run request</summary><pre>{JSON.stringify(runRequest, null, 2)}</pre></details>
      <div class="wb-actions"><button class="btn primary" disabled={saving || !!teamProblem} title={teamProblem || undefined} onClick={enqueue}>{saving ? "Saving…" : "Save deferred run"}</button></div>
      {saveError && saveError !== error ? <p class="msg err" role="alert">{saveError}</p> : null}
    </details> : null}
    <div class="wb-actions"><button class="btn small" onClick={() => setRefresh((value) => value + 1)}>Refresh queue</button>{clearable.length ? <button class="btn small" disabled={clearing} onClick={() => void clear()}>{clearing ? "Clearing…" : `Clear finished (${clearable.length})`}</button> : null}</div>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {scoped.length ? <div class="wb-list">{scoped.map((job) => <DeferredRunCard key={job.id} job={job} refresh={load} />)}</div> : <p class="help">No deferred runs in this scope.</p>}
  </section>;
}

function DeferredRunCard({ job, refresh }: { job: DeferredRunJob; refresh: () => Promise<DeferredRunJob[]> }) {
  const [busy, setBusy] = useState(false);
  // A failure belongs to the revision it was about; once the job moves on it no longer applies.
  const [error, setError] = useState<{ message: string; revision: number }>();
  const [runId, setRunId] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setError(undefined);
    try { await post(path, body); await refresh(); }
    catch (problem) {
      setError({ message: (problem as Error).message, revision: job.revision });
      if (problem instanceof ApiError && problem.status === 409) {
        // Show where the job is now instead of waiting for the next poll.
        const latest = (await refresh().catch(() => [])).find((item) => item.id === job.id);
        if (latest && latest.revision !== job.revision) showToast(`This deferred job changed elsewhere and is now: ${LABELS[latest.status]}.`, 5000);
      }
    }
    finally { setBusy(false); }
  };
  const command = (action: "cancel" | "retry" | "attach", fields = {}) => act(`/api/deferred-runs/${encodeURIComponent(job.id)}/${action}`, { expectedRevision: job.revision, ...fields });
  return <article class="wb-item deferred-run" aria-label={`Deferred run ${job.name}`}>
    <div class="wb-item-head"><b>{job.name}</b><span class={`badge ${job.status === "started" ? "ok" : job.status === "failed" ? "err" : job.status === "unknown" || job.status === "waiting-provider" ? "warn" : job.status === "claimed" ? "run" : ""}`}>{LABELS[job.status]}</span></div>
    <p class="help">{job.run.pattern} · {job.run.repo} · earliest {when(job.notBefore)} · launch attempts {job.attempts}/{job.maxAttempts}</p>
    {job.waitForProviders.length ? <p class="help">Provider conditions: {job.waitForProviders.join(", ")}{job.nextCheckAt ? ` · check again at ${when(job.nextCheckAt)}` : ""}</p> : null}
    {job.reason ? <p class="help">{job.reason}</p> : null}
    <div class="wb-actions">
    {job.runId ? <a class="btn small" href={`#/run/${encodeURIComponent(job.runId)}`}>Open run {job.runId}</a> : null}
    {ACTIVE.has(job.status) || retryable(job) ? <button class="btn small" disabled={busy} onClick={() => command("cancel")}>{job.status === "unknown" ? "Cancel queue recovery" : job.status === "claimed" ? "Request launch cancellation" : "Cancel deferred run"}</button> : null}
    {retryable(job) ? <button class="btn small" disabled={busy} onClick={() => command("retry")}>Retry after reviewing the failure</button> : null}
    {finished(job) ? <button class="btn small" disabled={busy} onClick={() => act("/api/deferred-runs/remove", { jobs: [{ id: job.id, expectedRevision: job.revision }] })}>Remove record</button> : null}
    </div>
    {job.status === "unknown" ? <div class="deferred-recovery" aria-label="Recover unknown deferred launch">
      <p class="help">A run may have started before its receipt was saved. Inspect existing runs and the claim below before linking one or retrying. Cancelling queue recovery does not stop an unknown existing run.</p>
      <p class="help">Job <code>{job.id}</code> · launch claim <code>{job.claimId}</code></p>
      <div class="wb-row"><label>Existing run ID<input class="field" aria-label={`Existing run for ${job.id}`} maxLength={240} value={runId} onInput={(event) => setRunId(event.currentTarget.value)} /></label><button class="btn small" disabled={busy || !runId.trim()} onClick={() => command("attach", { runId: runId.trim() })}>Link matching existing run</button></div>
      {job.attempts < job.maxAttempts ? <div class="wb-row"><label><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.currentTarget.checked)} /> I inspected existing runs and understand that another attempt can duplicate work.</label><button class="btn small" disabled={busy || !acknowledge} onClick={() => command("retry", { acknowledgeUnknown: true })}>Retry unknown launch</button></div> : null}
    </div> : null}
    <details><summary>Saved request and launch history</summary><pre>{JSON.stringify(job.run, null, 2)}</pre><ol class="help">{job.history.map((event) => <li key={event.id}>{when(event.at)} · {LABELS[event.status]} · {event.detail}{event.claimId ? <> · claim <code>{event.claimId}</code></> : null}{event.runId ? <> · <a href={`#/run/${encodeURIComponent(event.runId)}`}>{event.runId}</a></> : null}</li>)}</ol></details>
    {error?.revision === job.revision ? <p class="msg err" role="alert">{error.message}</p> : null}
  </article>;
}
