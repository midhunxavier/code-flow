import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Attempt, Checkpoint, Comment, Instruction, Task, TaskStatus } from "../src/collab/model.js";
import { useDialog } from "./app.js";
import { TRUST } from "./composer.js";
import { Icon } from "./icons.js";
import { ApiError, enc, fmtSize, post, showToast, useLatest, usePoll } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { agents, agentSettings, available, patterns, repo, trust, type Trust } from "./state.js";
import type { AgentId, RoleSpec } from "./types.js";
import { ATTEMPT_LABEL, ATTEMPT_PILL, STATUS_LABEL, STATUS_PILL, TASK_STATUSES, type Member, type TeamRoute, ago, attemptLive, attemptResumable, attemptStale, board, busyAttempt, del, initials, latestCheckpoint, loadBoard, loadLocalAttempts, loadTask, loadTeamLink, localAttempts, openTask, ownerProblem, put, shortCommit, shownAttempt, teamLink, teamTick, transitionProblem, when, whoLabel } from "./collab-state.js";

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

/** Runs one mutation with a busy label; resolves true when it went through, false when it was refused (a 409 reloads the task, anything else is shown), so a caller closes an editor or drops a draft only on success. */
type Act = (label: string, work: () => Promise<Task | void>, after?: () => void) => Promise<boolean>;
type Save = (patch: Record<string, unknown>, label?: string) => Promise<boolean>;

/**
 * One task: its fields, where it is executing, its checkpoints, reviews, discussion and decisions.
 * Every save carries the task's revision; a 409 means a teammate saved first, so the page reloads the
 * task and keeps what you typed: editors stay open and drafts stay marked unsaved until a save goes
 * through. Execution buttons need this computer (never the shared dashboard) and the task to be
 * yours: the hub never starts anything, your own code-flow does.
 */
export function TeamTaskView({ id, shared = false, navigate }: { id: string; shared?: boolean; navigate: (to: TeamRoute) => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [now, setNow] = useState(Date.now());
  const [dialog, setDialog] = useState<"start" | "handover" | "accept" | "recover" | null>(null);
  const [fetching, setFetching] = useState<Checkpoint | null>(null);
  const begin = useLatest();
  const load = async () => { const current = begin(); try { const next = await loadTask(id); if (current()) { setTask(next); setError(""); openTask.value = next; } } catch (err) { if (current()) setError((err as Error).message); } };
  // The owner app polls as a fallback to its stream; the shared dashboard reloads only on /api/team/events frames (and when its tab is shown again), so an idle shared session can still expire. The liveness clock ticks on its own, without a request.
  usePoll(() => { void load(); void loadBoard(); if (!shared) { void loadTeamLink(); void loadLocalAttempts(); } setNow(Date.now()); }, shared ? 0 : 15_000, [id, teamTick.value, shared]);
  usePoll(() => setNow(Date.now()), 15_000, [], shared);
  useEffect(() => { (document.getElementById("main-content") ?? window).scrollTo({ top: 0 }); return () => { if (openTask.value?.id === id) openTask.value = null; }; }, [id]);
  const act: Act = async (label, work, after) => {
    if (busy) return false; setBusy(label); setError("");
    try { const next = await work(); if (next && typeof next === "object" && "id" in next) { setTask(next); openTask.value = next; } after?.(); return true; }
    catch (err) { if (err instanceof ApiError && err.status === 409) { showToast("Task changed; reloading", 3000); await load(); } else setError((err as Error).message); return false; }
    finally { setBusy(""); }
  };
  const b = board.value;
  if (!task) return <div class="team-page">{error ? <p class="msg err" role="alert">{error} <button class="btn small" onClick={() => void load()}>Retry</button> <button class="btn small" onClick={() => navigate({ view: "team" })}>Back to the board</button></p> : <p class="help" role="status">Loading the task…</p>}</div>;
  const meId = b?.me.userId, project = b?.projects.find((entry) => entry.id === task.projectId), role = project?.role ?? (meId === "owner" ? "maintainer" : b?.me.roles[task.projectId]);
  const members: Member[] = project?.members ?? [];
  const canEdit = roleAtLeast(role, "contributor"), canComment = roleAtLeast(role, "reviewer"), maintainer = roleAtLeast(role, "maintainer");
  const isOwner = !!meId && task.owner?.userId === meId;
  const attempt = shownAttempt(task), running = busyAttempt(task), checkpoint = latestCheckpoint(task);
  const offered = task.handoff?.state === "offered" ? task.handoff : undefined, offeredToMe = !!offered && offered.to.userId === meId, offeredByMe = !!offered && offered.from.userId === meId;
  const link = teamLink.value;
  /** This computer can execute: the owner app with its link API answering (linked to a hub, or this instance being the hub), and the task is yours. */
  const canExecute = !shared && isOwner && link !== null;
  const local = attempt ? localAttempts.value.find((entry) => entry.attemptId === attempt.id) : undefined;
  /** Resume continues the attempt's own run, so it needs this computer's record of it; a paused or stopped attempt from another computer is started anew instead. */
  const resumable = !!attempt && !!local && attemptResumable(attempt, task);
  const save: Save = (patch, label = "Saving…") => act(label, () => put<Task>(`/api/team/tasks/${enc(id)}`, { revision: task.revision, ...patch }));
  const respond = (action: "decline" | "cancel") => offered && act(action === "decline" ? "Declining…" : "Cancelling…", () => post<Task>(`/api/team/tasks/${enc(id)}/handoff/${enc(offered.id)}`, { action, revision: task.revision }), () => showToast(action === "decline" ? "Hand-over declined" : "Hand-over cancelled"));
  const link_ = (path: string, body: unknown, label: string, done: string) => act(label, async () => { await post(`/api/team-link/tasks/${enc(id)}${path}`, body); }, () => { showToast(done); void load(); void loadLocalAttempts(); });
  const stale = attempt ? attemptStale(attempt, now) : false, live = attempt ? attemptLive(attempt, now) : false;
  return <div class="team-page team-task">
    <nav class="team-back" aria-label="Team board"><a href={shared ? "#/team" : `#/team/project/${enc(task.projectId)}`} onClick={(event) => { event.preventDefault(); navigate({ view: "team", project: task.projectId }); }}><Icon name="chevron" class="back" /> {project?.name ?? "Team board"}</a></nav>
    <TaskHeader task={task} role={role} meId={meId} members={members} canEdit={canEdit} maintainer={maintainer} busy={busy} save={save} act={act} navigate={navigate} />
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p class="help" role="status">{busy}</p> : null}
    <div class="team-task-layout">
      <div class="team-main">
        <TaskText task={task} canEdit={canEdit} busy={busy} save={save} />
        <section class="team-section" aria-labelledby="tt-exec">
          <h2 id="tt-exec">Execution</h2>
          {attempt ? <AttemptDetails attempt={attempt} meId={meId} live={live} stale={stale} /> : <p class="help">No attempt yet.{task.owner ? "" : " Take the task to run it on your computer."}</p>}
          <div class="team-actions">
            {local?.runId ? <a class="btn small" href={`#/run/${enc(local.runId)}`}>Open run</a> : null}
            {canExecute ? <>
              {offeredToMe ? <><button type="button" class="btn small primary" disabled={!!busy} onClick={() => setDialog("accept")}>Accept and download</button><button type="button" class="btn small" disabled={!!busy} onClick={() => void respond("decline")}>Decline</button></> : null}
              {!offered && !running ? <button type="button" class="btn small primary" disabled={!!busy} onClick={() => setDialog("start")}>Start on this computer</button> : null}
              {running && local ? <button type="button" class="btn small" disabled={!!busy} onClick={() => { if (confirm("Stop the attempt running on this computer? Its run can be resumed later and its work is kept.")) void link_("/stop", {}, "Stopping…", "Attempt stopped"); }}>Stop</button> : null}
              {resumable ? <button type="button" class="btn small" disabled={!!busy} onClick={() => void link_("/resume", {}, "Resuming…", "Attempt resumed")}>Resume</button> : null}
              {!offered && !running ? <button type="button" class="btn small" disabled={!!busy} onClick={() => setDialog("handover")}>Hand over…</button> : null}
            </> : null}
            {attempt?.state === "unknown" && ((isOwner && canEdit) || maintainer) ? <button type="button" class="btn small" disabled={!!busy} onClick={() => setDialog("recover")}>Recover attempt…</button> : null}
            {offered && !canExecute && offeredToMe ? <button type="button" class="btn small" disabled={!!busy} onClick={() => void respond("decline")}>Decline hand-over</button> : null}
            {offered && (offeredByMe || maintainer) ? <button type="button" class="btn small" disabled={!!busy} onClick={() => { if (confirm("Cancel this hand-over? The task stays with its current owner.")) void respond("cancel"); }}>Cancel hand-over</button> : null}
            {!task.owner && canEdit && meId ? <button type="button" class="btn small" disabled={!!busy || !!ownerProblem(task, role, meId)} title={ownerProblem(task, role, meId)} onClick={() => void save({ owner: meId }, "Taking the task…")}>Take this task</button> : null}
          </div>
          {offered ? <p class="msg warn" role="status">Hand-over offered to {whoLabel(offered.to, meId)} by {whoLabel(offered.from, meId)} {ago(offered.offeredAt)}{offered.note ? `: ${offered.note}` : ""}</p> : null}
          {shared && isOwner ? <p class="help">Run this task from your own code-flow: Settings → Team → Connect this computer.</p> : null}
          {!shared && isOwner && link === null ? <p class="help">This computer's team link is not available here, so the task cannot be run from this page.</p> : null}
        </section>
        <CheckpointsCard task={task} latest={checkpoint} meId={meId} canEdit={canEdit} maintainer={maintainer} shared={shared} busy={busy} act={act} onFetch={setFetching} reload={load} />
        <ReviewsCard task={task} latest={checkpoint} meId={meId} members={members} canEdit={canEdit} canComment={canComment} busy={busy} act={act} />
        <DiscussionCard task={task} meId={meId} members={members} canEdit={canEdit} canComment={canComment} isOwner={isOwner} maintainer={maintainer} busy={busy} act={act} />
      </div>
      <div class="team-aside">
        <TaskFields task={task} role={role} meId={meId} members={members} canEdit={canEdit} busy={busy} save={save} />
        <DecisionsCard task={task} canEdit={canEdit} busy={busy} act={act} />
        <details class="team-section team-history"><summary>History <span class="team-count">{task.audit.length}</span></summary><ol>{task.audit.slice().reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><span class="th-when">{when(entry.at)}</span> <strong>{entry.by.displayName}</strong> {entry.action}{entry.detail ? <span class="th-detail"> — {entry.detail}</span> : null}</li>)}</ol></details>
      </div>
    </div>
    {dialog === "start" ? <StartDialog task={task} checkpoint={checkpoint} onClose={() => setDialog(null)} onStarted={() => { setDialog(null); showToast("Started on this computer"); void load(); void loadLocalAttempts(); }} /> : null}
    {dialog === "handover" && meId ? <HandoverDialog task={task} meId={meId} members={members} onClose={() => setDialog(null)} onDone={() => { setDialog(null); showToast("Hand-over offered"); void load(); }} /> : null}
    {dialog === "recover" && attempt?.state === "unknown" ? <RecoverDialog task={task} attempt={attempt} onClose={() => setDialog(null)} onDone={() => { setDialog(null); showToast("Attempt recovered"); void load(); void loadLocalAttempts(); }} /> : null}
    {dialog === "accept" && offered ? <RepoPathDialog title="Accept and download" help={`The checkpoint is downloaded into your clone of ${task.repository} before the task becomes yours; a failed download changes nothing.`} action="Accept and download" initial={link?.mappings[task.projectId]?.[task.repository] ?? ""} onClose={() => setDialog(null)} submit={async (path) => { await post(`/api/team-link/tasks/${enc(id)}/accept`, { handoffId: offered.id, ...(path ? { repo: path } : {}) }); setDialog(null); showToast("Hand-over accepted"); void load(); }} /> : null}
    {fetching ? <RepoPathDialog title="Fetch to this computer" help={`Imports checkpoint ${shortCommit(fetching.commit)} into the repository below as a branch; nothing is checked out.`} action="Fetch" initial={link?.mappings[task.projectId]?.[task.repository] ?? ""} required onClose={() => setFetching(null)} submit={async (path) => { const result = await post<{ commit: string; branch: string }>(`/api/team-link/checkpoints/${enc(fetching.id)}/fetch`, { repo: path }); setFetching(null); showToast(`Fetched as branch ${result.branch}`, 5000); }} /> : null}
  </div>;
}

function TaskHeader({ task, role, meId, members, canEdit, maintainer, busy, save, act, navigate }: { task: Task; role: ReturnType<typeof roleOf>; meId?: string; members: Member[]; canEdit: boolean; maintainer: boolean; busy: string; save: Save; act: Act; navigate: (to: TeamRoute) => void }) {
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(task.title), [blocking, setBlocking] = useState(false), [blocker, setBlocker] = useState(task.blocker ?? "");
  useEffect(() => { if (!editing) setTitle(task.title); }, [task.title, editing]);
  useEffect(() => { if (!blocking) setBlocker(task.blocker ?? ""); }, [task.blocker, blocking]);
  const doneProblem = transitionProblem(task, "done", role);
  const problemFor = (to: TaskStatus) => to === "blocked" ? transitionProblem(task, "blocked", role, "pending") : transitionProblem(task, to, role);
  return <div class="page-head team-task-head">
    <div class="page-head-text">
      {editing ? <form class="team-title-edit" onSubmit={(event) => { event.preventDefault(); if (title.trim() && title.trim() !== task.title) void save({ title: title.trim() }).then((saved) => { if (saved) setEditing(false); }); else setEditing(false); }}><label class="sr-only" for="tt-title">Title</label><input id="tt-title" class="field" required maxLength={200} value={title} disabled={!!busy} onInput={(event) => setTitle(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { setEditing(false); setTitle(task.title); } }} /><button type="submit" class="btn small primary" disabled={!!busy || !title.trim()}>Save</button><button type="button" class="btn small" onClick={() => { setEditing(false); setTitle(task.title); }}>Cancel</button></form>
        : <h1>{task.title}{canEdit ? <button type="button" class="icon-btn team-edit" aria-label="Edit the title" title="Edit the title" disabled={!!busy} onClick={() => setEditing(true)}><Icon name="note" /></button> : null}</h1>}
      <p class="team-task-meta"><span class={`status-pill ${STATUS_PILL[task.status]}`}>{STATUS_LABEL[task.status]}</span><code>{task.repository}</code>{task.baseRef ? <span>base <code>{task.baseRef}</code></span> : null}<span>{task.owner ? <>Owned by {whoLabel(task.owner, meId)}</> : "Unassigned"}</span>{task.reviewer ? <span>Reviewed by {whoLabel(task.reviewer, meId)}</span> : null}<span>Updated {ago(task.updatedAt)}</span>{task.labels.map((label) => <span key={label} class="badge">{label}</span>)}</p>
      {task.status === "blocked" && task.blocker ? <p class="msg warn" role="status"><strong>Blocked:</strong> {task.blocker}</p> : null}
    </div>
    <div class="page-head-actions">
      <label class="team-status">Status<select class="field" value={task.status} disabled={!canEdit || !!busy} onChange={(event) => { const to = event.currentTarget.value as TaskStatus; if (to === "blocked") { setBlocking(true); return; } void save({ status: to }); }}>{TASK_STATUSES.map((state) => { const problem = state === task.status ? undefined : problemFor(state); return <option key={state} value={state} disabled={!!problem} title={problem}>{STATUS_LABEL[state]}</option>; })}</select></label>
      {maintainer ? <button type="button" class="btn small danger" disabled={!!busy} onClick={() => { if (confirm("Delete this task, its checkpoints and its discussion? This cannot be undone.")) void act("Deleting…", async () => { await del(`/api/team/tasks/${enc(task.id)}`, { revision: task.revision }); }, () => { showToast("Task deleted"); navigate({ view: "team", project: task.projectId }); }); }}>Delete task</button> : null}
      {canEdit && doneProblem && task.status !== "done" ? <p class="help">Done is unavailable: {doneProblem}.</p> : null}
      {blocking ? <form class="team-blocker" onSubmit={(event) => { event.preventDefault(); if (blocker.trim()) void save({ status: "blocked", blocker: blocker.trim() }).then((saved) => { if (saved) setBlocking(false); }); }}><label for="tt-blocker">What blocks the task?</label><textarea id="tt-blocker" class="field" rows={2} required maxLength={1000} value={blocker} disabled={!!busy} onInput={(event) => setBlocker(event.currentTarget.value)} /><div class="team-actions"><button type="submit" class="btn small primary" disabled={!!busy || !blocker.trim()}>Mark blocked</button><button type="button" class="btn small" onClick={() => setBlocking(false)}>Cancel</button></div></form> : null}
    </div>
  </div>;
}
const roleOf = (members: Member[], userId?: string) => members.find((member) => member.userId === userId)?.role;

/**
 * Goal and acceptance criteria: a draft each, saved on its own button, so a teammate's save never swallows what you
 * type. A draft is unsaved for exactly as long as it differs from the task, never by a flag of its own: a refused save
 * (a teammate saved first, the connection dropped) leaves Save, Discard and the hint in place, and unsaved text can
 * never look saved. A draft still equal to the saved text follows the task when a teammate changes it.
 */
function TaskText({ task, canEdit, busy, save }: { task: Task; canEdit: boolean; busy: string; save: Save }) {
  const [goal, setGoal] = useState(task.goal), [acceptance, setAcceptance] = useState(task.acceptance);
  const saved = useRef({ goal: task.goal, acceptance: task.acceptance });
  useEffect(() => { if (goal === saved.current.goal) setGoal(task.goal); saved.current.goal = task.goal; }, [task.goal]);
  useEffect(() => { if (acceptance === saved.current.acceptance) setAcceptance(task.acceptance); saved.current.acceptance = task.acceptance; }, [task.acceptance]);
  const field = (id: string, label: string, value: string, savedText: string, max: number, onInput: (value: string) => void, onSave: () => void) => <div class="team-text">
    <label for={id}>{label}</label>
    {canEdit ? <><textarea id={id} class="field" rows={value.split("\n").length > 4 ? 8 : 4} maxLength={max} value={value} disabled={!!busy} onInput={(event) => onInput(event.currentTarget.value)} />{value !== savedText ? <div class="team-actions"><button type="button" class="btn small primary" disabled={!!busy} onClick={onSave}>Save {label.toLowerCase()}</button><button type="button" class="btn small" disabled={!!busy} onClick={() => onInput(savedText)}>Discard</button><span class="help">Unsaved changes</span></div> : null}</>
      : savedText ? <p id={id} class="team-prose">{savedText}</p> : <p id={id} class="help">Not written yet.</p>}
  </div>;
  return <section class="team-section" aria-labelledby="tt-text"><h2 id="tt-text">Goal and acceptance</h2>
    {field("tt-goal", "Goal", goal, task.goal, 16384, setGoal, () => void save({ goal }))}
    {field("tt-acceptance", "Acceptance criteria", acceptance, task.acceptance, 8192, setAcceptance, () => void save({ acceptance }))}
  </section>;
}

function AttemptDetails({ attempt, meId, live, stale }: { attempt: Attempt; meId?: string; live: boolean; stale: boolean }) {
  const p = attempt.progress;
  return <>
    <p class="team-task-meta"><span class={`status-pill ${stale ? "failing" : ATTEMPT_PILL[attempt.state]}`}>{stale ? "Connection lost" : ATTEMPT_LABEL[attempt.state]}</span><span>on <strong>{attempt.runnerName}</strong> by {whoLabel(attempt.user, meId)}</span>{live ? <span class="team-live"><span class="dot running" aria-hidden="true" />Live · heard {ago(attempt.lastHeartbeatAt)}</span> : <span>Last heard {ago(attempt.lastHeartbeatAt)}</span>}</p>
    {stale ? <p class="msg warn" role="status">Connection lost; execution status unknown. This task stays reserved until the runner reconnects and reports its state. Recover it only after confirming the original agent has stopped.</p> : null}
    <dl class="team-kv">
      {p.stage ? <><dt>Stage</dt><dd>{p.stage}</dd></> : null}
      {p.steps ? <><dt>Steps</dt><dd>{p.steps.done}{p.steps.total !== undefined ? ` of ${p.steps.total}` : ""}</dd></> : null}
      {p.runStatus || p.verdict ? <><dt>Run</dt><dd>{p.runStatus ?? ""}{p.verdict ? `${p.runStatus ? " · " : ""}check ${p.verdict}` : ""}</dd></> : null}
      {p.tests ? <><dt>Tests</dt><dd><span class={`badge ${p.tests.ok ? "ok" : "warn"}`}>{p.tests.ok ? "Passing" : "Failing"}</span> <code>{p.tests.command}</code> · {ago(p.tests.at)}</dd></> : null}
      {p.branch || attempt.branch ? <><dt>Branch</dt><dd><code>{p.branch ?? attempt.branch}</code>{p.head ?? attempt.head ? <> at <code>{shortCommit(p.head ?? attempt.head!)}</code></> : null}</dd></> : null}
      <dt>Base</dt><dd><code>{shortCommit(attempt.baseCommit)}</code>{attempt.fromCheckpointId ? " · continued from a checkpoint" : ""}</dd>
      <dt>Started</dt><dd>{when(attempt.startedAt ?? attempt.createdAt)}{attempt.endedAt ? ` · ended ${ago(attempt.endedAt)}` : ""}</dd>
      {attempt.reason ? <><dt>Reason</dt><dd>{attempt.reason}</dd></> : null}
    </dl>
    {p.summary ? <pre class="team-prose">{p.summary}</pre> : null}
    {p.blockers?.length ? <div class="msg warn" role="status"><strong>Blockers</strong><ul class="team-list">{p.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    {p.changedFiles?.length ? <details class="team-files"><summary>{p.changedFiles.length} changed file{p.changedFiles.length === 1 ? "" : "s"}</summary><ul class="team-list mono">{p.changedFiles.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
  </>;
}

/** The editable fields a card does not show: people, repository, base, labels and dependencies; each saves on change. */
function TaskFields({ task, role, meId, members, canEdit, busy, save }: { task: Task; role: ReturnType<typeof roleOf>; meId?: string; members: Member[]; canEdit: boolean; busy: string; save: Save }) {
  const b = board.value, project = b?.projects.find((entry) => entry.id === task.projectId);
  const maintainer = roleAtLeast(role, "maintainer");
  const owners = members.filter((member) => roleAtLeast(member.role, "contributor") && (maintainer || member.userId === meId));
  if (task.owner && !owners.some((member) => member.userId === task.owner!.userId)) owners.unshift({ userId: task.owner.userId, username: task.owner.userId, displayName: task.owner.displayName, role: "contributor", online: false });
  const reviewers = members.filter((member) => roleAtLeast(member.role, "reviewer"));
  const others = (b?.tasks ?? []).filter((entry) => entry.projectId === task.projectId && entry.id !== task.id);
  const ownerIssue = ownerProblem(task, role, meId);
  const [baseRef, setBaseRef] = useState(task.baseRef ?? ""), [labels, setLabels] = useState(task.labels.join(", "));
  useEffect(() => setBaseRef(task.baseRef ?? ""), [task.baseRef]); useEffect(() => setLabels(task.labels.join(", ")), [task.labels.join(", ")]);
  // The multi-select's options carry `selected`, which Preact only writes when the prop changes, so a refused save would leave the clicked option selected for good; remounting the select (its key) snaps it back to the task like the other fields.
  const [dependsReset, setDependsReset] = useState(0), dependsKey = `${task.dependsOn.join(",")}:${dependsReset}`;
  const disabled = !canEdit || !!busy;
  return <section class="team-section" aria-labelledby="tt-fields"><h2 id="tt-fields">Details</h2>
    <div class="team-fields column">
      <label>Owner<select class="field" value={task.owner?.userId ?? ""} disabled={disabled || !!ownerIssue} title={ownerIssue} onChange={(event) => void save({ owner: event.currentTarget.value || null })}><option value="">Unassigned</option>{owners.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select>{ownerIssue && canEdit ? <span class="help">{ownerIssue}</span> : null}</label>
      <label>Reviewer<select class="field" value={task.reviewer?.userId ?? ""} disabled={disabled} onChange={(event) => void save({ reviewer: event.currentTarget.value || null })}><option value="">None</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
      <label>Repository<select class="field" value={task.repository} disabled={disabled} onChange={(event) => void save({ repository: event.currentTarget.value })}>{!project?.repositories.some((entry) => entry.key === task.repository) ? <option value={task.repository}>{task.repository}</option> : null}{project?.repositories.map((entry) => <option key={entry.key} value={entry.key}>{entry.label} ({entry.key})</option>)}</select></label>
      <label>Base branch<input class="field" maxLength={100} value={baseRef} disabled={disabled} placeholder="The repository's default branch" onInput={(event) => setBaseRef(event.currentTarget.value)} onBlur={() => { if (baseRef.trim() !== (task.baseRef ?? "")) void save({ baseRef: baseRef.trim() || null }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      <label>Labels<input class="field" maxLength={450} value={labels} disabled={disabled} placeholder="Comma-separated, up to 10" onInput={(event) => setLabels(event.currentTarget.value)} onBlur={() => { const next = [...new Set(labels.split(",").map((label) => label.trim()).filter(Boolean))].slice(0, 10); if (next.join(", ") !== task.labels.join(", ")) void save({ labels: next }); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
      {members.length ? <fieldset class="team-checks" disabled={disabled}><legend>Collaborators</legend>{members.filter((member) => member.userId !== task.owner?.userId).map((member) => <label key={member.userId} class="check"><input type="checkbox" checked={task.collaborators.some((who) => who.userId === member.userId)} onChange={(event) => { const ids = task.collaborators.map((who) => who.userId).filter((userId) => userId !== member.userId); if (event.currentTarget.checked) ids.push(member.userId); void save({ collaborators: ids.slice(0, 20) }); }} /> {member.userId === meId ? `${member.displayName} (you)` : member.displayName}</label>)}</fieldset> : null}
      {others.length ? <label>Depends on<select key={dependsKey} class="field" multiple size={Math.min(5, Math.max(2, others.length))} disabled={disabled} onChange={(event) => void save({ dependsOn: [...event.currentTarget.selectedOptions].map((option) => option.value).slice(0, 20) }).then((saved) => { if (!saved) setDependsReset((count) => count + 1); })}>{others.map((entry) => <option key={entry.id} value={entry.id} selected={task.dependsOn.includes(entry.id)}>{entry.title} · {STATUS_LABEL[entry.status]}</option>)}</select></label> : null}
    </div>
    <dl class="team-kv"><dt>Created</dt><dd>{when(task.createdAt)} by {task.createdBy.displayName}</dd><dt>Project</dt><dd>{project?.name ?? task.projectId}</dd>{task.dependsOn.length ? <><dt>Depends on</dt><dd>{task.dependsOn.map((depId) => others.find((entry) => entry.id === depId)?.title ?? depId).join(", ")}</dd></> : null}</dl>
  </section>;
}

function CheckpointsCard({ task, latest, meId, canEdit, maintainer, shared, busy, act, onFetch, reload }: { task: Task; latest?: Checkpoint; meId?: string; canEdit: boolean; maintainer: boolean; shared: boolean; busy: string; act: Act; onFetch: (checkpoint: Checkpoint) => void; reload: () => Promise<void> }) {
  const list = task.checkpoints.slice().sort((x, y) => y.at - x.at);
  return <section class="team-section" aria-labelledby="tt-checkpoints"><h2 id="tt-checkpoints">Checkpoints<span class="team-count">{list.length}</span></h2>
    {!list.length ? <p class="help">None yet. An attempt publishes a checkpoint (a Git bundle of its commits plus the context the next agent needs) when it finishes or is handed over.</p> : null}
    {list.map((checkpoint) => <article key={checkpoint.id} class="team-item">
      <div class="team-task-meta"><code>{shortCommit(checkpoint.commit)}</code><code>{checkpoint.branch}</code><span>{fmtSize(checkpoint.size)}</span><span>by {whoLabel(checkpoint.createdBy, meId)}</span><span>{ago(checkpoint.at)}</span>{checkpoint === latest ? <span class="badge ok">Latest</span> : null}{checkpoint.bundle === "pending" ? <span class="badge warn">Uploading</span> : checkpoint.bundle === "deleted" ? <span class="badge warn">Bundle deleted</span> : null}{checkpoint.testResults ? <span class={`badge ${checkpoint.testResults.ok ? "ok" : "warn"}`}>Tests {checkpoint.testResults.ok ? "passing" : "failing"}</span> : null}</div>
      {checkpoint.note ? <p class="team-comment-text">{checkpoint.note}</p> : null}
      {checkpoint.remaining ? <details><summary>Remaining work</summary><pre class="team-prose">{checkpoint.remaining}</pre></details> : null}
      {checkpoint.changedFiles.length ? <details><summary>{checkpoint.changedFiles.length} changed file{checkpoint.changedFiles.length === 1 ? "" : "s"}</summary><ul class="team-list mono">{checkpoint.changedFiles.map((path) => <li key={path}>{path}</li>)}</ul></details> : null}
      <div class="team-actions">
        {!shared && canEdit && checkpoint.bundle === "available" ? <button type="button" class="btn small" disabled={!!busy} onClick={() => onFetch(checkpoint)}>Fetch to this computer…</button> : null}
        {canEdit && checkpoint.bundle === "available" ? <a class="btn small" href={`/api/team/checkpoints/${enc(checkpoint.id)}/bundle`} download={`checkpoint-${checkpoint.id.slice(0, 8)}.bundle`}>Download bundle</a> : null}
        {maintainer && checkpoint.bundle !== "deleted" ? <button type="button" class="btn small danger" disabled={!!busy} onClick={() => { if (confirm("Delete this checkpoint's bundle? Teammates can no longer download or continue from it.")) void act("Deleting…", async () => { await del(`/api/team/checkpoints/${enc(checkpoint.id)}`); }, () => void reload()); }}>Delete</button> : null}
      </div>
    </article>)}
  </section>;
}

function ReviewsCard({ task, latest, meId, members, canEdit, canComment, busy, act }: { task: Task; latest?: Checkpoint; meId?: string; members: Member[]; canEdit: boolean; canComment: boolean; busy: string; act: Act }) {
  const [reviewer, setReviewer] = useState(task.reviewer?.userId ?? ""), [verdict, setVerdict] = useState<"approve" | "request-changes">("approve"), [text, setText] = useState("");
  const reviewers = members.filter((member) => roleAtLeast(member.role, "reviewer"));
  const reviews = task.reviews.slice().sort((x, y) => y.at - x.at);
  const current = latest ? reviews.filter((review) => review.checkpointId === latest.id && !review.stale)[0] : undefined;
  return <section class="team-section" aria-labelledby="tt-reviews"><h2 id="tt-reviews">Reviews{current ? <span class={`badge ${current.verdict === "approve" ? "ok" : "warn"}`}>{current.verdict === "approve" ? "Approved" : "Changes requested"}</span> : task.reviewer && latest ? <span class="badge">Pending</span> : null}</h2>
    {canEdit ? <form class="team-inline" onSubmit={(event) => { event.preventDefault(); if (reviewer) void act("Requesting a review…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/review-request`, { reviewer, revision: task.revision }), () => showToast("Review requested")); }}><label>Request a review from<select class="field" value={reviewer} disabled={!!busy} onChange={(event) => setReviewer(event.currentTarget.value)}><option value="">Choose a reviewer</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === meId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label><button type="submit" class="btn small" disabled={!!busy || !reviewer}>Request review</button></form> : null}
    {canComment && latest ? <form class="team-review-form" onSubmit={(event) => { event.preventDefault(); void act("Recording the review…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/reviews`, { checkpointId: latest.id, verdict, text, revision: task.revision }), () => { setText(""); showToast("Review recorded"); }); }}>
      <fieldset disabled={!!busy}><legend>Record a review of checkpoint <code>{shortCommit(latest.commit)}</code></legend><label class="check"><input type="radio" name="tt-verdict" value="approve" checked={verdict === "approve"} onChange={() => setVerdict("approve")} /> Approve</label><label class="check"><input type="radio" name="tt-verdict" value="request-changes" checked={verdict === "request-changes"} onChange={() => setVerdict("request-changes")} /> Request changes</label></fieldset>
      <label for="tt-review-text">Review notes</label><textarea id="tt-review-text" class="field" rows={3} maxLength={4000} value={text} disabled={!!busy} onInput={(event) => setText(event.currentTarget.value)} />
      <div class="team-actions"><button type="submit" class="btn small primary" disabled={!!busy || (verdict === "request-changes" && !text.trim())}>Record review</button></div>
    </form> : canComment ? <p class="help">Reviews attach to a checkpoint; this task has none yet.</p> : null}
    {reviews.map((review) => <article key={review.id} class="team-item"><div class="team-task-meta"><span class={`badge ${review.verdict === "approve" ? "ok" : "warn"}`}>{review.verdict === "approve" ? "Approved" : "Changes requested"}</span><span>by {whoLabel(review.by, meId)}</span><code>{shortCommit(review.commit)}</code><span>{ago(review.at)}</span>{review.stale ? <span class="badge">Stale · a newer checkpoint exists</span> : null}</div>{review.text ? <p class="team-comment-text">{review.text}</p> : null}</article>)}
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
        {entry.instruction.state === "proposed" && (isOwner || maintainer) ? <div class="team-actions"><button type="button" class="btn small primary" disabled={!!busy} onClick={() => void decide(entry.instruction, "approve")}>Approve</button><button type="button" class="btn small" disabled={!!busy} onClick={() => void decide(entry.instruction, "decline")}>Decline</button></div> : null}
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
    {canEdit ? <form class="team-inline" onSubmit={(event) => { event.preventDefault(); const body = text.trim(); if (body) void act("Adding the decision…", () => post<Task>(`/api/team/tasks/${enc(task.id)}/decisions`, { text: body }), () => setText("")); }}><label>Add a decision<input class="field" maxLength={2000} value={text} disabled={!!busy} onInput={(event) => setText(event.currentTarget.value)} /></label><button type="submit" class="btn small" disabled={!!busy || !text.trim()}>Add</button></form> : null}
  </section>;
}

/** "Start on this computer": the repository clone, the pattern, an agent per role, the permissions and whether to continue from the latest checkpoint. */
function StartDialog({ task, checkpoint, onClose, onStarted }: { task: Task; checkpoint?: Checkpoint; onClose: () => void; onStarted: () => void }) {
  const ref = useDialog(true, onClose);
  const link = teamLink.value, mapped = link?.mappings[task.projectId]?.[task.repository] ?? "";
  const list = patterns.value;
  const [path, setPath] = useState(mapped);
  const [patternId, setPatternId] = useState(() => { const wanted = link?.defaults?.pattern; return wanted && list.some((entry) => entry.id === wanted) ? wanted : list.some((entry) => entry.id === "solo") ? "solo" : list[0]?.id ?? ""; });
  const pattern = list.find((entry) => entry.id === patternId);
  const sorted = agents.value.slice().sort((x, y) => Number(y.available) - Number(x.available));
  const [roles, setRoles] = useState<Record<string, AgentId>>({});
  const [trustValue, setTrustValue] = useState<Trust>(() => { const wanted = link?.defaults?.trust; return wanted && wanted in TRUST ? wanted as Trust : trust.value; });
  const continuable = !!checkpoint && checkpoint.bundle === "available";
  const [fromCheckpoint, setFromCheckpoint] = useState(continuable);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const agentFor = (role: RoleSpec): AgentId | "" => roles[role.id] ?? (link?.defaults?.roles?.[role.id]?.find((id) => sorted.some((agent) => agent.id === id)) as AgentId | undefined) ?? role.default.find((id) => available(id)) ?? sorted[0]?.id ?? "";
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy || !pattern) return; setBusy(true); setError("");
    try {
      await post<{ attemptId: string; runId: string }>(`/api/team-link/tasks/${enc(task.id)}/start`, { ...(path.trim() ? { repo: path.trim() } : {}), pattern: pattern.id, roles: Object.fromEntries(pattern.roles.map((role) => [role.id, agentFor(role) ? [agentFor(role)] : []])), trust: trustValue, agentSettings: agentSettings.value, ...(fromCheckpoint && checkpoint ? { fromCheckpointId: checkpoint.id } : {}) });
      onStarted();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="tt-start-title"><form class="picker-inner" onSubmit={(event) => void submit(event)}>
    <div class="picker-head"><h3 id="tt-start-title">Start on this computer</h3><p class="help">Your own agents run the task in a worktree of your clone; progress and a checkpoint go to the team board.</p></div>
    <div class="dialog-body">
      <label for="tt-start-repo">Repository path for <code>{task.repository}</code></label>
      <div class="row-inline"><input id="tt-start-repo" class="field mono" value={path} placeholder={mapped || "/absolute/path/to/your/clone"} disabled={busy} onInput={(event) => setPath(event.currentTarget.value)} /><button type="button" class="btn small" disabled={busy || !repo.value} title={repo.value || "Choose a repository in the composer first"} onClick={() => setPath(repo.value)}>Use current repository</button></div>
      {!mapped && !path ? <p class="help">No folder is mapped for this repository key yet; the path you enter here is used for this attempt (map it for good in Settings → Team).</p> : null}
      <label for="tt-start-pattern">Pattern</label><select id="tt-start-pattern" class="field" value={patternId} disabled={busy} onChange={(event) => { setPatternId(event.currentTarget.value); setRoles({}); }}>{list.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
      {pattern ? <fieldset class="team-roles" disabled={busy}><legend>Agents</legend>{pattern.roles.map((role) => <label key={role.id}>{role.label}<select class="field" value={agentFor(role)} onChange={(event) => setRoles({ ...roles, [role.id]: event.currentTarget.value as AgentId })}>{sorted.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}{agent.available ? "" : " (not installed)"}</option>)}</select></label>)}</fieldset> : null}
      <label for="tt-start-trust">Agent permissions</label><select id="tt-start-trust" class="field" value={trustValue} disabled={busy} onChange={(event) => setTrustValue(event.currentTarget.value as Trust)}>{(Object.keys(TRUST) as Trust[]).map((value) => <option key={value} value={value}>{TRUST[value].label}</option>)}</select>
      <p class={trustValue === "full" ? "msg warn" : "help"}>{TRUST[trustValue].help}</p>
      {checkpoint ? <label class="check"><input type="checkbox" checked={fromCheckpoint} disabled={busy || !continuable} onChange={(event) => setFromCheckpoint(event.currentTarget.checked)} /> Continue from the latest checkpoint ({shortCommit(checkpoint.commit)}, {ago(checkpoint.at)}){continuable ? "" : " — its bundle is not available"}</label> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">{busy ? "Starting…" : ""}</span><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !pattern || !sorted.length}>Start</button></div>
  </form></dialog>;
}

function RecoverDialog({ task, attempt, onClose, onDone }: { task: Task; attempt: Attempt; onClose: () => void; onDone: () => void }) {
  const ref = useDialog(true, onClose);
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="tt-recover-title"><form class="picker-inner" onSubmit={async (event) => {
    event.preventDefault(); if (busy || !confirmed || !reason.trim()) return; setBusy(true); setError("");
    try { await post(`/api/team/attempts/${enc(attempt.id)}/recover`, { revision: task.revision, reason: reason.trim(), confirmedStopped: true }); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }}>
    <div class="picker-head"><h3 id="tt-recover-title">Recover attempt</h3><p class="help">Check {attempt.runnerName} first. Stop the original agent or shut down its computer before releasing this task. Recovery prevents that attempt from resuming and lets you start from a checkpoint.</p></div>
    <div class="dialog-body">
      <label for="tt-recover-reason">How did you confirm execution stopped?</label><textarea id="tt-recover-reason" class="field" required rows={3} maxLength={1000} value={reason} disabled={busy} onInput={(event) => setReason(event.currentTarget.value)} />
      <label class="check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.currentTarget.checked)} /> I confirmed the original agent has stopped.</label>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !confirmed || !reason.trim()}>Release task</button></div>
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
      {!initial && !required ? <p class="help">Leave empty to use the folder mapped for this repository key in Settings → Team.</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps">{busy ? "Working…" : ""}</span><button type="button" class="btn" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" class="btn primary" disabled={busy || (required && !path.trim())}>{action}</button></div>
  </form></dialog>;
}
