import { MAX_EXECUTION_BUDGET } from "../src/execution-budget.js";
import { describeGithubRunEvents } from "../src/github-webhook-events.js";
import { runTitle } from "../src/run-title.js";
import { confirmAction } from "./confirm-state.js";
import { checksLabel } from "../src/run-status.js";
import { pollVisible } from "./polling.js";
import { ProjectTeamsInbox } from "./project-teams.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, CantRunNote } from "./bits.js";
import { Icon } from "./icons.js";
import { ago, api, ApiError, sharedGet, baseName, copy, post, showToast, showError, STATUS_TEXT } from "./lib.js";
import { activeProject, projectCounts, filterActive, setRunFilter, historyNextCursor, historyLoadingMore, loadOlderRuns, ALL, currentProject, inScope, NONE, patterns, projectFor, projects, route, runs, runState, selectProject } from "./state.js";
import type { Project, RunSummary } from "./types.js";
import { ProjectButton } from "./projects.js";
import { SCHEDULED_TEAM_NOTICE, usesTaskTeam } from "./deferred-runs.js";
import { teamAwaitingAnswer } from "./team-state.js";
import { prioritizedReviewRuns, groupReviewRuns, reviewReason, REVIEW_REASON_LABELS, type ReviewReason } from "../src/review-inbox.js";
import type { AutomationEvent, AutomationPreview } from "../src/automation.js";
import { MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, type Schedule } from "../src/schedule-rules.js";
import { draftProblem, draftSchedule, formatNextRun, localTimezone, sameSchedule, scheduleDraft, type ScheduleDraft } from "./schedule-draft.js";

export { automations, loadAutomations, automationProject, type Automation } from "./automation-state.js";
import { automations, loadAutomations, automationProject, automationStorage, automationLoadError, type Automation } from "./automation-state.js";
const automationInScope = (a: Automation, scope = currentProject.value) => {
  if (scope === ALL) return true;
  const project = automationProject(a.run);
  return scope === NONE ? !project : project?.id === scope;
};

/** Automation results waiting for your decision. */
export const inbox = () => prioritizedReviewRuns([...runs.value.values()]);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The next five times, from the server. `problem`: the schedule can't be saved (checked here
 * first), so only that is shown. Times for an earlier schedule are never shown for this one.
 */
export function SchedulePreview({ schedule, problem }: { schedule?: Schedule; problem?: string }) {
  const key = JSON.stringify(schedule);
  const [result, setResult] = useState<{ key: string; times: number[]; timezone?: string; error: string }>();
  useEffect(() => {
    let alive = true;
    if (!schedule || problem) return;
    const timer = setTimeout(() => void post<{ times: number[]; timezone?: string }>("/api/automations/schedule-preview", { schedule, after: Date.now(), count: 5 }).then((value) => { if (alive) setResult({ key, times: value.times, timezone: value.timezone, error: "" }); }, (err) => { if (alive) setResult({ key, times: [], error: err.message }); }), 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, problem]);
  const current = result?.key === key ? result : undefined;
  const error = problem || current?.error;
  const daily = schedule && "at" in schedule ? schedule : undefined;
  // A time of day saved without a zone runs in the server's local time: shown in that zone.
  const timezone = daily ? daily.timezone ?? current?.timezone : undefined;
  const where = !daily || error ? "" : daily.timezone ? ` in ${daily.timezone}` : ` in server local time${current?.timezone ? ` (${current.timezone})` : ""}`;
  const format = (at: number) => { try { return new Date(at).toLocaleString([], { timeZone: timezone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }); } catch { return new Date(at).toLocaleString(); } };
  return <div role="group" aria-label="Next scheduled times"><p class="help">Next runs{where}:</p>
    {!schedule ? <p class="help">No schedule</p> : error ? null : current ? <ol class="help">{current.times.map((at) => <li key={at}>{format(at)}</li>)}</ol> : <p class="help">Calculating…</p>}
    {current && !error && daily?.timezone ? <p class="help">Runs once per local day. A skipped daylight-saving time moves forward; a repeated time uses its first occurrence.</p> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}</div>;
}

/**
 * Edit a schedule. On its own (`save`), it saves with its own button, sending the revision it
 * started from; a window that saved first wins, and this one keeps its edit and says so. In a
 * bigger form (`onChange`), every change goes to the form, which saves it.
 *
 * It shows the saved schedule as it changes (from this window or the poll) until you edit it.
 */
export function ScheduleEditor({ automation: a, save, onChange, zoneRequired = false, allowOff = true }: {
  automation: { name: string; schedule?: Schedule; revision?: number };
  /** Resolves once saved; rejects (409: changed elsewhere) when it wasn't. */
  save?: (patch: { schedule: Schedule | null; revision?: number }) => unknown;
  onChange?: (schedule: Schedule) => void;
  zoneRequired?: boolean;
  allowOff?: boolean;
}) {
  const incoming = JSON.stringify(a.schedule ?? null);
  const [draft, setDraft] = useState(() => scheduleDraft(a.schedule));
  // The saved schedule this edit started from, and its revision.
  const [base, setBase] = useState({ json: incoming, revision: a.revision });
  const [conflict, setConflict] = useState(false);
  // The server refused the last save (409) and what's saved now hasn't loaded yet.
  const [refused, setRefused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const schedule = draftSchedule(draft);
  const problem = draft.mode === "off" && !allowOff ? "Enable a webhook before removing the schedule." : draftProblem(draft, zoneRequired);
  const dirty = !sameSchedule(schedule, JSON.parse(base.json) ?? undefined);
  const reseed = () => { setDraft(scheduleDraft(a.schedule)); setBase({ json: incoming, revision: a.revision }); setConflict(false); setRefused(false); setError(""); };
  useEffect(() => {
    if (incoming === base.json) {
      if (a.revision === base.revision) return;
      setBase({ json: incoming, revision: a.revision });
      // Refused only because something else changed (it was switched off, say): the schedule is
      // still the one this edit started from, so nothing is lost by saving it now.
      if (refused) { setRefused(false); setConflict(false); void submit(a.revision); }
      return;
    }
    setRefused(false);
    if (onChange) setBase({ json: incoming, revision: a.revision });
    // Untouched, or this edit is what was saved: show what's stored now (its zone's current name too).
    else if (!dirty || sameSchedule(schedule, a.schedule)) reseed();
    else setConflict(true);
  }, [incoming, a.revision]);
  const change = (patch: Partial<ScheduleDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next); setError("");
    const value = draftSchedule(next);
    if (onChange && value) onChange(value);
  };
  const submit = async (revision = base.revision) => {
    if (!save) return;
    setSaving(true); setError("");
    try { await save({ schedule: schedule ?? null, ...(revision !== undefined ? { revision } : {}) }); }
    catch (err) { if (err instanceof ApiError && err.status === 409) { setConflict(true); setRefused(true); } else setError((err as Error).message); }
    finally { setSaving(false); }
  };
  const zone = localTimezone();
  return <details><summary>Schedule and next times</summary>
    <label>Schedule<select class="field" aria-label={`Schedule for ${a.name}`} value={draft.mode} onChange={(event) => change({ mode: event.currentTarget.value as ScheduleDraft["mode"] })}>{onChange ? null : <option value="off" disabled={!allowOff}>Only when triggered</option>}<option value="daily">At a time</option><option value="every">Every N minutes</option></select></label>
    {draft.mode === "daily" ? <><label>Time<input class="field" type="time" value={draft.at} onInput={(event) => change({ at: event.currentTarget.value })} /></label><label>Time zone<input class="field" placeholder={zoneRequired ? "Europe/Stockholm" : "Server local time"} value={draft.timezone} onInput={(event) => change({ timezone: event.currentTarget.value })} /></label>
      {!zoneRequired && !draft.timezone.trim() ? <p class="help">Empty: it runs in the server's local time. <button type="button" class="linkish" onClick={() => change({ timezone: zone })}>Use my time zone ({zone})</button></p> : null}</>
      : draft.mode === "every" ? <label>Minutes<input class="field" type="number" min={MIN_EVERY_MINUTES} max={MAX_EVERY_MINUTES} step={1} value={draft.every} onInput={(event) => change({ every: event.currentTarget.value })} /></label> : null}
    {draft.mode === "daily" && <fieldset><legend>Days</legend>{DAYS.map((day, index) => <label key={day}><input type="checkbox" checked={draft.days.includes(index)} onChange={(event) => change({ days: event.currentTarget.checked ? [...draft.days, index].sort() : draft.days.filter((d) => d !== index) })} /> {day}</label>)}</fieldset>}
    <SchedulePreview schedule={schedule} problem={problem} />
    {conflict ? <div class="msg warn schedule-conflict" role="alert">This schedule was changed in another window. Your edit is still here and hasn't been saved. <button type="button" class="btn small" onClick={reseed}>Use saved schedule</button> <button type="button" class="btn small" disabled={saving || !!problem} onClick={() => void submit(a.revision)}>Save mine over it</button></div>
      : save ? <button type="button" class="btn small" disabled={saving || !!problem || !dirty} onClick={() => void submit()}>{saving ? "Saving…" : "Save schedule"}</button> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </details>;
}

// ---------------------------------------------------------------- page
export function AutomationsView({ mode = "all", category, projectId, showScope = true }: { mode?: "all" | "inbox" | "automations"; category?: "repeat" | "backlog"; projectId?: string; showScope?: boolean }) {
  useEffect(() => {
    return pollVisible(loadAutomations, 15_000);
  }, []);
  // The project you're in, as in the sidebar; what's in other projects is a count and a link away.
  const scope = projectId ?? currentProject.value;
  const scoped = scope !== ALL;
  const [grouping, setGrouping] = useState("project");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const allPending = inbox();
  const pending = allPending.filter((r) => inScope(r, scope));
  const pendingTotal = projectCounts.value?.[scope]?.inboxRuns ?? pending.length;
  const allPendingTotal = projectCounts.value?.[ALL]?.inboxRuns ?? allPending.length;
  const filtered = prioritizedReviewRuns(pending, { query, reason: filter ? filter as ReviewReason : undefined });
  const groups = groupReviewRuns(filtered, (run) => {
    if (grouping === "reason") { const reason = reviewReason(run)!; return { id: reason, label: REVIEW_REASON_LABELS[reason] }; }
    if (grouping === "repo") return { id: run.repo, label: run.repo };
    if (grouping === "none") return { id: "all", label: "All attention items" };
    const project = projectFor(run); return { id: project?.id ?? "unassigned", label: project?.name ?? "Without a project" };
  });
  const matching = automations.value.filter(a => !category || !a.target && (category === "backlog" ? !!a.sweep : !a.sweep));
  const list = matching.filter((a) => automationInScope(a, scope));
  const elsewhere = matching.filter(a => !automationInScope(a, scope));
  const withoutProject = elsewhere.filter(a => !automationProject(a.run)).length;
  const project = projects.value.find(p => p.id === scope);
  const here = project ? ` in ${project.name}` : scoped ? " without a project" : "";
  return (
    <div class="automations">
      {mode !== "automations" ? <ProjectTeamsInbox projectId={currentProject.value !== ALL && currentProject.value !== NONE ? currentProject.value : undefined} /> : null}
      {showScope ? <div class="page-head">
        <div class="ph-text page-head-text">
          <h3>Project scope</h3>
          <p class="lede">
            {mode === "inbox" ? "Questions, blocked work, failed checks and results waiting for your review." : "Schedule work and manage triggers. Results wait in your Inbox; nothing is merged automatically."}
          </p>
        </div>
        {projectId ? <span>{project?.name}</span> : <ProjectButton />}
      </div> : null}

      {/* Each section is a card: its title, then its items as rows. */}
      {mode !== "automations" ? <section class="section auto-card" aria-labelledby="inbox-title">
        <h2 class="section-title" id="inbox-title">
          Review inbox {pendingTotal ? <span class="count">{pendingTotal}</span> : null}
        </h2>
        <Elsewhere count={allPendingTotal - pendingTotal} what={(n) => `${n} in other projects need${n === 1 ? "s" : ""} you`} />
        <p class="help inbox-note">Higher run priorities come first, then questions, blocked work, failures and results. Older items come first within each priority. Open a run to answer approvals, resume work or review its evidence.</p>
        {!projectCounts.value ? <p class="help" role="status">Counts currently show loaded review items.</p> : null}
        {pendingTotal > pending.length ? <p class="help" role="status">Showing {pending.length} of {pendingTotal} review items in this scope. Older items are still in history.{filterActive.value ? <> <button class="btn small" onClick={() => setRunFilter({ q: "", status: "all", pattern: "", agent: "", repo: "" })}>Clear sidebar filters to load older items</button></> : historyNextCursor.value ? <> <button class="btn small" disabled={historyLoadingMore.value} onClick={() => void loadOlderRuns()}>{historyLoadingMore.value ? "Loading…" : "Load older review items"}</button></> : null}</p> : null}
        <div class="wb-row inbox-filters"><label>Group by<select class="field" aria-label="Group review inbox" value={grouping} onChange={(event) => setGrouping(event.currentTarget.value)}><option value="project">Project</option><option value="repo">Repository</option><option value="reason">Attention needed</option><option value="none">No grouping</option></select></label><label>Show<select class="field" aria-label="Filter review inbox" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="">All attention items</option>{Object.entries(REVIEW_REASON_LABELS).map(([id, label]) => <option value={id}>{label}</option>)}</select></label><label>Search<input class="field" aria-label="Search review inbox" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Task, repository or run ID" /></label></div>
        {filtered.length ? groups.map((group) => <section key={group.id} class="inbox-group" aria-label={`Review group ${group.label}`}><h3>{group.label} <span class="count">{group.runs.length}</span></h3>{group.runs.map((r) => <InboxItem key={r.id} run={r} scoped={scoped} />)}</section>) : <p class="help empty">{pendingTotal ? "No loaded attention items match these filters." : `Nothing to review${here}. Runs that changed nothing are archived on their own.`}</p>}
      </section> : null}

      {mode !== "inbox" ? <section class="section auto-card" aria-labelledby="automations-title">
        <h2 class="section-title" id="automations-title">
          {category === "backlog" ? "Scheduled backlog work" : "Repeating tasks and webhooks"} {list.length ? <span class="n">{list.length}</span> : null}
        </h2>
        {automationLoadError.value ? <p class="msg err automation-storage-note" role="alert">Automations could not be refreshed: {automationLoadError.value} <button class="btn small" onClick={() => void loadAutomations()}>Retry</button></p> : null}
        {automationStorage.value?.state === "unavailable" ? <p class="msg err automation-storage-note" role="alert">Automation storage is unavailable: {automationStorage.value.reason}. Existing records have been preserved. Fix access to <code>{automationStorage.value.source}</code>, then restart CodeFlow.</p> : automationStorage.value?.state === "recovered" ? <p class="msg warn automation-storage-note" role="status">Automation storage was recovered: {automationStorage.value.reason}. Original records were preserved in <code>{automationStorage.value.backup}</code>; only readable records are shown.</p> : null}
        {!projectId ? <><Elsewhere count={elsewhere.length - withoutProject} what={(n) => `${n} more in other projects`} />{withoutProject ? <p class="help automation-storage-note">{withoutProject} {withoutProject === 1 ? "automation has" : "automations have"} no project. <button class="linkish" onClick={() => selectProject(NONE, { defaults: false, repo: false })}>Show without a project</button></p> : null}</> : null}
        {list.length ? (
          list.map((a) => <AutomationRow key={a.id} a={a} scoped={scoped} />)
        ) : (
          <p class="help empty">
            {automationStorage.value?.state === "unavailable" || automationLoadError.value ? "Saved automations are hidden until storage can be read." : <>None{here} yet. Set up a run in the composer — task, team, check — and choose <b>Schedule → Repeat</b> next to Start run.</>}
          </p>
        )}
      </section> : null}

      <p class="help">To access this computer from another device, open <a href="#/settings/connections/devices">Connections → Share access</a>.</p>
    </div>
  );
}

/**
 * The project to name next to a repo: only when every project is listed (in one, everything is in
 * it), and not when it's just named after the repo.
 */
const projectLabel = (p: Project | undefined, repo: string, scoped: boolean) => (!scoped && p && p.name !== baseName(repo) ? p : undefined);

/** Part of a list is in other projects: how much, and a link that shows every project (as the sidebar's does). */
function Elsewhere({ count, what }: { count: number; what: (n: number) => string }) {
  if (count <= 0) return null;
  return (
    <div class="rail-hint elsewhere">
      {what(count)}
      <button type="button" onClick={() => selectProject(ALL)}>
        Show all
      </button>
    </div>
  );
}

function InboxItem({ run, scoped }: { run: RunSummary; scoped: boolean }) {
  const changed = run.artifacts.filter((a) => a.stat?.trim());
  const project = projectLabel(projectFor(run), run.repo, scoped);
  return (
    <div class="inbox-item">
      <div class="ih">
        <span class="badge">{REVIEW_REASON_LABELS[reviewReason(run)!]}</span>{run.priority ? <span class="badge">Priority {run.priority > 0 ? "+" : ""}{run.priority}</span> : null}
        <span class={`dot ${runState(run)}`} />
        <a href={`#/run/${run.id}`} class="t">
          {runTitle(run)}
        </a>
        <span class="help">
          {run.trigger ? <><Icon name={run.trigger.via === "sweep" ? "layers" : run.trigger.via === "webhook" ? "globe" : "clock"} class="inline-icon" /> {run.trigger.name} · </> : null}{STATUS_TEXT[run.status] ?? run.status}
          {` · checks: ${checksLabel(run).toLowerCase()}`} · {baseName(run.repo)}
          {project ? <> · <Icon name="project" class="inline-icon" /> {project.name}</> : null} · {ago(run.createdAt)}
        </span>
      </div>
      {run.awaiting ? <a class="btn small primary" href={`#/run/${run.id}`}>Open pending approval</a> : null}
      {run.checkCantRun ? <CantRunNote cantRun={run.checkCantRun} /> : null}
      {run.team ? <div class="help">Team: {run.team.members.length} members · {run.team.tasks.filter((task) => task.status === "completed").length}/{run.team.tasks.length} tasks completed · {run.team.metrics.invocations} calls</div> : null}
      {teamAwaitingAnswer(run) ? <div class="at-notice"><b>The team needs your answer</b><p>{run.team?.messages.find((message) => message.id === run.team!.awaitingRequestId)?.body}</p><a class="btn small primary" href={`#/run/${run.id}`}>Answer team question</a></div> : run.team?.status === "blocked" ? <div class="at-notice"><p>{run.team.gaps.join(" ")}</p><a class="btn small" href={`#/run/${run.id}`}>Continue team work</a></div> : null}
      {run.review ? <div class="help">Review: {run.review.verdict === "approve" ? "approve" : `${run.review.findings.length} findings`}</div> : null}
      {changed.map((a) => (
        <pre key={a.branch} class="stat" tabIndex={0} aria-label={`Changed files on ${a.branch}`}>
          {a.label} · {a.branch}
          {"\n"}
          {a.stat}
        </pre>
      ))}
      {run.error ? <div class="msg err">{run.error}</div> : null}
      {run.triage?.state === "pending" ? <TriageActions run={run} /> : null}
    </div>
  );
}

/** Approve (optionally opening a PR), ask for changes, or reject an automation's result. */
export function TriageActions({ run }: { run: RunSummary }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [calls, setCalls] = useState(String(run.loop.maxInvocations ?? run.loop.maxSteps));
  const [minutes, setMinutes] = useState(String(run.loop.maxMinutes));
  const budgetValid = calls.trim() !== "" && Number.isSafeInteger(Number(calls)) && Number(calls) >= 1 && Number(calls) <= MAX_EXECUTION_BUDGET.maxSteps && minutes.trim() !== "" && Number.isFinite(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= MAX_EXECUTION_BUDGET.maxMinutes;
  const act = async (decision: "approve" | "revise" | "reject", extra: Record<string, unknown> = {}) => {
    if (busy || run.status === "running" || (decision === "revise" && (!note.trim() || !budgetValid))) return;
    if (decision === "reject" && !await confirmAction("Reject this result? Its worktrees and branches are deleted.", {"title":"Reject this result?","confirmLabel":"Reject result","danger":true})) return;
    setBusy(decision);
    try {
      const result = await post<{ ok: boolean; warning?: string }>(`/api/runs/${run.id}/triage`, { decision, note, ...(decision === "revise" ? { budget: { maxSteps: Number(calls), maxInvocations: Number(calls), maxMinutes: Number(minutes) } } : {}), ...extra });
      showToast(
        result.warning || (decision === "approve"
          ? extra.pushPr
            ? `Approved — pushed to PR #${run.source?.number}`
            : extra.openPr
              ? "Approved — pull request opened"
              : "Approved"
          : decision === "revise"
            ? "Sent — the agent is revising it"
            : "Rejected and cleaned up"),
        result.warning ? 8000 : undefined,
      );
      setNote("");
    } catch (err) {
      showError((err as Error).message, 5000);
    } finally {
      setBusy("");
    }
  };
  const hasChange = run.artifacts.some((a) => a.stat?.trim());
  const running = run.status === "running";
  // A fix for a pull request (Dependabot's, say) goes onto that PR, not into a new one.
  const toPr = run.source?.kind === "pr" && !run.source.isCrossRepository ? run.source : undefined;
  return (
    <div class="triage">
      <input class="field" placeholder="What should change? (for Revise)" value={note} onInput={(e) => setNote(e.currentTarget.value)} disabled={running} />
      {note.trim() ? <details class="followup-budget"><summary>Revision budget · {calls || "—"} calls · {minutes || "—"} min</summary><label>Maximum calls<input class="field" aria-label="Revision maximum calls" aria-invalid={!budgetValid} type="number" min={1} max={MAX_EXECUTION_BUDGET.maxSteps} value={calls} onInput={(event) => setCalls(event.currentTarget.value)} /></label><label>Maximum minutes<input class="field" aria-label="Revision maximum minutes" aria-invalid={!budgetValid} type="number" step="any" min={1} max={MAX_EXECUTION_BUDGET.maxMinutes} value={minutes} onInput={(event) => setMinutes(event.currentTarget.value)} /></label></details> : null}
      {note.trim() && !budgetValid ? <p class="msg err" role="alert">Choose 1–{MAX_EXECUTION_BUDGET.maxSteps} whole calls and 1–{MAX_EXECUTION_BUDGET.maxMinutes} minutes.</p> : null}
      <button class="btn small" disabled={running || !!busy || !note.trim() || !budgetValid} onClick={() => act("revise")}>
        {busy === "revise" ? "Sending…" : "Revise"}
      </button>
      <button class="btn small primary" disabled={running || !!busy} onClick={() => act("approve")}>
        ✓ Approve
      </button>
      {hasChange && toPr ? (
        <button class="btn small" disabled={running || !!busy} title={`Approve and push the fix to ${toPr.headRefName}, updating PR #${toPr.number} (never forced)`} onClick={() => act("approve", { pushPr: true })}>
          {busy === "approve" ? "…" : `Approve & push to PR #${toPr.number}`}
        </button>
      ) : hasChange ? (
        <button class="btn small" disabled={running || !!busy} title="Approve, push the branch and open a pull request into the base branch" onClick={() => act("approve", { openPr: true })}>
          {busy === "approve" ? "…" : "Approve & open PR"}
        </button>
      ) : null}
      <button class="btn small danger" disabled={running || !!busy} onClick={() => act("reject")}>
        Reject
      </button>
    </div>
  );
}

function AutomationRow({ a, scoped }: { a: Automation; scoped: boolean }) {
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [showHook, setShowHook] = useState(false);
  const [inspect, setInspect] = useState(false);
  const last = a.lastRunId ? runs.value.get(a.lastRunId) : undefined;
  const project = projectLabel(automationProject(a.run), a.run.repo, scoped);
  const update = (patch: object) => post<Automation>(`/api/automations/${a.id}`, patch).then(loadAutomations, (e) => showError(e.message, 5000));
  // The editor shows why a save failed itself; what's saved now is loaded either way.
  const saveSchedule = (patch: object) => post<Automation>(`/api/automations/${a.id}`, patch).then(loadAutomations, (err) => { void loadAutomations(); throw err; });
  const hookUrl = `${location.origin}${a.hookPath}`;
  if (a.target) return <div class="auto-row"><b>{a.name}</b><p class="help">Project mission · {a.enabled ? "active" : "paused"} · {a.scheduleText}</p><button class="btn small" onClick={() => { const id = a.run.project; if (id) route.value = { view: "project", id }; }}>Mission, cycles and opportunities</button></div>;
  return (
    <div class={`auto-row ${a.enabled ? "" : "off"}`}>
      <div class="ar-head">
        {/* A real checkbox, drawn as a switch: it keeps its keyboard use and its checked state. */}
        <label class="switch" title={a.enabled ? "Turn off" : "Turn on"}>
          <input type="checkbox" role="switch" aria-label={`${a.name}: on`} checked={a.enabled} onChange={(e) => update({ enabled: e.currentTarget.checked })} />
        </label>
        <b>{a.name}</b>
        <span class="help">
          {a.sweep ? `Sweep: up to ${a.sweep.max} new ${a.sweep.kind === "issues" ? "issues" : a.sweep.kind === "dependabot" ? "Dependabot PRs" : "alerts"} · ` : ""}
          {a.scheduleText}
          {a.webhook ? " · webhook" : ""}
          {a.isolate ? ` · checks in ${a.image || "node:22"}` : ""}
        </span>
        <span class="spacer" />
        <button class="btn small" aria-expanded={inspect} onClick={() => setInspect(!inspect)}>Preview and events</button>
        <button
          class="btn small"
          disabled={starting}
          aria-busy={starting}
          onClick={async () => {
            if (startingRef.current) return;
            startingRef.current = true; setStarting(true);
            try {
              const { id, ids } = await post<{ id?: string; ids?: string[] }>(`/api/automations/${a.id}/run`);
              void loadAutomations();
              if (ids && ids.length !== 1) showToast(`Started ${ids.length} runs — their results will wait in the inbox`);
              else if (id) route.value = { view: "run", id };
            } catch (error) { showError((error as Error).message, 5000); }
            finally { startingRef.current = false; setStarting(false); }
          }}
        >
          {starting ? "Starting…" : "Run now"}
        </button>
        {a.webhook ? (
          <button class="btn small" aria-pressed={showHook} onClick={() => setShowHook(!showHook)}>
            Webhook
          </button>
        ) : null}
        <button
          class="btn small danger"
          onClick={async () => await confirmAction(`Delete “${a.name}”? Its past runs are kept.`, {"title":"Delete automation?","confirmLabel":"Delete automation","danger":true}) && api(`/api/automations/${a.id}`, { method: "DELETE" }).then(loadAutomations, (e) => showError(e.message))}
        >
          Delete
        </button>
      </div>
      <div class="ar-meta help">
        {patterns.value.find((p) => p.id === a.run.pattern)?.name ?? a.run.pattern} in {baseName(a.run.repo)}
        {project ? <> · <Icon name="project" class="inline-icon" /> {project.name}</> : null}: “{a.run.task.split("\n")[0]}”
        {a.sweep && a.handled?.length ? ` · ${a.handled.length} handled so far` : ""}
        {Object.values(a.run.roles)
          .flat()
          .filter((x, i, all) => all.indexOf(x) === i)
          .map((id) => (id === "auto" ? <span key={id}> · Auto</span> : <span key={id}> · <AgentTag id={id as any} /></span>))}
      </div>
      <div class="ar-meta help">
        {a.enabled && a.nextAt ? `Next: ${formatNextRun(a.nextAt, a.schedule)}` : a.enabled ? "Runs when triggered" : "Off"}
        {a.lastFiredAt ? (
          <>
            {" · Last: "}
            {last ? <a href={`#/run/${last.id}`}>{ago(a.lastFiredAt)} ({last.triage?.state === "empty" ? "no changes" : STATUS_TEXT[last.status] ?? last.status})</a> : ago(a.lastFiredAt)}
          </>
        ) : null}
        {a.queued?.length ? ` · ${a.queued.length} webhook event${a.queued.length === 1 ? "" : "s"} waiting for the run to end` : null}
        {a.lastError ? <span class="msg err inline"> · {a.lastError.startsWith("Turned off:") ? a.lastError : `Couldn’t start: ${a.lastError}`}</span> : null}
      </div>
      <ScheduleEditor automation={a} save={saveSchedule} allowOff={a.webhook} />
      <AutomationExecutionEditor automation={a} />
      {inspect ? <AutomationInspector automation={a} /> : null}
      {showHook ? (
        <div class="hook">
          <div>
            <span class="lbl">URL</span> <code>{hookUrl}</code>
          </div>
          <div>
            <span class="lbl">Secret</span> <code>{a.token.slice(0, 6)}…</code>{" "}
            <button class="btn small" onClick={() => copy(a.token, "Secret copied")}>
              Copy
            </button>
            <button class="btn small" onClick={async () => await confirmAction("Make a new secret? The old one stops working.", {"title":"Replace webhook secret?","confirmLabel":"Replace secret","danger":true}) && update({ rotateToken: true })}>
              New secret
            </button>
          </div>
          <pre>{`curl -X POST ${hookUrl} \\\n  -H "Authorization: Bearer <secret>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"details": "what happened", "source": {"kind": "pr", "number": 12}}'`}</pre>
          <div class="help">
            For a GitHub webhook, use this URL through a tunnel, content type <code>application/json</code>, and the secret above. {describeGithubRunEvents(!!a.sweep)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AutomationInspector({ automation: a }: { automation: Automation }) {
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const reloadEvents = () => api<AutomationEvent[]>(`/api/automations/${a.id}/events`).then(setEvents);
  const reloadPreview = () => post<AutomationPreview>(`/api/automations/${a.id}/preview`, { via: "manual" }).then(setPreview);
  useEffect(() => {
    let alive = true;
    const load = () => post<AutomationPreview>(`/api/automations/${a.id}/preview`, { via: "manual" }).then((dryRun) => { if (alive) { setPreview(dryRun); setError(""); } }, (err) => { if (alive) setError((err as Error).message); });
    void load();
    const stop = pollVisible(() => api<AutomationEvent[]>(`/api/automations/${a.id}/events`).then((history) => { if (alive) setEvents(history); }, () => {}), 15_000);
    return () => { alive = false; stop(); };
  }, [a.id]);
  const retry = async (event: AutomationEvent) => {
    setBusy(event.id);
    try {
      setError("");
      const result = await post<{ state: AutomationEvent["state"]; id?: string; ids?: string[]; reason?: string }>(`/api/automations/${a.id}/events/${event.id}/retry`);
      await Promise.all([reloadEvents(), reloadPreview(), loadAutomations()]);
      if (result.state === "started") showToast("Event retry started. Open the run from Event history.");
      else if (result.state === "queued") showToast("Event queued: it starts when the current run ends.", 5000);
      else setError(`Retry ${result.state}: ${result.reason ?? "No run was started"}`);
    }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(""); }
  };
  return <section class="hook automation-inspector" aria-label={`Preview and events for ${a.name}`}>
    <b>Dry run</b><p class="help">Preview current selections and settings before running.</p>
    {preview ? <>
      <p>{preview.ready ? "Ready to start" : "Cannot start immediately"}{preview.busy ? ` · ${preview.busy}` : ""}{preview.wouldQueue ? " · event would wait in the queue" : ""}</p>
      <p class="help">Permissions: {preview.permissions.trust} · {preview.permissions.isolate ? `commands in ${preview.permissions.image}` : "commands on this machine"} · {preview.limits.maxInvocations ?? preview.limits.maxSteps ?? "default"} calls · {preview.limits.maxMinutes ?? "default"} minutes · webhooks {preview.limits.startsUsed}/{preview.limits.startsPerHour} this hour</p>
      {preview.commands.setup ? <div class="help">Setup: <code>{preview.commands.setup}</code></div> : null}
      {preview.commands.check ? <div class="help">Check: <code>{preview.commands.check}</code></div> : null}
      {preview.warnings.map((warning) => <p class="msg warn" key={warning}>{warning}</p>)}
      {preview.selected.length ? <ul>{preview.selected.map((item) => <li key={item.key}><b>{item.key}</b>: {item.task.split("\n")[0]}</li>)}</ul> : <p class="help">No work selected.</p>}
      {preview.skipped.length ? <details><summary>{preview.skipped.length} items outside this run</summary><ul>{preview.skipped.map((item) => <li key={item.key}>{item.key}: {item.reason}</li>)}</ul></details> : null}
      <button class="btn small" onClick={() => reloadPreview().catch((err) => setError(err.message))}>Refresh preview</button>
    </> : <p class="help">Loading preview…</p>}
    <p><b>Event history</b></p><p class="help">Keeps the latest 100 events, including queued, deduplicated, failed and dropped deliveries. Retrying uses the original validated event and current limits.</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {events.length ? <div class="table-wrap"><table class="ins-table"><thead><tr><th>Received</th><th>Origin</th><th>State</th><th>Details</th><th>Action</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}>
      <td>{new Date(event.at).toLocaleString()}</td><td>{event.via}</td><td>{event.state}{event.retries ? ` (${event.retries} ${event.retries === 1 ? "retry" : "retries"})` : ""}</td>
      <td>{event.input.source ? `${event.input.source.kind} #${event.input.source.number}` : event.input.details?.slice(0, 160) || "Saved task"}{event.reason ? <div class="help">{event.reason}</div> : null}{event.runIds?.length ? <div class="help">{event.runIds.map((id, index) => <a href={`#/run/${id}`} key={id} aria-label={`Open run ${id}`}>{event.runIds!.length > 1 ? `Open run ${index + 1}` : "Open run"}</a>)}</div> : null}</td>
      <td>{event.state === "failed" || event.state === "dropped" ? <button class="btn small" disabled={!a.enabled || !!busy} onClick={() => retry(event)}>{busy === event.id ? "Retrying…" : "Retry event"}</button> : "–"}</td>
    </tr>)}</tbody></table></div> : <p class="help">No events recorded yet.</p>}
  </section>;
}

// ---------------------------------------------------------------- save from the composer
/** Editing execution settings keeps the automation identity, webhook secret and event history. */
function AutomationExecutionEditor({ automation: a }: { automation: Automation }) {
  const [isolate, setIsolate] = useState(a.isolate), [image, setImage] = useState(a.image ?? "");
  const [webhook, setWebhook] = useState(a.webhook), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [base, setBase] = useState(a);
  const dirty = isolate !== base.isolate || image !== (base.image ?? "") || webhook !== base.webhook;
  const conflict = dirty && a.revision !== base.revision;
  const reset = () => { setBase(a); setIsolate(a.isolate); setImage(a.image ?? ""); setWebhook(a.webhook); setError(""); };
  useEffect(() => { if (!dirty) reset(); }, [a.revision]);
  const problem = !webhook && !a.schedule ? "Keep the webhook enabled until you add a schedule." : "";
  const save = async () => {
    if (saving || problem || conflict) return;
    setSaving(true); setError("");
    try {
      const saved = await post<Automation>(`/api/automations/${a.id}`, { isolate, image: image.trim(), webhook, revision: base.revision });
      setBase(saved); setIsolate(saved.isolate); setImage(saved.image ?? ""); setWebhook(saved.webhook); await loadAutomations();
    } catch (error) { setError((error as Error).message); void loadAutomations(); }
    finally { setSaving(false); }
  };
  return <details class="execution-settings"><summary>Execution and webhook settings</summary>
    <label class="check"><input type="checkbox" checked={webhook} onChange={event => setWebhook(event.currentTarget.checked)} /> Enable webhook</label>
    <label class="check"><input type="checkbox" checked={isolate} onChange={event => setIsolate(event.currentTarget.checked)} /> Run checks and setup in a Docker container</label>
    {isolate ? <label>Docker image<input class="field" aria-label="Docker image" placeholder="node:22" value={image} onInput={event => setImage(event.currentTarget.value)} /><span class="help">Empty uses node:22. Applies to future runs; only the worktree is mounted.</span></label> : null}
    <button class="btn small" disabled={saving || !dirty || !!problem || conflict} onClick={() => void save()}>{saving ? "Saving…" : "Save execution settings"}</button>
    {conflict ? <p class="msg warn" role="alert">This automation changed in another window. Your edit is still here. <button class="btn small" onClick={reset}>Use saved settings</button></p> : null}
    {problem ? <p class="help">{problem}</p> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}
  </details>;
}

type Kind = "every" | "daily" | "webhook";

export function SaveAutomationDialog({ body, onClose }: { body: Record<string, any>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const [name, setName] = useState(String(body.task ?? "").split("\n")[0]!.slice(0, 50));
  const [kind, setKind] = useState<Kind>("daily");
  // As typed: an emptied field stays empty instead of jumping back to 60.
  const [every, setEvery] = useState("60");
  const [at, setAt] = useState("07:00");
  const [timezone, setTimezone] = useState(localTimezone());
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [webhook, setWebhook] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [image, setImage] = useState("node:22");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const teamProblem = usesTaskTeam(body) ? SCHEDULED_TEAM_NOTICE : "";
  const draft: ScheduleDraft = { mode: kind === "every" ? "every" : "daily", at, timezone, days, every };
  const schedule = kind === "webhook" ? undefined : draftSchedule(draft);
  const problem = kind === "webhook" ? undefined : draftProblem(draft, true);
  // A save that failed says why until the schedule changes; the preview shows its own problems.
  useEffect(() => setError(""), [kind, at, timezone, every, days.join()]);
  const save = async () => {
    if (teamProblem || problem) return;
    setSaving(true);
    setError("");
    try {
      const { attachments: _a, approvals: _p, branchPrefix: _b, ...run } = body;
      run.context = { paths: body.context?.paths ?? [] };
      const saved = await post<Automation>("/api/automations", {
        name,
        run,
        schedule,
        webhook: kind === "webhook" || webhook,
        isolate,
        ...(isolate ? { image: image.trim() || undefined } : {}),
      });
      await loadAutomations();
      showToast("Automation saved");
      onClose();
      // Show the project it went in (from "No project", its repo's), as starting a run does.
      const p = automationProject(saved.run);
      if (currentProject.value !== ALL && p && p.id !== currentProject.value) selectProject(p.id, { defaults: false, repo: false });
      route.value = { view: "automations" };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog class="picker small-dialog save-auto" ref={ref} aria-labelledby="save-automation-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="save-automation-title">Save as automation</h3>
          <div class="help">Runs this task with {body.pattern === "solo" ? "this agent" : "this team"} and these settings, unattended. Results wait in your inbox; nothing merges by itself.</div>
        </div>
        <div class="dialog-body">
          {teamProblem ? <p class="msg warn" role="status">{teamProblem}</p> : null}
          <div class="fg">
            <label class="lbl" for="auto-name">
              Name
            </label>
            <input id="auto-name" class="field" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </div>
          <div class="fg">
            <span class="lbl" id="auto-when">
              When
            </span>
            <div class="segmented" role="radiogroup" aria-labelledby="auto-when">
              {(
                [
                  ["daily", "At a time"],
                  ["every", "Repeatedly"],
                  ["webhook", "Only from a webhook"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} class={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                  {label}
                </button>
              ))}
            </div>
            {kind === "daily" ? (
              <div class="row-inline">
                <input class="field inline" type="time" aria-label="Time of day" value={at} onInput={(e) => setAt(e.currentTarget.value)} />
                <span class="days" role="group" aria-label="Days">
                  {DAYS.map((d, i) => (
                    <button key={d} type="button" class="day" aria-pressed={days.includes(i)} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>
                      {d}
                    </button>
                  ))}
                </span>
              </div>
            ) : kind === "every" ? (
              <div class="row-inline">
                Every <input class="field inline num" type="number" min={MIN_EVERY_MINUTES} max={MAX_EVERY_MINUTES} step={1} aria-label="Minutes between runs" value={every} onInput={(e) => setEvery(e.currentTarget.value)} /> minutes
              </div>
            ) : null}
            {kind === "daily" ? (
              <label class="lbl tz">
                Time zone
                <input class="field" aria-label="Automation time zone" placeholder="Europe/Stockholm" value={timezone} onInput={(event) => setTimezone(event.currentTarget.value)} />
              </label>
            ) : null}
            {kind !== "webhook" ? <SchedulePreview schedule={schedule} problem={problem} /> : null}
          </div>
          <div class="fg checks">
            {kind !== "webhook" ? (
              <label class="check">
                <input type="checkbox" checked={webhook} onChange={(e) => setWebhook(e.currentTarget.checked)} /> Also start it from a webhook
              </label>
            ) : null}
            <label class="check">
              <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.currentTarget.checked)} /> Run checks and setup in a Docker container
            </label>
            {isolate ? (
              <div class="row-inline image">
                Image <input class="field inline mono" aria-label="Docker image" value={image} onInput={(e) => setImage(e.currentTarget.value)} />
                <span class="help">Only the worktree is mounted; none of your environment or home folder.</span>
              </div>
            ) : null}
          </div>
          {error ? <div class="msg err">{error}</div> : null}
        </div>
        <div class="picker-foot">
          <span class="ps" />
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={saving || !!teamProblem || !name.trim() || !!problem} title={teamProblem || undefined} onClick={save}>
            {saving ? "Saving…" : "Save automation"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
