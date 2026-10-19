import { useEffect, useState } from "preact/hooks";
import type { Board, BoardProject, InboxItem, Task, TaskStatus, TaskSummary } from "../src/collab/model.js";
import { Icon } from "./icons.js";
import { post, showToast, usePoll } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { ATTEMPT_LABEL, INBOX_LABEL, STATUS_LABEL, TASK_STATUSES, type Member, type TeamRoute, ago, attemptLive, attemptStale, board, boardError, boardLoaded, inboxOpen, inboxUnread, initials, loadBoard, loadInbox, loadTeamLink, markRead, teamLink, teamTick, whoLabel } from "./collab-state.js";

/**
 * The team board: every task of the projects you can see, in five status columns, with the inbox
 * beside them. The owner app and the shared dashboard render the same view; `shared` only hides what
 * needs this computer (the link callout), and `navigate` is whichever router the host page uses.
 */
export function TeamBoardView({ project, shared = false, navigate }: { project?: string; shared?: boolean; navigate: (to: TeamRoute) => void }) {
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(Date.now());
  // The owner app polls as a fallback to its stream; the shared dashboard reloads only on /api/team/events frames (and when its tab is shown again), so an idle shared session can still expire. The liveness clock ticks on its own, without a request.
  usePoll(() => { void loadBoard(); if (!shared) void loadTeamLink(); setNow(Date.now()); }, shared ? 0 : 15_000, [teamTick.value, shared]);
  usePoll(() => setNow(Date.now()), 15_000, [], shared);
  const b = board.value;
  const chosen = project && b?.projects.some((entry) => entry.id === project) ? project : undefined;
  if (!b) return <div class="team-page" aria-busy={!boardLoaded.value}>{boardError.value ? <p class="msg err" role="alert">{boardError.value} <button class="btn small" onClick={() => void loadBoard()}>Retry</button></p> : <p class="help" role="status">Loading the team board…</p>}</div>;
  const me = b.me.userId;
  const involvesMe = (task: TaskSummary) => task.owner?.userId === me || task.reviewer?.userId === me || task.collaborators.some((who) => who.userId === me) || (task.handoff?.state === "offered" && task.handoff.to.userId === me);
  const tasks = b.tasks.filter((task) => (!chosen || task.projectId === chosen) && (!mine || involvesMe(task)) && (!status || task.status === status));
  const canCreate = b.projects.some((entry) => roleAtLeast(entry.role, "contributor") && (!chosen || entry.id === chosen));
  const columns = status ? [status] : TASK_STATUSES;
  const projectOf = (task: TaskSummary) => b.projects.find((entry) => entry.id === task.projectId);
  const column = (state: TaskStatus) => {
    const items = tasks.filter((task) => task.status === state).sort((x, y) => y.updatedAt - x.updatedAt);
    return <section key={state} class="team-column" aria-labelledby={`team-col-${state}`}>
      <h2 id={`team-col-${state}`}>{STATUS_LABEL[state]}<span class="team-count">{items.length}</span></h2>
      {items.map((task) => <TaskCard key={task.id} task={task} me={me} project={chosen ? undefined : projectOf(task)} now={now} onOpen={() => navigate({ view: "team-task", id: task.id })} />)}
      {!items.length ? <p class="team-column-empty">No tasks</p> : null}
    </section>;
  };
  const link = teamLink.value;
  return <div class="team-page">
    {boardError.value ? <p class="msg err" role="alert">{boardError.value}</p> : null}
    <div class="page-head">
      <div class="page-head-text"><h1>Team</h1><p>{chosen ? `${b.projects.find((entry) => entry.id === chosen)?.name ?? "This project"} · Tasks, ownership, and reviews in one place.` : "Shared tasks, ownership, and reviews in one place."}</p></div>
      <div class="page-head-actions">{canCreate ? <button type="button" class="btn primary" aria-expanded={creating} onClick={() => setCreating(!creating)}><Icon name="plus" /> New task</button> : null}</div>
    </div>
    {!shared && link && !link.linked && !b.tasks.length ? <div class="settings-callout team-callout"><Icon name="people" /><div><strong>Not connected to a team server</strong><p>Connect this computer in Settings → Team to work on a shared board, or create tasks here to use this computer as the team server.</p><a href="#/settings/team">Open Settings → Team <span aria-hidden="true">→</span></a></div></div> : null}
    {b.projects.length > 1 || chosen ? <div class="team-chips" role="group" aria-label="Project">
      <button type="button" class="chip-tpl" aria-pressed={!chosen} onClick={() => navigate({ view: "team" })}>All projects</button>
      {b.projects.map((entry) => <button key={entry.id} type="button" class="chip-tpl" aria-pressed={chosen === entry.id} onClick={() => navigate({ view: "team", project: entry.id })}>{entry.name}</button>)}
    </div> : null}
    {creating && canCreate ? <NewTaskForm key={chosen ?? ""} b={b} projectId={chosen} shared={shared} onDone={() => { setCreating(false); void loadBoard(); }} onCancel={() => setCreating(false)} /> : null}
    <div class="team-toolbar">
      <div class="segmented small" role="group" aria-label="Whose tasks">
        <button type="button" class={mine ? "" : "on"} aria-pressed={!mine} onClick={() => setMine(false)}>All</button>
        <button type="button" class={mine ? "on" : ""} aria-pressed={mine} onClick={() => setMine(true)}>Mine</button>
      </div>
      <label class="team-filter">Status<select class="field" value={status} onChange={(event) => setStatus(event.currentTarget.value as TaskStatus | "")}><option value="">All statuses</option>{TASK_STATUSES.map((state) => <option key={state} value={state}>{STATUS_LABEL[state]}</option>)}</select></label>
      <span class="help" role="status">{tasks.length} of {b.tasks.length} tasks{mine ? " involve you" : ""}</span>
    </div>
    {!b.projects.length ? <p class="team-empty">{shared ? "You have no role in a shared project yet. Ask the owner for one." : "Create a project first: the board's tasks belong to projects, and teammates see the projects their accounts have a role in."}</p> : null}
    <div class="team-board">
      <div class={`team-columns ${columns.length === 1 ? "single" : ""}`}>{columns.map(column)}</div>
      <InboxPanel shared={shared} navigate={navigate} />
    </div>
  </div>;
}

function TaskCard({ task, me, project, now, onOpen }: { task: TaskSummary; me: string; project?: BoardProject; now: number; onOpen: () => void }) {
  const attempt = task.attempt;
  const live = attempt ? attemptLive(attempt, now) : false, stale = attempt ? attemptStale(attempt, now) : false;
  const offeredToMe = task.handoff?.state === "offered" && task.handoff.to.userId === me;
  const needsYou = (task.unreadMentions ?? 0) > 0 || offeredToMe;
  return <button type="button" class={`team-card ${needsYou ? "needs-you" : ""}`} onClick={onOpen}>
    <span class="tc-title">{task.title}</span>
    <span class="tc-meta">
      {task.owner ? <><span class="team-avatar" aria-hidden="true">{initials(task.owner.displayName)}</span><span>{whoLabel(task.owner, me)}</span></> : <span>Unassigned</span>}
      <code>{task.repository}</code>
      {project ? <span>{project.name}</span> : null}
    </span>
    {attempt ? <span class={`tc-attempt ${stale ? "team-stale" : live ? "team-live" : ""}`}>{live ? <span class="dot running" aria-hidden="true" /> : null}{stale ? `Connection lost · ${attempt.runnerName}` : `${ATTEMPT_LABEL[attempt.state]} on ${attempt.runnerName}`}{attempt.progress.stage && !stale ? ` · ${attempt.progress.stage}` : ""}</span> : null}
    <span class="pills">
      {task.reviewer ? <span class="badge">Reviewer {task.reviewer.userId === me ? "you" : task.reviewer.displayName}</span> : null}
      {task.reviewState === "approved" ? <span class="badge ok">Approved</span> : task.reviewState === "changes-requested" ? <span class="badge warn">Changes requested</span> : task.reviewState === "pending" ? <span class="badge">Review pending</span> : null}
      {task.handoff?.state === "offered" ? <span class="badge warn">Hand-over to {whoLabel(task.handoff.to, me)}</span> : null}
      {task.blocker ? <span class="badge warn" title={task.blocker}>Blocked</span> : null}
      {needsYou ? <span class="badge warn">Needs you</span> : null}
    </span>
  </button>;
}

/** The inline "New task" form: the fields a card needs now; everything else is edited on the task page. */
function NewTaskForm({ b, projectId: initial, shared, onDone, onCancel }: { b: Board; projectId?: string; shared: boolean; onDone: () => void; onCancel: () => void }) {
  const options = b.projects.filter((entry) => roleAtLeast(entry.role, "contributor"));
  const [projectId, setProjectId] = useState(initial && options.some((entry) => entry.id === initial) ? initial : options[0]?.id ?? "");
  const project = options.find((entry) => entry.id === projectId);
  const [title, setTitle] = useState(""), [repository, setRepository] = useState(project?.repositories[0]?.key ?? ""), [goal, setGoal] = useState(""), [acceptance, setAcceptance] = useState(""), [baseRef, setBaseRef] = useState(""), [owner, setOwner] = useState(""), [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setRepository(project?.repositories[0]?.key ?? ""); setOwner(""); setReviewer(""); }, [projectId]);
  const maintainer = roleAtLeast(project?.role, "maintainer");
  const members: Member[] = project?.members ?? [];
  const owners = members.filter((member) => roleAtLeast(member.role, "contributor") && (maintainer || member.userId === b.me.userId));
  const reviewers = members.filter((member) => roleAtLeast(member.role, "reviewer"));
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy || !project) return; setBusy(true); setError("");
    try {
      await post<Task>("/api/team/tasks", { projectId, repository, title: title.trim(), goal, acceptance, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}), ...(owner ? { owner } : {}), ...(reviewer ? { reviewer } : {}) });
      showToast("Task created"); onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <form id="team-new" class="team-section team-new" aria-labelledby="team-new-title" onSubmit={(event) => void submit(event)}>
    <h2 id="team-new-title">New task</h2>
    <div class="team-fields">
      {options.length > 1 ? <label>Project<select class="field" value={projectId} disabled={busy} onChange={(event) => setProjectId(event.currentTarget.value)}>{options.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label> : null}
      <label>Title<input class="field" required maxLength={200} value={title} disabled={busy} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>Repository<select class="field" required value={repository} disabled={busy || !project?.repositories.length} onChange={(event) => setRepository(event.currentTarget.value)}>{project?.repositories.map((repo) => <option key={repo.key} value={repo.key}>{repo.label} ({repo.key})</option>)}</select></label>
      <label>Base branch<input class="field" maxLength={100} placeholder={project?.repositories.find((repo) => repo.key === repository)?.defaultBranch ?? "The repository's default branch"} value={baseRef} disabled={busy} onInput={(event) => setBaseRef(event.currentTarget.value)} /></label>
      <label>Owner<select class="field" value={owner} disabled={busy} onChange={(event) => setOwner(event.currentTarget.value)}><option value="">Unassigned</option>{owners.map((member) => <option key={member.userId} value={member.userId}>{member.userId === b.me.userId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
      <label>Reviewer<select class="field" value={reviewer} disabled={busy} onChange={(event) => setReviewer(event.currentTarget.value)}><option value="">None yet</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === b.me.userId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
    </div>
    {project && !project.repositories.length ? <p class="msg warn" role="status">{project.name} has no repository keys yet. A maintainer defines repository keys in Settings → Team{!shared && maintainer ? <>: <a href="#/settings/team">open Settings → Team</a></> : null}.</p> : null}
    <label class="team-wide">Goal<textarea class="field" rows={4} maxLength={16384} placeholder="What should be true when this task is done, and why it matters" value={goal} disabled={busy} onInput={(event) => setGoal(event.currentTarget.value)} /></label>
    <label class="team-wide">Acceptance criteria<textarea class="field" rows={3} maxLength={8192} placeholder="How a reviewer will check the result" value={acceptance} disabled={busy} onInput={(event) => setAcceptance(event.currentTarget.value)} /></label>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <div class="team-actions"><button type="submit" class="btn primary" disabled={busy || !project?.repositories.length || !title.trim()}>{busy ? "Creating…" : "Create task"}</button><button type="button" class="btn" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

/** Your inbox: who assigned, mentioned or asked you, newest first; opening an item marks it read. Marking read also reloads the board, whose cards carry the "Needs you" badges the unread mentions put there. */
function InboxPanel({ shared, navigate }: { shared: boolean; navigate: (to: TeamRoute) => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  usePoll(async (current) => { try { const page = await loadInbox(); if (current()) { setItems(page.items); setError(""); } } catch (err) { if (current()) setError((err as Error).message); } }, shared ? 0 : 15_000, [teamTick.value]);
  useEffect(() => { if (!inboxOpen.value) return; inboxOpen.value = false; const heading = document.getElementById("team-inbox-title"); heading?.scrollIntoView({ block: "start" }); heading?.focus(); }, [inboxOpen.value]);
  const read = async (ids: string[] | "all") => { if (busy) return; setBusy(true); try { await markRead(ids); const page = await loadInbox(); setItems(page.items); void loadBoard(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const unread = inboxUnread.value;
  const sorted = (items ?? []).slice().sort((x, y) => Number(!!x.readAt) - Number(!!y.readAt) || y.at - x.at);
  return <section class="team-inbox" aria-labelledby="team-inbox-title">
    <div class="team-inbox-head"><h2 id="team-inbox-title" tabIndex={-1}>Inbox{unread ? <span class="team-count warn">{unread}</span> : null}</h2>{unread ? <button type="button" class="btn small" disabled={busy} onClick={() => void read("all")}>Mark all read</button> : null}</div>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {items === null && !error ? <p class="help" role="status">Loading…</p> : null}
    {items && !items.length ? <p class="pp-empty">Nothing yet. Assignments, mentions, review requests and hand-overs land here.</p> : null}
    {sorted.map((item) => <div key={item.id} class={`team-inbox-item ${item.readAt ? "" : "is-unread"}`}>
      <button type="button" class="ti-open" onClick={() => { if (!item.readAt) void read([item.id]); navigate({ view: "team-task", id: item.taskId }); }}>
        <span class="ti-title">{INBOX_LABEL[item.kind] ?? item.kind}{item.readAt ? "" : <span class="sr-only"> (unread)</span>} · {item.taskTitle}</span>
        <span class="ti-text">{item.text}</span>
        <span class="ti-meta">{item.by.displayName} · {ago(item.at)}</span>
      </button>
      {item.readAt ? null : <button type="button" class="btn small ghost" disabled={busy} aria-label={`Mark read: ${item.taskTitle}`} onClick={() => void read([item.id])}>Mark read</button>}
    </div>)}
  </section>;
}
