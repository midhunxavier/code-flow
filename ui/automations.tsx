import { confirmAction } from "./confirm-state.js";
import { ProjectTeamsInbox } from "./project-teams.js";
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, CantRunNote } from "./bits.js";
import { Icon } from "./icons.js";
import { ago, api, baseName, copy, post, showToast, STATUS_TEXT } from "./lib.js";
import { activeProject, ALL, currentProject, inScope, NONE, patterns, projectFor, projects, route, runs, runState, selectProject } from "./state.js";
import type { Project, RunSummary } from "./types.js";
import { ProjectButton } from "./projects.js";
import { teamAwaitingAnswer } from "./team-state.js";
import { prioritizedReviewRuns, groupReviewRuns, reviewReason, REVIEW_REASON_LABELS, type ReviewReason } from "../src/review-inbox.js";
import type { AutomationEvent, AutomationPreview, Schedule } from "../src/automation.js";

/** The project an automation's runs go in: the one it was saved with, or (deleted since) its repo's. */
export const automationProject = (run: { project?: string; repo: string }) =>
  projects.value.find((p) => p.id === run.project) ?? projects.value.find((p) => p.repos.includes(run.repo));

/** Is the automation in what the app is showing? (inScope, for where its runs go.) */
const automationInScope = (a: Automation, scope = currentProject.value) => {
  if (scope === ALL) return true;
  const p = automationProject(a.run);
  return scope === NONE ? !p : p?.id === scope;
};

export interface Automation {
  target?: { kind: "project-team"; teamId: string };
  id: string;
  name: string;
  enabled: boolean;
  run: { repo: string; project?: string; pattern: string; task: string; roles: Record<string, string[]> };
  schedule?: Schedule;
  scheduleText: string;
  webhook: boolean;
  token: string;
  hookPath: string;
  isolate: boolean;
  image?: string;
  nextAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastError?: string;
  /** A recurring sweep: lists this kind of work and starts runs for new items. */
  sweep?: { kind: "issues" | "dependabot" | "alerts"; max: number };
  handled?: string[];
  /** Webhook events waiting for the running run to end. */
  queued?: unknown[];
}

export const automations = signal<Automation[]>([]);
export async function loadAutomations() {
  try {
    automations.value = await api<Automation[]>("/api/automations");
  } catch {
    // keep what we have
  }
}
/** Automation results waiting for your decision. */
export const inbox = () => prioritizedReviewRuns([...runs.value.values()]);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function SchedulePreview({ schedule }: { schedule?: Schedule }) {
  const [times, setTimes] = useState<number[]>([]);
  const [error, setError] = useState("");
  const key = JSON.stringify(schedule);
  useEffect(() => {
    let alive = true;
    if (!schedule) { setTimes([]); setError(""); return; }
    const timer = setTimeout(() => void post<{ times: number[] }>("/api/automations/schedule-preview", { schedule, after: Date.now(), count: 5 }).then((value) => { if (alive) { setTimes(value.times); setError(""); } }, (err) => { if (alive) { setTimes([]); setError(err.message); } }), 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [key]);
  const timezone = schedule && "at" in schedule ? schedule.timezone : undefined;
  const format = (at: number) => { try { return new Date(at).toLocaleString([], { timeZone: timezone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }); } catch { return "Choose a valid time zone"; } };
  return <div role="group" aria-label="Next scheduled times"><p class="help">Next runs{timezone ? ` in ${timezone}` : ""}:</p>{times.length ? <ol class="help">{times.map((at) => <li key={at}>{format(at)}</li>)}</ol> : <p class="help">{schedule ? "Calculating…" : "No schedule"}</p>}{timezone ? <p class="help">Runs once per local day. A skipped daylight-saving time moves forward; a repeated time uses its first occurrence.</p> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}</div>;
}

export function ScheduleEditor({ automation: a, save }: { automation: Pick<Automation, "name" | "schedule">; save: (patch: object) => unknown }) {
  const current = a.schedule;
  const [mode, setMode] = useState<"daily" | "every" | "off">(!current ? "off" : "every" in current ? "every" : "daily");
  const [at, setAt] = useState(current && "at" in current ? current.at : "07:00");
  const [timezone, setTimezone] = useState(current && "at" in current ? current.timezone ?? localTimezone() : localTimezone());
  const [days, setDays] = useState<number[]>(current && "at" in current ? current.days ?? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6]);
  const [every, setEvery] = useState(current && "every" in current ? current.every : 60);
  const schedule: Schedule | undefined = mode === "off" ? undefined : mode === "every" ? { every } : { at, timezone, days: days.length === 7 ? undefined : days };
  return <details><summary>Schedule and next times</summary>
    <label>Schedule<select class="field" aria-label={`Schedule for ${a.name}`} value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}><option value="off">Only when triggered</option><option value="daily">At a time</option><option value="every">Every N minutes</option></select></label>
    {mode === "daily" ? <><label>Time<input class="field" type="time" value={at} onInput={(event) => setAt(event.currentTarget.value)} /></label><label>Time zone<input class="field" placeholder="Europe/Stockholm" value={timezone} onInput={(event) => setTimezone(event.currentTarget.value)} /></label></> : mode === "every" ? <label>Minutes<input class="field" type="number" min={5} max={10080} value={every} onInput={(event) => setEvery(Number(event.currentTarget.value))} /></label> : null}
    {mode === "daily" && <fieldset><legend>Days</legend>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => <label key={day}><input type="checkbox" checked={days.includes(index)} onChange={(event) => setDays(event.currentTarget.checked ? [...days, index].sort() : days.filter((d) => d !== index))} /> {day}</label>)}</fieldset>}
    <SchedulePreview schedule={schedule} /><button type="button" class="btn small" onClick={() => save({ schedule: schedule ?? null })}>Save schedule</button>
  </details>;
}

// ---------------------------------------------------------------- page
export function AutomationsView({ mode = "all", category }: { mode?: "all" | "inbox" | "automations"; category?: "repeat" | "backlog" }) {
  useEffect(() => {
    void loadAutomations();
    const timer = setInterval(loadAutomations, 15_000);
    return () => clearInterval(timer);
  }, []);
  // The project you're in, as in the sidebar; what's in other projects is a count and a link away.
  const scoped = currentProject.value !== ALL;
  const [grouping, setGrouping] = useState("project");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const allPending = inbox();
  const pending = allPending.filter((r) => inScope(r));
  const filtered = prioritizedReviewRuns(pending, { query, reason: filter ? filter as ReviewReason : undefined });
  const groups = groupReviewRuns(filtered, (run) => {
    if (grouping === "reason") { const reason = reviewReason(run)!; return { id: reason, label: REVIEW_REASON_LABELS[reason] }; }
    if (grouping === "repo") return { id: run.repo, label: run.repo };
    if (grouping === "none") return { id: "all", label: "All attention items" };
    const project = projectFor(run); return { id: project?.id ?? "unassigned", label: project?.name ?? "Without a project" };
  });
  const matching = automations.value.filter(a => !category || !a.target && (category === "backlog" ? !!a.sweep : !a.sweep));
  const list = matching.filter((a) => automationInScope(a));
  const here = activeProject.value ? ` in ${activeProject.value.name}` : scoped ? " without a project" : "";
  return (
    <div class="automations">
      {mode !== "automations" ? <ProjectTeamsInbox projectId={currentProject.value !== ALL && currentProject.value !== NONE ? currentProject.value : undefined} /> : null}
      <div class="page-head">
        <div class="ph-text page-head-text">
          <h3>Project scope</h3>
          <p class="lede">
            {mode === "inbox" ? "Questions, blocked work, failed checks and results waiting for your review." : "Schedule work and manage triggers. Results wait in your Inbox; nothing is merged automatically."}
          </p>
        </div>
        <ProjectButton />
      </div>

      {/* Each section is a card: its title, then its items as rows. */}
      {mode !== "automations" ? <section class="section auto-card" aria-labelledby="inbox-title">
        <h2 class="section-title" id="inbox-title">
          Review inbox {pending.length ? <span class="count">{pending.length}</span> : null}
        </h2>
        <Elsewhere count={allPending.length - pending.length} what={(n) => `${n} in other projects need${n === 1 ? "s" : ""} you`} />
        <p class="help inbox-note">Higher run priorities come first, then questions, blocked work, failures and results. Older items come first within each priority. Open a run to answer approvals, resume work or review its evidence.</p>
        <div class="wb-row inbox-filters"><label>Group by<select class="field" aria-label="Group review inbox" value={grouping} onChange={(event) => setGrouping(event.currentTarget.value)}><option value="project">Project</option><option value="repo">Repository</option><option value="reason">Attention needed</option><option value="none">No grouping</option></select></label><label>Show<select class="field" aria-label="Filter review inbox" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="">All attention items</option>{Object.entries(REVIEW_REASON_LABELS).map(([id, label]) => <option value={id}>{label}</option>)}</select></label><label>Search<input class="field" aria-label="Search review inbox" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Task, repository or run ID" /></label></div>
        {filtered.length ? groups.map((group) => <section key={group.id} class="inbox-group" aria-label={`Review group ${group.label}`}><h3>{group.label} <span class="count">{group.runs.length}</span></h3>{group.runs.map((r) => <InboxItem key={r.id} run={r} scoped={scoped} />)}</section>) : <p class="help empty">{pending.length ? "No attention items match these filters." : `Nothing to review${here}. Runs that changed nothing are archived on their own.`}</p>}
      </section> : null}

      {mode !== "inbox" ? <section class="section auto-card" aria-labelledby="automations-title">
        <h2 class="section-title" id="automations-title">
          {category === "backlog" ? "Scheduled backlog work" : "Repeating tasks and webhooks"} {list.length ? <span class="n">{list.length}</span> : null}
        </h2>
        <Elsewhere count={matching.length - list.length} what={(n) => `${n} more in other projects`} />
        {list.length ? (
          list.map((a) => <AutomationRow key={a.id} a={a} scoped={scoped} />)
        ) : (
          <p class="help empty">
            None{here} yet. Set up a run in the composer — task, team, check — and choose <b>Schedule → Repeat</b> next to Start run.
          </p>
        )}
      </section> : null}

      <p class="help">To access this workspace from another device, open <a href="#/settings/connections/sharing">Remote access settings</a>.</p>
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
          {run.task.split("\n")[0]}
          {/* Tasks leave an issue's title out (its author wrote it); it's still worth seeing here. */}
          {run.source?.title && !run.task.includes(run.source.title) ? ` — ${run.source.title}` : null}
        </a>
        <span class="help">
          {run.trigger ? <><Icon name={run.trigger.via === "sweep" ? "layers" : run.trigger.via === "webhook" ? "globe" : "clock"} class="inline-icon" /> {run.trigger.name} · </> : null}{STATUS_TEXT[run.status] ?? run.status}
          {run.verdict ? ` · check ${run.verdict}` : run.checkCantRun ? " · check couldn't run" : ""} · {baseName(run.repo)}
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
  const [calls, setCalls] = useState(run.loop.maxInvocations ?? run.loop.maxSteps);
  const [minutes, setMinutes] = useState(run.loop.maxMinutes);
  const act = async (decision: "approve" | "revise" | "reject", extra: Record<string, unknown> = {}) => {
    if (decision === "reject" && !await confirmAction("Reject this result? Its worktrees and branches are deleted.", {"title":"Reject this result?","confirmLabel":"Reject result","danger":true})) return;
    setBusy(decision);
    try {
      await post(`/api/runs/${run.id}/triage`, { decision, note, ...(decision === "revise" ? { budget: { maxSteps: calls, maxInvocations: calls, maxMinutes: minutes } } : {}), ...extra });
      showToast(
        decision === "approve"
          ? extra.pushPr
            ? `Approved — pushed to PR #${run.source?.number}`
            : extra.openPr
              ? "Approved — pull request opened"
              : "Approved"
          : decision === "revise"
            ? "Sent — the agent is revising it"
            : "Rejected and cleaned up",
      );
      setNote("");
    } catch (err) {
      showToast((err as Error).message, 5000);
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
      {note.trim() ? <details class="followup-budget"><summary>Revision budget · {calls} calls · {minutes} min</summary><label>Maximum calls<input class="field" aria-label="Revision maximum calls" type="number" min={1} max={200} value={calls} onInput={(event) => setCalls(Number(event.currentTarget.value))} /></label><label>Maximum minutes<input class="field" aria-label="Revision maximum minutes" type="number" min={1} max={720} value={minutes} onInput={(event) => setMinutes(Number(event.currentTarget.value))} /></label></details> : null}
      <button class="btn small" disabled={running || !!busy || !note.trim()} onClick={() => act("revise")}>
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
  const [showHook, setShowHook] = useState(false);
  const [inspect, setInspect] = useState(false);
  const last = a.lastRunId ? runs.value.get(a.lastRunId) : undefined;
  const project = projectLabel(automationProject(a.run), a.run.repo, scoped);
  const update = (patch: object) => post<Automation>(`/api/automations/${a.id}`, patch).then(loadAutomations, (e) => showToast(e.message, 5000));
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
          onClick={() =>
            post<{ id?: string; ids?: string[] }>(`/api/automations/${a.id}/run`).then(
              ({ id, ids }) => {
                void loadAutomations();
                // A sweep can start several runs: stay here, where their results will arrive.
                if (ids && ids.length !== 1) showToast(`Started ${ids.length} runs — their results will wait in the inbox`);
                else if (id) route.value = { view: "run", id };
              },
              (e) => showToast(e.message, 5000),
            )
          }
        >
          Run now
        </button>
        {a.webhook ? (
          <button class="btn small" aria-pressed={showHook} onClick={() => setShowHook(!showHook)}>
            Webhook
          </button>
        ) : null}
        <button
          class="btn small danger"
          onClick={async () => await confirmAction(`Delete “${a.name}”? Its past runs are kept.`, {"title":"Delete automation?","confirmLabel":"Delete automation","danger":true}) && api(`/api/automations/${a.id}`, { method: "DELETE" }).then(loadAutomations, (e) => showToast(e.message))}
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
        {a.enabled && a.nextAt ? `Next: ${new Date(a.nextAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : a.enabled ? "Runs when triggered" : "Off"}
        {a.lastFiredAt ? (
          <>
            {" · Last: "}
            {last ? <a href={`#/run/${last.id}`}>{ago(a.lastFiredAt)} ({last.triage?.state === "empty" ? "no changes" : STATUS_TEXT[last.status] ?? last.status})</a> : ago(a.lastFiredAt)}
          </>
        ) : null}
        {a.queued?.length ? ` · ${a.queued.length} webhook event${a.queued.length === 1 ? "" : "s"} waiting for the run to end` : null}
        {a.lastError ? <span class="msg err inline"> · couldn't start: {a.lastError}</span> : null}
      </div>
      <ScheduleEditor automation={a} save={update} />
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
            For a GitHub webhook, use this URL through a tunnel, content type <code>application/json</code>, and the secret above. Opened issues and pull requests, and failed workflow runs (with their logs), start a run;
            other events are ignored.
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
    const load = () => Promise.all([api<AutomationEvent[]>(`/api/automations/${a.id}/events`), post<AutomationPreview>(`/api/automations/${a.id}/preview`, { via: "manual" })]).then(([history, dryRun]) => { if (alive) { setEvents(history); setPreview(dryRun); setError(""); } }, (err) => { if (alive) setError((err as Error).message); });
    void load();
    const timer = setInterval(() => void api<AutomationEvent[]>(`/api/automations/${a.id}/events`).then((history) => { if (alive) setEvents(history); }, () => {}), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [a.id]);
  const retry = async (event: AutomationEvent) => {
    setBusy(event.id);
    try { await post(`/api/automations/${a.id}/events/${event.id}/retry`); await Promise.all([reloadEvents(), loadAutomations()]); showToast("Event retry requested"); }
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
    {events.length ? <div class="table-wrap"><table class="ins-table"><thead><tr><th>Received</th><th>Origin</th><th>State</th><th>Details</th><th>Action</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}>
      <td>{new Date(event.at).toLocaleString()}</td><td>{event.via}</td><td>{event.state}{event.retries ? ` (${event.retries} ${event.retries === 1 ? "retry" : "retries"})` : ""}</td>
      <td>{event.input.source ? `${event.input.source.kind} #${event.input.source.number}` : event.input.details?.slice(0, 160) || "Saved task"}{event.reason ? <div class="help">{event.reason}</div> : null}{event.runIds?.map((id) => <a href={`#/run/${id}`} key={id}>Open run </a>)}</td>
      <td>{event.state === "failed" || event.state === "dropped" ? <button class="btn small" disabled={!a.enabled || !!busy} onClick={() => retry(event)}>{busy === event.id ? "Retrying…" : "Retry event"}</button> : "–"}</td>
    </tr>)}</tbody></table></div> : <p class="help">No events recorded yet.</p>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}

// ---------------------------------------------------------------- save from the composer
type Kind = "every" | "daily" | "webhook";

export function SaveAutomationDialog({ body, onClose }: { body: Record<string, any>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const [name, setName] = useState(String(body.task ?? "").split("\n")[0]!.slice(0, 50));
  const [kind, setKind] = useState<Kind>("daily");
  const [every, setEvery] = useState(60);
  const [at, setAt] = useState("07:00");
  const [timezone, setTimezone] = useState(localTimezone());
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [webhook, setWebhook] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [image, setImage] = useState("node:22");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const { attachments: _a, approvals: _p, branchPrefix: _b, ...run } = body;
      run.context = { paths: body.context?.paths ?? [] };
      const saved = await post<Automation>("/api/automations", {
        name,
        run,
        schedule: kind === "every" ? { every } : kind === "daily" ? { at, days, timezone } : undefined,
        webhook: kind === "webhook" || webhook,
        isolate,
        image,
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
          <div class="help">Runs this task with this team and these settings, unattended. Results wait in your inbox; nothing merges by itself.</div>
        </div>
        <div class="dialog-body">
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
                Every <input class="field inline num" type="number" min={5} aria-label="Minutes between runs" value={every} onInput={(e) => setEvery(Number(e.currentTarget.value) || 60)} /> minutes
              </div>
            ) : null}
            {kind === "daily" ? (
              <label class="lbl tz">
                Time zone
                <input class="field" aria-label="Automation time zone" placeholder="Europe/Stockholm" value={timezone} onInput={(event) => setTimezone(event.currentTarget.value)} />
              </label>
            ) : null}
            {kind !== "webhook" ? <SchedulePreview schedule={kind === "every" ? { every } : { at, days, timezone }} /> : null}
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
          <button class="btn primary" disabled={saving || !name.trim() || kind === "daily" && !days.length} onClick={save}>
            {saving ? "Saving…" : "Save automation"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
