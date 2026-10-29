import { MAX_EXECUTION_BUDGET } from "../src/execution-budget.js";
import { useTaskEditDraft } from "./task-edit-draft.js";
import { selfReview, MAX, historyLimitMessage } from "../src/collab/presentation.js";
import { teamConnectionRequired } from "./lib.js";
import { confirmAction } from "./confirm-state.js";
import { HostTaskControl } from "./host-execution.js";
import { TeamConnectionPicker } from "./team-connections.js";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Attempt, Checkpoint, Comment, Instruction, Task, TaskStatus } from "../src/collab/model.js";
import { useDialog } from "./app.js";
import { TRUST, ModelRow } from "./composer.js";
import { Icon } from "./icons.js";
import { apiPath, ApiError, enc, fmtSize, post, showToast, useLatest, usePoll } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { agents, agentSettings, patterns, repo, trust, limits, loadModels, type Trust } from "./state.js";
import type { AgentId, RoleSpec } from "./types.js";
import { ATTEMPT_LABEL, ATTEMPT_PILL, STALE_REVISION, STATUS_LABEL, STATUS_PILL, TASK_STATUSES, type Member, type TeamRoute, ago, attemptLive, attemptResumable, attemptSilent, attemptStale, board, busyAttempt, del, initials, latestCheckpoint, loadBoard, loadLocalAttempts, loadTask, loadTeamLink, localAttempts, openTask, ownerProblem, put, shortCommit, shownAttempt, teamLink, teamTick, transitionProblem, when, whoLabel } from "./collab-state.js";

const MENTION = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
/** `@username` of a project member as <strong>, like the hub resolves mentions (trailing punctuation forgiven); other @-text stays plain. */
export function withMentions(text: string, members: readonly Member[]): ComponentChildren[] {
  const byName = new Map(members.map((member) => [member.username.toLowerCase(), member] as const));
  const out: ComponentChildren[] = []; let last = 0;
  for (const match of text.matchAll(MENTION)) {
    let name = match[1]!.toLowerCase(); while (name && !byName.has(name) && /[._-]$/.test(name)) name = name.slice(0, -1);
    const member = byName.get(name); if (!member) continue;
    const start = match.index!, end = start + 1 + name.length;
    if (start > last) out.push(text.slice(last, start));
    out.push(<strong key={start} class="team-mention" title={member.displayName}>{text.slice(start, end)}</strong>); last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Runs one mutation with a busy label; resolves true when it went through, false when it was refused (a stale revision reloads the task with a toast; any other refusal is shown in the server's words, and a 401/403/404/409 reloads the task too, since it may mean the page is out of date), so a caller closes an editor or drops a draft only on success. */
type Act = (label: string, work: () => Promise<Task | void>, after?: () => void) => Promise<boolean>;
type Save = (patch: Record<string, unknown>, label?: string, revision?: number) => Promise<boolean>;

/**
 * One task: its fields, where it is executing, its checkpoints, reviews, discussion and decisions.
 * Every save carries the task's revision; a stale-revision 409 means a teammate saved first, so the page
 * reloads the task and keeps what you typed: editors stay open and drafts stay marked unsaved until a save
 * goes through. Local-runner controls need this computer and task ownership, except accepting a hand-over
 * offered to you, which needs only this computer; shared users get the separate host queue controls only
 * when the host owner grants execution.
 */
export function TeamTaskView({ id, shared = false, navigate }: { id: string; shared?: boolean; navigate: (to: TeamRoute) => void }) {
  const [task, setTask] = useState<Task | null>(null);
  // `loadError` is the page's (the task could not be read); `error` is the last refused action's, which a reload keeps until the next action.
  const [loadError, setLoadError] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(""), [now, setNow] = useState(Date.now());
  const [dialog, setDialog] = useState<"start" | "handover" | "accept" | "recover" | null>(null);
  /** The attempt the Recover dialog was opened for: the dialog stays open on it whatever its state becomes, so a refusal is read rather than unmounted with it. */
  const [recovering, setRecovering] = useState<Attempt | null>(null);
  const [fetching, setFetching] = useState<Checkpoint | null>(null);
  const begin = useLatest();
  const load = async () => { if (!shared && teamConnectionRequired.value) return; const current = begin(); try { const next = await loadTask(id); if (current()) { setTask(next); setLoadError(""); openTask.value = next; } } catch (err) { if (current()) { setTask(null); openTask.value = null; setDialog(null); setFetching(null); setLoadError((err as Error).message); } } };
  // The owner app polls as a fallback to its stream; the shared dashboard reloads only on /api/team/events frames (and when its tab is shown again), so an idle shared session can still expire. The liveness clock ticks on its own, without a request.
  usePoll(() => { void load(); void loadBoard(); if (!shared) { void loadTeamLink(); void loadLocalAttempts(); } setNow(Date.now()); }, shared ? 0 : 15_000, [id, teamTick.value, shared]);
  usePoll(() => setNow(Date.now()), 15_000, [], shared);
  useEffect(() => { (document.getElementById("main-content") ?? window).scrollTo({ top: 0 }); return () => { if (openTask.value?.id === id) openTask.value = null; }; }, [id]);
  const act: Act = async (label, work, after) => {
    if (busy) return false; setBusy(label); setError("");
    try { const next = await work(); if (next && typeof next === "object" && "id" in next) { setTask(next); openTask.value = next; } after?.(); return true; }
    catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === STALE_REVISION) { showToast("Task changed; reloading", 3000); await load(); return false; }
      // Shown in place, never as "the task is gone": a 404 may be this computer's (a run missing here) and a 409 a rule the server applied. The reload shows a task that really went away on its own.
      setError((err as Error).message);
      if (err instanceof ApiError && [401, 403, 404, 409].includes(err.status)) { await load(); if (err.status !== 409) void loadBoard(); }
      return false;
    }
    finally { setBusy(""); }
  };
  const b = board.value;
  if (!shared && teamConnectionRequired.value) return <div class="team-page"><TeamConnectionPicker /><p class="help" role="status">Choose a team connection to find this task.</p></div>;
  if (!task) return <div class="team-page">{!shared ? <TeamConnectionPicker /> : null}{loadError ? <p class="msg err" role="alert">{loadError} <button class="btn small" onClick={() => void load()}>Retry</button> <button class="btn small" onClick={() => navigate({ view: "team" })}>Back to the board</button></p> : <p class="help" role="status">Loading the task…</p>}</div>;
  const meId = b?.me.userId, project = b?.projects.find((entry) => entry.id === task.projectId), role = project?.role ?? (meId === "owner" ? "maintainer" : b?.me.roles[task.projectId]);
  const members: Member[] = project?.members ?? [];
  const canEdit = roleAtLeast(role, "contributor"), canComment = roleAtLeast(role, "reviewer"), maintainer = roleAtLeast(role, "maintainer");
  const isOwner = !!meId && task.owner?.userId === meId;
  const attempt = shownAttempt(task), running = busyAttempt(task), checkpoint = latestCheckpoint(task);
  const offered = task.handoff?.state === "offered" ? task.handoff : undefined, offeredToMe = !!offered && offered.to.userId === meId, offeredByMe = !!offered && offered.from.userId === meId;
  const link = teamLink.value;
  /** This computer can act for you: the owner app with its link API answering (linked to a hub, or this instance being the hub). Accepting a hand-over needs only this; everything else that executes also needs the task to be yours. */
  const onThisComputer = !shared && link !== null, canExecute = onThisComputer && isOwner;
  const local = attempt ? localAttempts.value.find((entry) => entry.attemptId === attempt.id) : undefined;
  /** This computer still has the attempt's run (the link API reports a status only while the run exists here): Stop needs it running, Resume needs it ended; a paused or stopped attempt from another computer, or one whose run is gone, is started anew instead. */
  const hasRun = !!local?.runId && !!local.runStatus;
  const resumable = !!attempt && hasRun && local!.runStatus !== "running" && attemptResumable(attempt, task);
  const save: Save = (patch, label = "Saving…", revision = task.revision) => act(label, () => put<Task>(`/api/team/tasks/${enc(id)}`, { ...patch, revision }));
  const respond = (action: "decline" | "cancel") => offered && act(action === "decline" ? "Declining…" : "Cancelling…", () => post<Task>(`/api/team/tasks/${enc(id)}/handoff/${enc(offered.id)}`, { action, revision: task.revision }), () => showToast(action === "decline" ? "Hand-over declined" : "Hand-over cancelled"));
  const link_ = (path: string, body: unknown, label: string, done: string) => act(label, async () => { await post(`/api/team-link/tasks/${enc(id)}${path}`, body); }, () => { showToast(done); void load(); void loadLocalAttempts(); });
  const stale = attempt ? attemptStale(attempt, now) : false, live = attempt ? attemptLive(attempt, now) : false;
  const canRecover = stale && ((isOwner && canEdit) || maintainer);
  return <div class="team-page team-task">
    {!shared ? <TeamConnectionPicker /> : null}
    <nav class="team-back" aria-label="Team board"><a href={shared ? "#/team" : `#/team/project/${enc(task.projectId)}`} onClick={(event) => { event.preventDefault(); navigate({ view: "team", project: task.projectId }); }}><Icon name="chevron" class="back" /> {project?.name ?? "Team board"}</a></nav>
    <TaskHeader task={task} role={role} meId={meId} members={members} canEdit={canEdit} maintainer={maintainer} busy={busy} now={now} save={save} act={act} navigate={navigate} />
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p class="help" role="status">{busy}</p> : null}
    <div class="team-task-layout">
      <div class="team-main">
        <TaskText task={task} canEdit={canEdit} busy={busy} save={save} />
        <section class="team-section" aria-labelledby="tt-exec">
          <h2 id="tt-exec">Execution</h2>
          {attempt ? <AttemptDetails attempt={attempt} meId={meId} live={live} now={now} canRecover={canRecover} /> : <p class="help">No attempt yet.{task.owner ? "" : " Take the task to run it on your computer."}</p>}
          <div class="team-actions">
            {hasRun ? <a class="btn small" href={`#/run/${enc(local!.runId!)}`}>Open run</a> : null}
            {onThisComputer && offeredToMe ? <><button type="button" class="btn small primary" disabled={!!busy} onClick={() => setDialog("accept")}>Accept and download</button><button type="button" class="btn small" disabled={!!busy} onClick={() => void respond("decline")}>Decline</button></> : null}
            {canExecute ? <>
              {!offered && !running && task.status !== "done" ? <button type="button" class="btn small primary" disabled={!!busy} onClick={() => setDialog("start")}>Build with agents</button> : null}
              {running && local?.runStatus === "running" ? <button type="button" class="btn small" disabled={!!busy} onClick={async () => { if (await confirmAction("Stop the attempt running on this computer? Its run can be resumed later and its work is kept.", {"title":"Stop this attempt?","confirmLabel":"Stop attempt","danger":true})) void link_("/stop", {}, "Stopping…", "Attempt stopped"); }}>Stop</button> : null}
              {resumable ? <button type="button" class="btn small" disabled={!!busy} onClick={() => void link_("/resume", {}, "Resuming…", "Attempt resumed")}>Resume</button> : null}
              {!offered && !running ? <button type="button" class="btn small" disabled={!!busy} onClick={() => setDialog("handover")}>Hand over…</button> : null}
            </> : null}
            {attempt && canRecover ? <button type="button" class="btn small" disabled={!!busy} onClick={() => { setRecovering(attempt); setDialog("recover"); }}>Recover attempt…</button> : null}
            {offeredToMe && !onThisComputer ? <button type="button" class="btn small" disabled={!!busy} onClick={() => void respond("decline")}>Decline hand-over</button> : null}
            {offered && (offeredByMe || maintainer) ? <button type="button" class="btn small" disabled={!!busy} onClick={async () => { if (await confirmAction("Cancel this hand-over? The task stays with its current owner.", {"title":"Cancel hand-over?","confirmLabel":"Cancel hand-over","danger":true})) void respond("cancel"); }}>Cancel hand-over</button> : null}
            {!task.owner && canEdit && meId ? <button type="button" class="btn small" disabled={!!busy || !!ownerProblem(task, role, meId, now)} title={ownerProblem(task, role, meId, now)} onClick={() => void save({ owner: meId }, "Taking the task…")}>Take this task</button> : null}
          </div>
          {offered ? <p class="msg warn" role="status">Hand-over offered to {whoLabel(offered.to, meId)} by {whoLabel(offered.from, meId)} {ago(offered.offeredAt)}{offered.note ? `: ${offered.note}` : ""}</p> : null}
          {offeredToMe && !onThisComputer ? <p class="help">To accept, open this task in code-flow on your own computer, connected to this team, and choose Accept and download: the checkpoint is imported into your clone before the task becomes yours.</p> : null}
          {shared && canEdit ? <HostTaskControl key={task.id} task={task} meId={meId} projectName={project?.name} /> : null}
          {!shared && isOwner && link === null ? <p class="help">This computer's team link is not available here, so the task cannot be run from this page.</p> : null}
        </section>
        <CheckpointsCard task={task} latest={checkpoint} meId={meId} canEdit={canEdit} maintainer={maintainer} shared={shared} busy={busy} act={act} onFetch={setFetching} reload={load} />
        <ReviewsCard task={task} latest={checkpoint} meId={meId} members={members} canEdit={canEdit} canComment={canComment} busy={busy} act={act} />
        <DiscussionCard task={task} meId={meId} members={members} canEdit={canEdit} canComment={canComment} isOwner={isOwner} maintainer={maintainer} busy={busy} act={act} />
      </div>
      <div class="team-aside">
        <TaskFields task={task} role={role} meId={meId} members={members} canEdit={canEdit} busy={busy} now={now} save={save} />
        <DecisionsCard task={task} canEdit={canEdit} busy={busy} act={act} />
        <details class="team-section team-history"><summary>History <span class="team-count">{task.audit.length}</span></summary><ol>{task.audit.slice().reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><span class="th-when">{when(entry.at)}</span> <strong>{entry.by.displayName}</strong> {entry.action}{entry.detail ? <span class="th-detail"> — {entry.detail}</span> : null}</li>)}</ol></details>
      </div>
    </div>
    {dialog === "start" ? <StartDialog task={task} checkpoint={checkpoint} onClose={() => setDialog(null)} onStarted={() => { setDialog(null); showToast("Agents started on this computer"); void load(); void loadLocalAttempts(); }} /> : null}
    {dialog === "handover" && meId ? <HandoverDialog task={task} meId={meId} members={members} onClose={() => setDialog(null)} onDone={() => { setDialog(null); showToast("Hand-over offered"); void load(); }} /> : null}
    {dialog === "recover" && recovering ? <RecoverDialog task={task} attempt={task.attempts.find((entry) => entry.id === recovering.id) ?? recovering} onClose={() => { setDialog(null); setRecovering(null); }} onRefused={load} onDone={() => { setDialog(null); setRecovering(null); showToast("Attempt recovered"); void load(); void loadLocalAttempts(); }} /> : null}
    {dialog === "accept" && offered ? <RepoPathDialog title="Accept and download" help={`The checkpoint is downloaded into your clone of ${task.repository} before the task becomes yours; a failed download changes nothing.`} action="Accept and download" initial={link?.mappings[task.projectId]?.[task.repository] ?? ""} onClose={() => setDialog(null)} submit={async (path) => { await post(`/api/team-link/tasks/${enc(id)}/accept`, { handoffId: offered.id, ...(path ? { repo: path } : {}) }); setDialog(null); showToast("Hand-over accepted"); void load(); }} /> : null}
    {fetching ? <RepoPathDialog title="Fetch to this computer" help={`Imports checkpoint ${shortCommit(fetching.commit)} into the repository below as a branch; nothing is checked out.`} action="Fetch" initial={link?.mappings[task.projectId]?.[task.repository] ?? ""} required onClose={() => setFetching(null)} submit={async (path) => { const result = await post<{ commit: string; branch: string }>(`/api/team-link/checkpoints/${enc(fetching.id)}/fetch`, { repo: path }); setFetching(null); showToast(`Fetched as branch ${result.branch}`, 5000); }} /> : null}
  </div>;
}

function TaskHeader({ task, role, meId, members, canEdit, maintainer, busy, now, save, act, navigate }: { task: Task; role: ReturnType<typeof roleOf>; meId?: string; members: Member[]; canEdit: boolean; maintainer: boolean; busy: string; now: number; save: Save; act: Act; navigate: (to: TeamRoute) => void }) {
  const [editing, setEditing] = useState(false), [blocking, setBlocking] = useState(false);
  const titleDraft = useTaskEditDraft(task.title, task.revision), blockerDraft = useTaskEditDraft(task.blocker ?? "", task.revision, JSON.stringify([task.status, task.blocker]));
  const title = titleDraft.text, setTitle = titleDraft.edit, blocker = blockerDraft.text, setBlocker = blockerDraft.edit;
  const saveTitle = async (revision = titleDraft.revision) => { if (await save({ title: title.trim() }, undefined, revision)) { titleDraft.accepted(); setEditing(false); } };
  const saveBlocker = async (revision = blockerDraft.revision) => { if (await save({ status: "blocked", blocker: blocker.trim() }, undefined, revision)) { blockerDraft.accepted(); setBlocking(false); } };
  const doneProblem = transitionProblem(task, "done", role, undefined, now);
  const problemFor = (to: TaskStatus) => to === "blocked" ? transitionProblem(task, "blocked", role, "pending", now) : transitionProblem(task, to, role, undefined, now);
  return <div class="page-head team-task-head">
    <div class="page-head-text">
      {editing ? <form class="team-title-edit" onSubmit={(event) => { event.preventDefault(); if (titleDraft.conflict) return; if (title.trim() && title.trim() !== task.title) void saveTitle(); else setEditing(false); }}><label class="sr-only" for="tt-title">Title</label><input id="tt-title" class="field" required maxLength={200} value={title} disabled={!!busy} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { setEditing(false); setTitle(task.title); } }} /><button type="submit" class="btn small primary" disabled={!!busy || !title.trim() || titleDraft.conflict}>Save</button><button type="button" class="btn small" onClick={() => { setEditing(false); setTitle(task.title); }}>Cancel</button></form>
        : <h1>{task.title}{canEdit ? <button type="button" class="icon-btn team-edit" aria-label="Edit the title" title="Edit the title" disabled={!!busy} onClick={() => { titleDraft.reset(); setEditing(true); }}><Icon name="note" /></button> : null}</h1>}
      {editing && titleDraft.conflict ? <DraftConflict label="Title" latest={task.title} onUse={titleDraft.reset} onReplace={() => void saveTitle(task.revision)} busy={!!busy} /> : null}
      <p class="team-task-meta"><span class={`status-pill ${STATUS_PILL[task.status]}`}>{STATUS_LABEL[task.status]}</span><code>{task.repository}</code>{task.baseRef ? <span>base <code>{task.baseRef}</code></span> : null}<span>{task.owner ? <>Owned by {whoLabel(task.owner, meId)}</> : "Unassigned"}</span>{task.reviewer ? <span>Reviewed by {whoLabel(task.reviewer, meId)}</span> : null}<span>Updated {ago(task.updatedAt)}</span>{task.labels.map((label) => <span key={label} class="badge">{label}</span>)}</p>
      {task.status === "blocked" && task.blocker ? <p class="msg warn" role="status"><strong>Blocked:</strong> {task.blocker}</p> : null}
    </div>
    <div class="page-head-actions">
      {canEdit ? <label class="team-status">Status<select class="field" value={task.status} disabled={!canEdit || !!busy} onChange={(event) => { const to = event.currentTarget.value as TaskStatus; if (to === "blocked") { blockerDraft.reset(); setBlocking(true); return; } void save({ status: to }); }}>{TASK_STATUSES.map((state) => { const problem = state === task.status ? undefined : problemFor(state); return <option key={state} value={state} disabled={!!problem} title={problem}>{STATUS_LABEL[state]}</option>; })}</select></label> : null}
      {maintainer ? <button type="button" class="btn small danger" disabled={!!busy} onClick={async () => { if (await confirmAction("Delete this task, its checkpoints and its discussion? This cannot be undone.", {"title":"Delete this task?","confirmLabel":"Delete task","danger":true})) void act("Deleting…", async () => { await del(`/api/team/tasks/${enc(task.id)}`, { revision: task.revision }); }, () => { showToast("Task deleted"); navigate({ view: "team", project: task.projectId }); }); }}>Delete task</button> : null}
      {canEdit && doneProblem && task.status !== "done" ? <p class="help">Done is unavailable: {doneProblem}.</p> : null}
      {blocking ? <form class="team-blocker" onSubmit={(event) => { event.preventDefault(); if (blocker.trim() && !blockerDraft.conflict) void saveBlocker(); }}><label for="tt-blocker">What blocks the task?</label><textarea id="tt-blocker" class="field" rows={2} required maxLength={1000} value={blocker} disabled={!!busy} onInput={(event) => setBlocker(event.currentTarget.value)} /><div class="team-actions"><button type="submit" class="btn small primary" disabled={!!busy || !blocker.trim() || blockerDraft.conflict}>Mark blocked</button><button type="button" class="btn small" onClick={() => setBlocking(false)}>Cancel</button></div>{blockerDraft.conflict ? <DraftConflict label="Blocker" latest={`${STATUS_LABEL[task.status]}: ${task.blocker ?? "(empty)"}`} onUse={blockerDraft.reset} onReplace={() => void saveBlocker(task.revision)} busy={!!busy} /> : null}</form> : null}
    </div>
  </div>;
}
const roleOf = (members: Member[], userId?: string) => members.find((member) => member.userId === userId)?.role;

/** A conflict shows the current saved text; replacing it is an explicit, revision-checked action. */
function DraftConflict({ label, latest, onUse, onReplace, busy }: { label: string; latest: string; onUse: () => void; onReplace: () => void; busy: boolean }) {
  return <div class="task-edit-conflict msg warn" role="alert"><p>{label} changed while you were editing. Your draft is kept. Current saved text:</p><pre class="team-prose">{latest || "(empty)"}</pre><div class="team-actions"><button type="button" class="btn small" disabled={busy} onClick={onUse}>Use saved {label.toLowerCase()}</button><button type="button" class="btn small" disabled={busy} onClick={async () => { if (await confirmAction(`Replace the saved ${label.toLowerCase()} with your draft?`, { title: "Replace teammate’s text?", confirmLabel: "Replace saved text" })) onReplace(); }}>Replace saved {label.toLowerCase()}</button></div></div>;
}
function TaskTextField({ task, name, label, max, canEdit, busy, save }: { task: Task; name: "goal" | "acceptance"; label: string; max: number; canEdit: boolean; busy: string; save: Save }) {
  const draft = useTaskEditDraft(task[name], task.revision), id = `tt-${name}`;
  const submit = async (revision = draft.revision) => { if (await save({ [name]: draft.text }, undefined, revision)) draft.accepted(); };
  return <div class="team-text"><label for={id}>{label}</label>{canEdit ? <>
    <textarea id={id} class="field" rows={draft.text.split("\n").length > 4 ? 8 : 4} maxLength={max} value={draft.text} disabled={!!busy} onInput={event => draft.edit(event.currentTarget.value)} />
    {draft.dirty ? <div class="team-actions"><button type="button" class="btn small primary" disabled={!!busy || draft.conflict} onClick={() => void submit()}>Save {label.toLowerCase()}</button><button type="button" class="btn small" disabled={!!busy} onClick={draft.reset}>Discard</button><span class="help">Unsaved changes</span></div> : null}
    {draft.conflict ? <DraftConflict label={label} latest={task[name]} onUse={draft.reset} onReplace={() => void submit(task.revision)} busy={!!busy} /> : null}
  </> : task[name] ? <p id={id} class="team-prose">{task[name]}</p> : <p id={id} class="help">Not written yet.</p>}</div>;
}
function TaskText({ task, canEdit, busy, save }: { task: Task; canEdit: boolean; busy: string; save: Save }) {
  return <section class="team-section" aria-labelledby="tt-text"><h2 id="tt-text">Goal and acceptance</h2><TaskTextField task={task} name="goal" label="Goal" max={16384} canEdit={canEdit} busy={busy} save={save} /><TaskTextField task={task} name="acceptance" label="Acceptance criteria" max={8192} canEdit={canEdit} busy={busy} save={save} /></section>;
}

/**
 * "Connection lost" (claimed or running, silent for 90 s) and "Status unknown" (recorded so by the hub or by the runner,
 * with a reason) both keep the task reserved, and both may be recovered once someone confirmed the agent stopped. Only the
 * first is still waiting for the runner to speak again, so only that one says so; an unknown attempt shows its reason
 * instead of a "last heard" time, which is when the runner reported it unknown.
 */
function AttemptDetails({ attempt, meId, live, now, canRecover }: { attempt: Attempt; meId?: string; live: boolean; now: number; canRecover: boolean }) {
  const p = attempt.progress, silent = attemptSilent(attempt, now), unknown = attempt.state === "unknown";
  const recover = canRecover ? "If you have confirmed that its agent has stopped (for example, the computer is shut down), choose Recover attempt… to release the task." : "The task owner or a project maintainer can recover it after confirming that its agent has stopped.";
  return <>
    <p class="team-task-meta"><span class={`status-pill ${silent ? "failing" : ATTEMPT_PILL[attempt.state]}`}>{silent ? "Connection lost" : ATTEMPT_LABEL[attempt.state]}</span><span>on <strong>{attempt.runnerName}</strong> by {whoLabel(attempt.user, meId)}</span>{live ? <span class="team-live"><span class="dot running" aria-hidden="true" />Live · heard {ago(attempt.lastHeartbeatAt)}</span> : unknown ? null : <span>Last heard {ago(attempt.lastHeartbeatAt)}</span>}</p>
    {silent ? <p class="msg warn" role="status">Connection lost: {attempt.runnerName} has not reported for over 90 seconds, so its execution status is unknown. This task stays reserved until the runner reconnects and reports its state. {recover}</p> : null}
    {unknown ? <p class="msg warn" role="status">Execution status unknown{attempt.reason ? `: ${attempt.reason}` : ""}. This task stays reserved, so no second agent starts on it. {recover}</p> : null}
    <dl class="team-kv">
      {p.stage ? <><dt>Stage</dt><dd>{p.stage}</dd></> : null}
      {p.steps ? <><dt>Steps</dt><dd>{p.steps.done}{p.steps.total !== undefined ? ` of ${p.steps.total}` : ""}</dd></> : null}
      {p.runStatus || p.verdict ? <><dt>Run</dt><dd>{p.runStatus ?? ""}{p.verdict ? `${p.runStatus ? " · " : ""}check ${p.verdict}` : ""}</dd></> : null}
      {p.tests ? <><dt>Tests</dt><dd><span class={`badge ${p.tests.ok ? "ok" : "warn"}`}>{p.tests.ok ? "Passing" : "Failing"}</span> <code>{p.tests.command}</code> · {ago(p.tests.at)}</dd></> : null}
      {p.branch || attempt.branch ? <><dt>Branch</dt><dd><code>{p.branch ?? attempt.branch}</code>{p.head ?? attempt.head ? <> at <code>{shortCommit(p.head ?? attempt.head!)}</code></> : null}</dd></> : null}
      <dt>Base</dt><dd><code>{shortCommit(attempt.baseCommit)}</code>{attempt.fromCheckpointId ? " · continued from a checkpoint" : ""}</dd>
      <dt>Started</dt><dd>{when(attempt.startedAt ?? attempt.createdAt)}{attempt.endedAt ? ` · ended ${ago(attempt.endedAt)}` : ""}</dd>
      {attempt.reason && !unknown ? <><dt>Reason</dt><dd>{attempt.reason}</dd></> : null}
    </dl>
    {p.summary ? <pre class="team-prose">{p.summary}</pre> : null}
    {p.blockers?.length ? <div class="msg warn" role="status"><strong>Blockers</strong><ul class="team-list">{p.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    {p.changedFiles?.length ? <details class="team-files"><summary>{p.changedFiles.length} changed file{p.changedFiles.length === 1 ? "" : "s"}</summary><ul class="team-list mono">{p.changedFiles.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
  </>;
}

/** The editable fields a card does not show: people, repository, base, labels and dependencies; each saves on change. */
function TaskFields({ task, role, meId, members, canEdit, busy, now, save }: { task: Task; role: ReturnType<typeof roleOf>; meId?: string; members: Member[]; canEdit: boolean; busy: string; now: number; save: Save }) {
  const b = board.value, project = b?.projects.find((entry) => entry.id === task.projectId);
  const maintainer = roleAtLeast(role, "maintainer");
  const owners = members.filter((member) => roleAtLeast(member.role, "contributor") && (maintainer || member.userId === meId));
  if (task.owner && !owners.some((member) => member.userId === task.owner!.userId)) owners.unshift({ userId: task.owner.userId, username: task.owner.userId, displayName: task.owner.displayName, role: "contributor", online: false });
  const reviewers = members.filter(member => roleAtLeast(member.role, "reviewer") && member.userId !== task.owner?.userId && member.userId !== latestCheckpoint(task)?.createdBy.userId);
  const others = (b?.tasks ?? []).filter((entry) => entry.projectId === task.projectId && entry.id !== task.id);
  const ownerIssue = ownerProblem(task, role, meId, now);
  const [baseRef, setBaseRef] = useState(task.baseRef ?? ""), [labels, setLabels] = useState(task.labels.join(", "));
  useEffect(() => setBaseRef(task.baseRef ?? ""), [task.baseRef]); useEffect(() => setLabels(task.labels.join(", ")), [task.labels.join(", ")]);
  // The multi-select's options carry `selected`, which Preact only writes when the prop changes, so a refused save would leave the clicked option selected for good; remounting the select (its key) snaps it back to the task like the other fields.
  const [dependsReset, setDependsReset] = useState(0), dependsKey = `${task.dependsOn.join(",")}:${dependsReset}`;
  const disabled = !canEdit || !!busy;
  return <section class="team-section" aria-labelledby="tt-fields"><h2 id="tt-fields">Details</h2>
    {!canEdit ? <><p class="help">Read only. A project contributor role is needed to edit these details.</p><dl class="team-kv"><dt>Owner</dt><dd>{task.owner?.displayName ?? "Unassigned"}</dd><dt>Reviewer</dt><dd>{task.reviewer?.displayName ?? "None"}</dd><dt>Repository</dt><dd>{project?.repositories.find(entry => entry.key === task.repository)?.label ?? task.repository} ({task.repository})</dd><dt>Base branch</dt><dd>{task.baseRef ?? "Repository default"}</dd><dt>Labels</dt><dd>{task.labels.join(", ") || "None"}</dd><dt>Collaborators</dt><dd>{task.collaborators.map(who => who.displayName).join(", ") || "None"}</dd></dl></> : <div class="team-fields column">
      <label>Owner<select class="field" value={task.owner?.userId ?? ""} disabled={disabled || !!ownerIssue} title={ownerIssue} onChange={(event) => void save({ owner: event.currentTarget.value || null })}><option value="">Unassigned</option>{owners.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select>{ownerIssue && canEdit ? <span class="help">{ownerIssue}</span> : null}</label>
      <label>Reviewer<select class="field" value={task.reviewer?.userId ?? ""} disabled={disabled} onChange={(event) => void save({ reviewer: event.currentTarget.value || null })}><option value="">None</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
      <label>Repository<select class="field" value={task.repository} disabled={disabled} onChange={(event) => void save({ repository: event.currentTarget.value })}>{!project?.repositories.some((entry) => entry.key === task.repository) ? <option value={task.repository}>{task.repository}</option> : null}{project?.repositories.map((entry) => <option key={entry.key} value={entry.key}>{entry.label} ({entry.key})</option>)}</select></label>
      <label>Base branch<input class="field" maxLength={100} value={baseRef} disabled={disabled} placeholder="The repository's default branch" onInput={(event) => setBaseRef(event.currentTarget.value)} onBlur={() => { if (baseRef.trim() !== (task.baseRef ?? "")) void save({ baseRef: baseRef.trim() || null }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      <label>Labels<input class="field" maxLength={450} value={labels} disabled={disabled} placeholder="Comma-separated, up to 10" onInput={(event) => setLabels(event.currentTarget.value)} onBlur={() => { const next = [...new Set(labels.split(",").map((label) => label.trim()).filter(Boolean))].slice(0, 10); if (next.join(", ") !== task.labels.join(", ")) void save({ labels: next }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      {members.length ? <fieldset class="team-checks" disabled={disabled}><legend>Collaborators</legend>{members.filter((member) => member.userId !== task.owner?.userId).map((member) => <label key={member.userId} class="check"><input type="checkbox" checked={task.collaborators.some((who) => who.userId === member.userId)} onChange={(event) => { const ids = task.collaborators.map((who) => who.userId).filter((userId) => userId !== member.userId); if (event.currentTarget.checked) ids.push(member.userId); void save({ collaborators: ids.slice(0, 20) }); }} /> {member.userId === meId ? `${member.displayName} (you)` : member.displayName}</label>)}</fieldset> : null}
      {others.length ? <label>Depends on<select key={dependsKey} class="field" multiple size={Math.min(5, Math.max(2, others.length))} disabled={disabled} onChange={(event) => void save({ dependsOn: [...event.currentTarget.selectedOptions].map((option) => option.value).slice(0, 20) }).then((saved) => { if (!saved) setDependsReset((count) => count + 1); })}>{others.map((entry) => <option key={entry.id} value={entry.id} selected={task.dependsOn.includes(entry.id)}>{entry.title} · {STATUS_LABEL[entry.status]}</option>)}</select></label> : null}
    </div>}
    <dl class="team-kv"><dt>Created</dt><dd>{when(task.createdAt)} by {task.createdBy.displayName}</dd><dt>Project</dt><dd>{project?.name ?? task.projectId}</dd>{task.dependsOn.length ? <><dt>Depends on</dt><dd>{task.dependsOn.map((depId) => others.find((entry) => entry.id === depId)?.title ?? depId).join(", ")}</dd></> : null}</dl>
  </section>;
}

function CheckpointsCard({ task, latest, meId, canEdit, maintainer, shared, busy, act, onFetch, reload }: { task: Task; latest?: Checkpoint; meId?: string; canEdit: boolean; maintainer: boolean; shared: boolean; busy: string; act: Act; onFetch: (checkpoint: Checkpoint) => void; reload: () => Promise<void> }) {
  const list = task.checkpoints.slice().sort((x, y) => y.at - x.at);
  return <section class="team-section" aria-labelledby="tt-checkpoints"><h2 id="tt-checkpoints">Checkpoints<span class="team-count">{list.length}</span></h2>
    {!list.length ? <p class="help">None yet. An attempt publishes a checkpoint (a Git bundle of its commits plus the context the next agent needs) when it finishes or is handed over.</p> : null}
    {list.map((checkpoint) => <article key={checkpoint.id} class="team-item">
      <div class="team-task-meta"><code>{shortCommit(checkpoint.commit)}</code><code>{checkpoint.branch}</code><span>{fmtSize(checkpoint.size)}</span><span>by {whoLabel(checkpoint.createdBy, meId)}</span><span>{ago(checkpoint.at)}</span>{checkpoint === latest ? <span class="badge ok">Latest</span> : null}{checkpoint.bundle === "pending" ? <span class="badge warn">Uploading</span> : checkpoint.bundle === "deleted" ? <span class="badge warn">Bundle deleted</span> : null}{checkpoint.testResults ? <span class={`badge ${checkpoint.testResults.ok ? "ok" : "warn"}`}>Tests {checkpoint.testResults.ok ? "passing" : "failing"}</span> : null}</div>
      {/* A hand-over note belongs to the offer that was accepted, not to the checkpoint: a manifest written by an older code-flow may carry the note of a refused or declined offer, meant for someone else. */}
      {task.handoffs.filter((handoff) => handoff.state === "accepted" && handoff.checkpointId === checkpoint.id && handoff.note.trim()).map((handoff) => <p key={handoff.id} class="team-comment-text">Hand-over note from {whoLabel(handoff.from, meId)}: {handoff.note}</p>)}
      {checkpoint.remaining ? <details><summary>Remaining work</summary><pre class="team-prose">{checkpoint.remaining}</pre></details> : null}
      {checkpoint.changedFiles.length ? <details><summary>{checkpoint.changedFiles.length} changed file{checkpoint.changedFiles.length === 1 ? "" : "s"}</summary><ul class="team-list mono">{checkpoint.changedFiles.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
      <div class="team-actions">
        {!shared && canEdit && checkpoint.bundle === "available" ? <button type="button" class="btn small" disabled={!!busy} onClick={() => onFetch(checkpoint)}>Fetch to this computer…</button> : null}
        {canEdit && checkpoint.bundle === "available" ? <a class="btn small" href={apiPath(`/api/team/checkpoints/${enc(checkpoint.id)}/bundle`)} download={`checkpoint-${checkpoint.id.slice(0, 8)}.bundle`}>Download bundle</a> : null}
        {maintainer && checkpoint.bundle !== "deleted" ? <button type="button" class="btn small danger" disabled={!!busy} onClick={async () => { if (await confirmAction("Delete this checkpoint's bundle? Teammates can no longer download or continue from it.", {"title":"Delete checkpoint bundle?","confirmLabel":"Delete bundle","danger":true})) void act("Deleting…", async () => { await del(`/api/team/checkpoints/${enc(checkpoint.id)}`); }, () => void reload()); }}>Delete</button> : null}
      </div>
    </article>)}
  </section>;
}

function ReviewsCard({ task, latest, meId, members, canEdit, canComment, busy, act }: { task: Task; latest?: Checkpoint; meId?: string; members: Member[]; canEdit: boolean; canComment: boolean; busy: string; act: Act }) {
  const [reviewer, setReviewer] = useState(task.reviewer?.userId ?? ""), [verdict, setVerdict] = useState<"approve" | "request-changes">("approve"), [text, setText] = useState("");
  const reviewers = members.filter(member => roleAtLeast(member.role, "reviewer") && member.userId !== task.owner?.userId && member.userId !== latestCheckpoint(task)?.createdBy.userId);
  const reviews = task.reviews.slice().sort((x, y) => y.at - x.at);
  const current = latest ? reviews.filter((review) => review.checkpointId === latest.id && !review.stale && !selfReview(task, review))[0] : undefined;
  return <section class="team-section" aria-labelledby="tt-reviews"><h2 id="tt-reviews">Reviews{current ? <span class={`badge ${current.verdict === "approve" ? "ok" : "warn"}`}>{current.verdict === "approve" ? "Approved" : "Changes requested"}</span> : task.reviewer && latest ? <span class="badge">Pending</span> : null}</h2>
    {canEdit ? <form class="team-inline" onSubmit={(event) => { event.preventDefault(); if (reviewer) void act("Requesting a review…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/review-request`, { reviewer, revision: task.revision }), () => showToast("Review requested")); }}><label>Request a review from<select class="field" value={reviewer} disabled={!!busy} onChange={(event) => setReviewer(event.currentTarget.value)}><option value="">Choose a reviewer</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label><button type="submit" class="btn small" disabled={!!busy || !reviewers.some(member => member.userId === reviewer)}>Request review</button></form> : null}
    {canComment && latest && meId !== task.owner?.userId && meId !== latest.createdBy.userId ? <form class="team-review-form" onSubmit={(event) => { event.preventDefault(); void act("Recording the review…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/reviews`, { checkpointId: latest.id, verdict, text, revision: task.revision }), () => { setText(""); showToast("Review recorded"); }); }}>
      <fieldset disabled={!!busy}><legend>Record a review of checkpoint <code>{shortCommit(latest.commit)}</code></legend><label class="check"><input type="radio" name="tt-verdict" value="approve" checked={verdict === "approve"} onChange={() => setVerdict("approve")} /> Approve</label><label class="check"><input type="radio" name="tt-verdict" value="request-changes" checked={verdict === "request-changes"} onChange={() => setVerdict("request-changes")} /> Request changes</label></fieldset>
      <label for="tt-review-text">Review notes</label><textarea id="tt-review-text" class="field" rows={3} maxLength={4000} value={text} disabled={!!busy} onInput={(event) => setText(event.currentTarget.value)} />
      <div class="team-actions"><button type="submit" class="btn small primary" disabled={!!busy || (verdict === "request-changes" && !text.trim())}>Record review</button></div>
    </form> : canComment ? <p class="help">{latest ? "Your own task or checkpoint needs a teammate’s review." : "Reviews attach to a checkpoint; this task has none yet."}</p> : null}
    {reviews.map((review) => <article key={review.id} class="team-item"><div class="team-task-meta"><span class={`badge ${review.verdict === "approve" ? "ok" : "warn"}`}>{review.verdict === "approve" ? "Approved" : "Changes requested"}</span><span>by {whoLabel(review.by, meId)}</span><code>{shortCommit(review.commit)}</code><span>{ago(review.at)}</span>{selfReview(task, review) ? <span class="badge warn">Self-review · does not count as independent approval</span> : null}{review.stale ? <span class="badge">Stale · a newer checkpoint exists</span> : null}</div>{review.text ? <p class="team-comment-text">{review.text}</p> : null}</article>)}
    {!reviews.length ? <p class="help">No reviews recorded.</p> : null}
  </section>;
}

const INSTRUCTION_LABEL: Record<Instruction["state"], string> = { proposed: "Proposed", approved: "Approved", declined: "Declined", delivered: "Delivered to the agent" };
type Entry = { kind: "comment"; at: number; comment: Comment } | { kind: "instruction"; at: number; instruction: Instruction };
/** Comments and "Send to agent" instructions in one timeline: an instruction is a message for the running agent that the task owner approves first. */
function DiscussionCard({ task, meId, members, canEdit, canComment, isOwner, maintainer, busy, act }: { task: Task; meId?: string; members: Member[]; canEdit: boolean; canComment: boolean; isOwner: boolean; maintainer: boolean; busy: string; act: Act }) {
  const [text, setText] = useState(""), [toAgent, setToAgent] = useState(false);
  const entries: Entry[] = [...task.discussion.map((comment): Entry => ({ kind: "comment", at: comment.at, comment })), ...task.instructions.map((instruction): Entry => ({ kind: "instruction", at: instruction.at, instruction }))].sort((x, y) => x.at - y.at);
  const decide = (instruction: Instruction, action: "approve" | "decline") => act(action === "approve" ? "Approving…" : "Declining…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/instructions/${enc(instruction.id)}`, { action }));
  return <section class="team-section" aria-labelledby="tt-discussion"><h2 id="tt-discussion">Discussion<span class="team-count">{entries.length}</span></h2>
    <div class="team-timeline">
      {!entries.length ? <p class="help">No comments yet. Mention a teammate with @username to notify them.</p> : null}
      {entries.map((entry) => entry.kind === "comment" ? <article key={entry.comment.id} class={`team-comment ${entry.comment.kind}`}>
        <div class="team-comment-head"><span class="team-avatar" aria-hidden="true">{initials(entry.comment.by.displayName)}</span><strong>{whoLabel(entry.comment.by, meId)}</strong>{entry.comment.kind === "system" ? <span class="badge">System</span> : entry.comment.kind === "review-request" ? <span class="badge">Review request</span> : null}<span>{ago(entry.comment.at)}</span></div>
        <p class="team-comment-text">{withMentions(entry.comment.text, members)}</p>
      </article> : <article key={entry.instruction.id} class={`team-comment instruction ${entry.instruction.state}`}>
        <div class="team-comment-head"><span class="team-avatar" aria-hidden="true">{initials(entry.instruction.by.displayName)}</span><strong>{whoLabel(entry.instruction.by, meId)}</strong><span class={`badge ${entry.instruction.state === "declined" ? "warn" : entry.instruction.state === "proposed" ? "" : "ok"}`}>Send to agent · {INSTRUCTION_LABEL[entry.instruction.state]}</span><span>{ago(entry.instruction.at)}</span>{entry.instruction.decidedBy ? <span>{entry.instruction.state === "declined" ? "declined" : "approved"} by {whoLabel(entry.instruction.decidedBy, meId)}</span> : null}</div>
        <p class="team-comment-text">{withMentions(entry.instruction.text, members)}</p>
        {entry.instruction.state === "proposed" && ((isOwner && canEdit) || maintainer) ? <div class="team-actions"><button type="button" class="btn small primary" disabled={!!busy} onClick={() => void decide(entry.instruction, "approve")}>Approve</button><button type="button" class="btn small" disabled={!!busy} onClick={() => void decide(entry.instruction, "decline")}>Decline</button></div> : null}
      </article>)}
    </div>
    {canComment ? <form class="team-composer" onSubmit={(event) => { event.preventDefault(); const body = text.trim(); if (!body) return; void act(toAgent ? "Sending to the agent…" : "Posting…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/${toAgent ? "instructions" : "comments"}`, { text: body }), () => { setText(""); if (toAgent) showToast(isOwner ? "Instruction approved; the agent receives it on its next heartbeat" : "Instruction proposed to the task owner", 4000); }); }}>
      <label for="tt-comment">{toAgent ? "Instruction for the agent" : "Comment"}</label>
      <textarea id="tt-comment" class="field" rows={3} maxLength={4000} value={text} disabled={!!busy} placeholder={toAgent ? "What the running agent should do next" : "Write a comment; @username notifies a teammate"} onInput={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div class="team-actions">
        <button type="submit" class="btn small primary" disabled={!!busy || !text.trim()}>{toAgent ? "Send to agent" : "Post comment"}</button>
        {canEdit ? <label class="check"><input type="checkbox" role="switch" aria-checked={toAgent} checked={toAgent} disabled={!!busy} onChange={(event) => setToAgent(event.currentTarget.checked)} /> Send to agent</label> : null}
        {toAgent ? <span class="help">{isOwner ? "Your instructions are approved at once and reach the agent as a note at its next heartbeat." : "The task owner or a project maintainer approves instructions before the agent sees them."}</span> : null}
      </div>
    </form> : <p class="help">A project reviewer role is needed to comment.</p>}
  </section>;
}

function DecisionsCard({ task, canEdit, busy, act }: { task: Task; canEdit: boolean; busy: string; act: Act }) {
  const [text, setText] = useState("");
  return <section class="team-section" aria-labelledby="tt-decisions"><h2 id="tt-decisions">Decisions<span class="team-count">{task.decisions.length}</span></h2>
    <p class="help">Choices that bind the work: every checkpoint carries them to the next agent.</p>
    {task.decisions.length ? <ul class="team-list decisions">{task.decisions.map((decision) => <li key={decision.id}><span>{decision.text}</span><span class="help">{decision.by.displayName} · {ago(decision.at)}</span></li>)}</ul> : null}
    {task.decisions.length >= MAX.decisions ? <p class="help" role="status">{historyLimitMessage(MAX.decisions, "decisions")}</p> : canEdit ? <form class="team-inline" onSubmit={(event) => { event.preventDefault(); const body = text.trim(); if (body) void act("Adding the decision…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/decisions`, { text: body }), () => setText("")); }}><label>Add a decision<input class="field" maxLength={2000} value={text} disabled={!!busy} onInput={(event) => setText(event.currentTarget.value)} /></label><button type="submit" class="btn small" disabled={!!busy || !text.trim()}>Add</button></form> : null}
  </section>;
}

/** "Build with agents": the repository clone, the pattern, an agent per role, the permissions and whether to continue from the latest checkpoint. */
function StartDialog({ task, checkpoint, onClose, onStarted }: { task: Task; checkpoint?: Checkpoint; onClose: () => void; onStarted: () => void }) {
  const ref = useDialog(true, onClose);
  useEffect(() => { void loadModels(); }, []);
  const link = teamLink.value, mapped = link?.mappings[task.projectId]?.[task.repository] ?? "";
  const list = patterns.value;
  const [path, setPath] = useState(mapped);
  const [patternId, setPatternId] = useState(() => { const wanted = link?.defaults?.pattern; return wanted && list.some((entry) => entry.id === wanted) ? wanted : list.some((entry) => entry.id === "solo") ? "solo" : list[0]?.id ?? ""; });
  const pattern = list.find((entry) => entry.id === patternId);
  const sorted = agents.value.filter((agent) => agent.available);
  const [roles, setRoles] = useState<Record<string, AgentId[]>>({});
  const [settings, setSettings] = useState(agentSettings.value);
  const [check, setCheck] = useState("");
  const [minutes, setMinutes] = useState(limits.value.maxMinutes);
  const [calls, setCalls] = useState(limits.value.maxSteps);
  const [trustValue, setTrustValue] = useState<Trust>(() => { const wanted = link?.defaults?.trust; return wanted && wanted in TRUST ? wanted as Trust : trust.value; });
  const continuable = !!checkpoint && checkpoint.bundle === "available";
  const [fromCheckpoint, setFromCheckpoint] = useState(continuable);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const agentsFor = (role: RoleSpec): AgentId[] => {
    const configured = roles[role.id] ?? link?.defaults?.roles?.[role.id] ?? role.default;
    const selected = configured.filter((id) => sorted.some((agent) => agent.id === id)) as AgentId[];
    if (role.id in roles) return role.multiple ? selected : selected.slice(0, 1);
    return selected.length ? role.multiple ? selected : selected.slice(0, 1) : sorted[0] ? [sorted[0].id] : [];
  };
  const minimumCalls = pattern?.id === "auto-team" ? 4 : 1;
  const valid = !!pattern && sorted.length > 0 && !!path.trim() && pattern.roles.every((role) => role.optional || agentsFor(role).length > 0) && Number.isInteger(calls) && calls >= minimumCalls && calls <= MAX_EXECUTION_BUDGET.maxSteps && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_EXECUTION_BUDGET.maxMinutes && (!pattern.requiresCheck || !!check.trim());
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy || !pattern || !valid) return; setBusy(true); setError("");
    try {
      await post<{ attemptId: string; runId: string }>(`/api/team-link/tasks/${enc(task.id)}/start`, { ...(path.trim() ? { repo: path.trim() } : {}), pattern: pattern.id, roles: Object.fromEntries(pattern.roles.map((role) => [role.id, agentsFor(role)])), trust: trustValue, agentSettings: settings, loop: { ...(check.trim() ? { check: check.trim() } : {}), maxMinutes: minutes, maxSteps: calls }, ...(fromCheckpoint && checkpoint ? { fromCheckpointId: checkpoint.id } : {}) });
      onStarted();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return <dialog class="picker team-build-dialog" ref={ref} aria-labelledby="tt-start-title"><form class="picker-inner" onSubmit={(event) => void submit(event)}>
    <div class="picker-head"><h3 id="tt-start-title">Build with agents</h3><p class="help">My computer · Use your repository and agent login in a worktree of your clone. Progress, checks and a checkpoint return to this task for review.</p></div>
    <div class="dialog-body">
      <label for="tt-start-repo">Repository path for <code>{task.repository}</code></label>
      <div class="row-inline"><input id="tt-start-repo" class="field mono" value={path} placeholder={mapped || "/absolute/path/to/your/clone"} disabled={busy} onInput={(event) => setPath(event.currentTarget.value)} /><button type="button" class="btn small" disabled={busy || !repo.value} title={repo.value || "Choose a repository in the composer first"} onClick={() => setPath(repo.value)}>Use current repository</button></div>
      {!mapped && !path ? <p class="help">No folder is mapped for this repository key yet; the path you enter here is used for this attempt (map it for good in Connections → Share access).</p> : null}
      <label for="tt-start-pattern">Workflow</label><select id="tt-start-pattern" class="field" value={patternId} disabled={busy} onChange={(event) => { setPatternId(event.currentTarget.value); setRoles({}); }}>{list.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
      {pattern ? <><p class="help">{pattern.summary}</p><fieldset class="team-roles" disabled={busy}><legend>Agents</legend>{pattern.roles.map((role) => role.multiple ? <fieldset class="team-checks" key={role.id}><legend>{role.label}</legend>{sorted.map((agent) => <label class="check" key={agent.id}><input type="checkbox" checked={agentsFor(role).includes(agent.id)} onChange={(event) => setRoles({ ...roles, [role.id]: event.currentTarget.checked ? [...agentsFor(role), agent.id] : agentsFor(role).filter((id) => id !== agent.id) })} />{agent.displayName}</label>)}</fieldset> : <label key={role.id}>{role.label}<select class="field" aria-label={role.label} value={agentsFor(role)[0] ?? ""} onChange={(event) => setRoles({ ...roles, [role.id]: event.currentTarget.value ? [event.currentTarget.value as AgentId] : [] })}>{role.optional ? <option value="">None</option> : null}{sorted.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}</select></label>)}</fieldset></> : null}
      {!sorted.length ? <p class="msg warn">Install and sign in to an agent on this computer before building.</p> : null}
      <details><summary>Models and reasoning</summary><fieldset disabled={busy}>{sorted.filter((agent) => pattern?.roles.some((role) => agentsFor(role).includes(agent.id))).map((agent) => <ModelRow key={agent.id} agent={agent} used settings={settings[agent.id] ?? {}} onChange={(patch) => setSettings({ ...settings, [agent.id]: { ...settings[agent.id], ...patch } })} />)}</fieldset></details>
      <label>Check command<input class="field" maxLength={1000} required={pattern?.requiresCheck} placeholder="Use repository default, or enter e.g. npm test" value={check} disabled={busy} onInput={(event) => setCheck(event.currentTarget.value)} /></label>
      <div class="team-fields"><label>Time budget (minutes)<input class="field" type="number" min={1} max={MAX_EXECUTION_BUDGET.maxMinutes} value={minutes} disabled={busy} onInput={(event) => setMinutes(Number(event.currentTarget.value))} /></label><label>Agent call budget<input class="field" type="number" min={minimumCalls} max={MAX_EXECUTION_BUDGET.maxSteps} value={calls} disabled={busy} onInput={(event) => setCalls(Number(event.currentTarget.value))} /></label></div>
      <label for="tt-start-trust">Agent permissions</label><select id="tt-start-trust" class="field" value={trustValue} disabled={busy} onChange={(event) => setTrustValue(event.currentTarget.value as Trust)}>{(Object.keys(TRUST) as Trust[]).map((value) => <option key={value} value={value}>{TRUST[value].label}</option>)}</select>
      <p class={trustValue === "full" ? "msg warn" : "help"}>{TRUST[trustValue].help}</p>
      {checkpoint ? <label class="check"><input type="checkbox" checked={fromCheckpoint} disabled={busy || !continuable} onChange={(event) => setFromCheckpoint(event.currentTarget.checked)} /> Continue from the latest checkpoint ({shortCommit(checkpoint.commit)}, {ago(checkpoint.at)}){continuable ? "" : " — its bundle is not available"}</label> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">{busy ? "Starting…" : ""}</span><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !valid}>Build with agents</button></div>
  </form></dialog>;
}

/** `attempt` is the dialog's attempt as the task now has it: when the hub refuses (the runner reported again, a teammate recovered it first), the dialog stays with the server's reason, reloads the task, and once the attempt no longer needs recovery says so and offers only Close. */
function RecoverDialog({ task, attempt, onClose, onDone, onRefused }: { task: Task; attempt: Attempt; onClose: () => void; onDone: () => void; onRefused: () => Promise<void> }) {
  const ref = useDialog(true, onClose);
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const needed = attemptStale(attempt);
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="tt-recover-title"><form class="picker-inner" onSubmit={async (event) => {
    event.preventDefault(); if (busy || !needed || !confirmed || !reason.trim()) return; setBusy(true); setError("");
    try { await post(`/api/team/attempts/${enc(attempt.id)}/recover`, { revision: task.revision, reason: reason.trim(), confirmedStopped: true }); onDone(); }
    catch (err) { setError((err as Error).message); await onRefused(); setBusy(false); }
  }}>
    <div class="picker-head"><h3 id="tt-recover-title">Recover attempt</h3><p class="help">Check {attempt.runnerName} first. Stop the original agent or shut down its computer before releasing this task. Recovery prevents that attempt from resuming and lets you start from a checkpoint.</p></div>
    <div class="dialog-body">
      <label for="tt-recover-reason">How did you confirm execution stopped?</label><textarea id="tt-recover-reason" class="field" required rows={3} maxLength={1000} value={reason} disabled={busy} onInput={(event) => setReason(event.currentTarget.value)} />
      <label class="check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.currentTarget.checked)} /> I confirmed the original agent has stopped.</label>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      {!needed ? <p class="msg warn" role="status">{attempt.state === "claimed" || attempt.state === "running" ? `${attempt.runnerName} reconnected and reports this attempt as ${ATTEMPT_LABEL[attempt.state].toLowerCase()}, so recovery is no longer needed. Stop it from that computer if it should not continue.` : `This attempt is now ${ATTEMPT_LABEL[attempt.state].toLowerCase()}, so recovery is no longer needed.`}</p> : null}
    </div>
    <div class="picker-foot">{needed ? <><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !confirmed || !reason.trim()}>Release task</button></> : <button type="button" class="btn primary" disabled={busy} onClick={onClose}>Close</button>}</div>
  </form></dialog>;
}

function HandoverDialog({ task, meId, members, onClose, onDone }: { task: Task; meId: string; members: Member[]; onClose: () => void; onDone: () => void }) {
  const ref = useDialog(true, onClose);
  const teammates = members.filter((member) => member.userId !== meId && roleAtLeast(member.role, "contributor"));
  const [to, setTo] = useState(teammates[0]?.userId ?? ""), [note, setNote] = useState(""), [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy || !to) return; setBusy(true); setError("");
    try { await post(`/api/team-link/tasks/${enc(task.id)}/handover`, { to, note, includeUncommitted }); onDone(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="tt-handover-title"><form class="picker-inner" onSubmit={(event) => void submit(event)}>
    <div class="picker-head"><h3 id="tt-handover-title">Hand over</h3><p class="help">Offers the task with a checkpoint of your work; the teammate continues from it on their own computer once they accept.</p></div>
    <div class="dialog-body">
      <label for="tt-handover-to">Teammate</label><select id="tt-handover-to" class="field" required value={to} disabled={busy} onChange={(event) => setTo(event.currentTarget.value)}>{!teammates.length ? <option value="">No other contributor in this project</option> : null}{teammates.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}{member.online ? " · online" : ""}</option>)}</select>
      <label for="tt-handover-note">Note for them</label><textarea id="tt-handover-note" class="field" rows={4} maxLength={4000} value={note} disabled={busy} placeholder="Where you stopped, what to look at first" onInput={(event) => setNote(event.currentTarget.value)} />
      <label class="check"><input type="checkbox" checked={includeUncommitted} disabled={busy} onChange={(event) => setIncludeUncommitted(event.currentTarget.checked)} /> Include uncommitted changes (committed on the run branch as "Hand-over checkpoint")</label>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">{busy ? "Creating the checkpoint…" : ""}</span><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !to}>Offer hand-over</button></div>
  </form></dialog>;
}

/** A repository path for an import: accepting a hand-over or fetching a checkpoint into a clone of yours. */
function RepoPathDialog({ title, help, action, initial, required = false, onClose, submit }: { title: string; help: string; action: string; initial: string; required?: boolean; onClose: () => void; submit: (path: string) => Promise<void> }) {
  const ref = useDialog(true, onClose);
  const [path, setPath] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="tt-path-title"><form class="picker-inner" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { await submit(path.trim()); } catch (err) { setError((err as Error).message); setBusy(false); } }}>
    <div class="picker-head"><h3 id="tt-path-title">{title}</h3><p class="help">{help}</p></div>
    <div class="dialog-body">
      <label for="tt-path">Repository path</label>
      <div class="row-inline"><input id="tt-path" class="field mono" required={required} value={path} placeholder={initial || "/absolute/path/to/your/clone"} disabled={busy} onInput={(event) => setPath(event.currentTarget.value)} /><button type="button" class="btn small" disabled={busy || !repo.value} title={repo.value || "Choose a repository in the composer first"} onClick={() => setPath(repo.value)}>Use current repository</button></div>
      {!initial && !required ? <p class="help">Leave empty to use the folder mapped for this repository key in Connections → Share access.</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">{busy ? "Working…" : ""}</span><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || (required && !path.trim())}>{action}</button></div>
  </form></dialog>;
}
