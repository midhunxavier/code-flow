import { ConnectComputer } from "./connect-computer.js";
import { executionHost } from "./ssh-projects.js";
import { SshTeamServerCard } from "./team-server-status.js";
import { TeamTerminalPanel } from "./team-terminals.js";
import { HostQueue } from "./host-execution.js";
import { TeamConnectionPicker } from "./team-connections.js";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { Board, BoardProject, InboxItem, Task, TaskStatus, TaskSummary } from "../src/collab/model.js";
import { TaskDraftAssistant } from "./task-draft.js";
import { readTaskDraft, saveTaskDraft, taskDraftKey } from "./team-task-draft.js";
import { Icon, type IconName } from "./icons.js";
import { post, showToast, usePoll, ownerOnLocalListener, teamConnectionRequired } from "./lib.js";
import { roleAtLeast } from "./shared-roles.js";
import { ATTEMPT_LABEL, INBOX_LABEL, STATUS_LABEL, TASK_STATUSES, type Member, type TeamRoute, ago, attemptLive, attemptSilent, attemptStale, board, boardError, boardLoaded, inboxOpen, inboxUnread, initials, loadBoard, loadInbox, loadTeamLink, markRead, teamLink, teamTick, whoLabel } from "./collab-state.js";

const STAGE: Record<TaskStatus, { icon: IconName; description: string; empty: string }> = {
  planned: { icon: "issue", description: "Ready to start", empty: "Nothing planned yet" },
  working: { icon: "play", description: "In progress", empty: "No work in progress" },
  blocked: { icon: "alert", description: "Needs attention", empty: "No blocked tasks" },
  review: { icon: "compare", description: "Awaiting feedback", empty: "Nothing awaiting review" },
  done: { icon: "check", description: "Completed work", empty: "Completed tasks appear here" },
};

/**
 * The team board: every task of the projects you can see, in five status columns, with the inbox
 * below them. The owner app and the shared dashboard render the same view; `shared` only hides what
 * needs this computer (the link callout), and `navigate` is whichever router the host page uses.
 */
export function TeamBoardView({ project, shared = false, embedded = false, navigate }: { project?: string; shared?: boolean; embedded?: boolean; navigate: (to: TeamRoute) => void }) {
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [creating, setCreating] = useState<false | "manual" | "agent">(false);
  const [now, setNow] = useState(Date.now());
  // The owner app polls as a fallback to its stream; the shared dashboard reloads only on /api/team/events frames (and when its tab is shown again), so an idle shared session can still expire. The liveness clock ticks on its own, without a request.
  usePoll(() => { void loadBoard(); if (!shared) void loadTeamLink(); setNow(Date.now()); }, shared ? 0 : 15_000, [teamTick.value, shared]);
  usePoll(() => setNow(Date.now()), 15_000, [], shared);
  const host = executionHost.value;
  const ssh = !shared && host.kind === "ssh" ? host : null;
  const b = board.value;
  const chosen = project;
  useEffect(() => { if (b && readTaskDraft(taskDraftKey(b.me.userId, project))) setCreating("manual"); else setCreating(false); }, [b?.me.userId, project]);
  if (!shared && teamConnectionRequired.value) return <div class="team-page"><TeamConnectionPicker /><p class="help" role="status">You have {teamConnectionRequired.value} team connections. Choose which board to open.</p></div>;
  if (!b) return <div class="team-page" aria-busy={!boardLoaded.value}>{!shared && !ssh && !embedded ? <TeamConnectionPicker /> : null}{boardError.value ? <p class="msg err" role="alert">{boardError.value} <button class="btn small" onClick={() => void loadBoard()}>Retry</button></p> : <p class="help" role="status">Loading the team board…</p>}</div>;
  if (project && !b.projects.some(entry => entry.id === project)) return <div class="team-page"><p role="alert">This project is unavailable on this board. Choose a project you have access to.</p><button class="btn" onClick={() => navigate({ view: "team" })}>All board projects</button></div>;
  const me = b.me.userId;
  const involvesMe = (task: TaskSummary) => task.owner?.userId === me || task.reviewer?.userId === me || task.collaborators.some((who) => who.userId === me) || (task.handoff?.state === "offered" && task.handoff.to.userId === me);
  const projectTasks = b.tasks.filter(task => !chosen || task.projectId === chosen);
  const tasks = projectTasks.filter(task => (!mine || involvesMe(task)) && (!status || task.status === status));
  const canCreate = b.projects.some((entry) => roleAtLeast(entry.role, "contributor") && (!chosen || entry.id === chosen));
  const columns = status ? [status] : TASK_STATUSES;
  const projectOf = (task: TaskSummary) => b.projects.find((entry) => entry.id === task.projectId);
  const column = (state: TaskStatus) => {
    const items = tasks.filter((task) => task.status === state).sort((x, y) => y.updatedAt - x.updatedAt);
    return <section key={state} class={`team-column stage-${state}`} aria-labelledby={`team-col-${state}`}>
      <header class="team-column-head"><h2 id={`team-col-${state}`}><span class="team-stage-icon"><Icon name={STAGE[state].icon} /></span>{STATUS_LABEL[state]}<span class="team-count">{items.length}</span></h2><p>{STAGE[state].description}</p></header>
      <div class="team-column-cards">{items.map((task) => <TaskCard key={task.id} task={task} me={me} project={chosen ? undefined : projectOf(task)} now={now} onOpen={() => navigate({ view: "team-task", id: task.id })} />)}
        {!items.length ? <div class="team-column-empty"><Icon name={STAGE[state].icon} /><p>{STAGE[state].empty}</p></div> : null}
      </div>
    </section>;
  };
  const link = teamLink.value;
  return <div class="team-page team-board-page">
    {boardError.value ? <p class="msg err" role="alert">{boardError.value}</p> : null}
    <div class="page-head team-board-head">
      <div class="page-head-text"><div class="collaboration-eyebrow"><Icon name="layers" /> Collaboration</div>{embedded ? <h2>Board</h2> : <h1>Board</h1>}<p>{ssh ? `Tasks, ownership and reviews on ${ssh.name}.` : chosen ? `${b.projects.find((entry) => entry.id === chosen)?.name ?? "This project"} · Tasks, ownership, and reviews in one place.` : "Shared tasks, ownership, and reviews in one place."}</p></div>
      <div class="page-head-actions"><button class="btn" onClick={() => navigate({ view: "team-people", ...(chosen ? { project: chosen } : {}) })}><Icon name="people" /> People</button>{canCreate && !shared && ownerOnLocalListener.value ? <button type="button" class="btn" disabled={!!creating} onClick={() => setCreating("agent")}><Icon name="sparkle" /> Draft with agent</button> : null}{canCreate ? <button type="button" class="btn primary" aria-expanded={!!creating} aria-controls={creating ? "team-new" : undefined} disabled={!!creating} onClick={() => setCreating("manual")}><Icon name="plus" /> New task</button> : null}</div>
    </div>
    {!shared && !ssh && !embedded ? <TeamConnectionPicker compact /> : null}
    {ssh && !embedded ? <><SshTeamServerCard key={ssh.id} host={ssh} /><div class="team-board-context"><strong>Viewing this computer’s board · {ssh.name}</strong><p>Tasks below belong to this computer. To use the shared team board, connect your computer with the team address and account from team server setup.</p></div></> : null}
    {shared && chosen ? <section class="settings-card project-welcome" aria-label="Project access"><strong>You’re in {b.projects.find(p => p.id === chosen)?.name}</strong><p class="help">Your project access is ready. {canCreate ? "Create tasks, discuss work, and review results. Coding on your computer is optional." : "You can view results" + (b.projects.find(p => p.id === chosen)?.role === "reviewer" ? ", comment, and review work. No computer setup needed." : ". No computer setup needed.")}</p>{canCreate ? <ConnectComputer project={b.projects.find(p => p.id === chosen)!} /> : null}</section> : null}
    {shared ? <TeamTerminalPanel board={b} project={chosen} /> : null}
    {!ssh && (shared || link && !link.linked) ? <HostQueue board={b} project={chosen} /> : null}
    {!shared && !ssh && link && !link.linked && !b.tasks.length ? <div class="settings-callout team-callout"><Icon name="people" /><div><strong>Not connected to a team server</strong><p>Connect this computer in Connections → Share access to work on a shared board, or create tasks here to use this computer as the team server.</p><a href="#/settings/connections/sharing">Open Connections → Share access <span aria-hidden="true">→</span></a></div></div> : null}
    {b.projects.length > 1 || chosen ? <div class="team-chips" role="group" aria-label="Project">
      <button type="button" class="chip-tpl" aria-pressed={!chosen} onClick={() => navigate({ view: "team" })}>All projects</button>
      {b.projects.map((entry) => <button key={entry.id} type="button" class="chip-tpl" aria-pressed={chosen === entry.id} onClick={() => navigate({ view: "team", project: entry.id })}>{entry.name}</button>)}
    </div> : null}
    {creating && canCreate ? <NewTaskForm key={chosen ?? ""} b={b} projectId={chosen} shared={shared} draftWithAgent={creating === "agent"} onDone={(task) => { const open = creating === "agent"; setCreating(false); void loadBoard(); if (open) navigate({ view: "team-task", id: task.id }); }} onCancel={() => setCreating(false)} /> : null}
    <div class="team-toolbar">
      <div class="segmented small" role="group" aria-label="Whose tasks">
        <button type="button" class={mine ? "" : "on"} aria-pressed={!mine} onClick={() => setMine(false)}>All</button>
        <button type="button" class={mine ? "on" : ""} aria-pressed={mine} onClick={() => setMine(true)}>Mine</button>
      </div>
      <label class="team-filter">Status<select class="field" value={status} onChange={(event) => setStatus(event.currentTarget.value as TaskStatus | "")}><option value="">All statuses</option>{TASK_STATUSES.map((state) => <option key={state} value={state}>{STATUS_LABEL[state]}</option>)}</select></label>
      <span class="help team-task-count" role="status">{mine || status ? `${tasks.length} of ${projectTasks.length} tasks${mine ? " involve you" : ""}` : `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}</span>
      {tasks.length && !status ? <span class="team-board-hint">Scroll to see all stages <Icon name="chevron" /></span> : null}
    </div>
    {!b.projects.length ? <p class="team-empty">{shared ? "You have no role in a shared project yet. Ask the owner for one." : "Create a project first: the board's tasks belong to projects, and teammates see the projects their accounts have a role in."}</p> : null}
    <div class="team-board">
      {tasks.length ? <div class={`team-columns ${columns.length === 1 ? "single" : ""}`} role="region" aria-label="Task board" tabIndex={0}>{columns.map(column)}</div> : <section class="team-board-empty" aria-label="Task board">
        <div class="team-workflow" aria-label="Task workflow">{TASK_STATUSES.map(state => <span key={state}>{STATUS_LABEL[state]}<span class="team-count">{projectTasks.filter(task => task.status === state).length}</span></span>)}</div>
        <div class="team-board-empty-body"><Icon name="people" /><h2>{projectTasks.length ? "No tasks match these filters" : "Your board is ready for its first task"}</h2>
          <p>{projectTasks.length ? "Try another status or show everyone’s tasks." : "Give a task a goal and an owner. Follow its progress here, from planning through review to done."}</p>
          {mine || status ? <button class="btn" onClick={() => { setMine(false); setStatus(""); }}>Clear filters</button> : canCreate ? <button class="btn primary" disabled={!!creating} onClick={() => setCreating("manual")}><Icon name="plus" /> Create first task</button> : <p class="help">{shared ? "Ask your project maintainer for access to create tasks." : "Add a project to start creating tasks."}</p>}
        </div>
      </section>}

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
    <span class="tc-context"><span class="tc-repository" title={task.repository}><Icon name="folder" /><code>{task.repository}</code></span>{needsYou ? <span class="tc-attention">Needs you</span> : null}</span>
    <span class="tc-title">{task.title}</span>
    {project ? <span class="tc-project">{project.name}</span> : null}
    {attempt ? <span class={`tc-attempt ${stale ? "team-stale" : live ? "team-live" : ""}`}>{live ? <span class="dot running" aria-hidden="true" /> : <Icon name={stale ? "alert" : "terminal"} />}<span>{stale ? `${attemptSilent(attempt, now) ? "Connection lost" : ATTEMPT_LABEL.unknown} · ${attempt.runnerName}` : `${ATTEMPT_LABEL[attempt.state]} on ${attempt.runnerName}`}{attempt.progress.stage && !stale ? <span class="tc-stage">{attempt.progress.stage}</span> : null}</span></span> : null}
    {task.blocker ? <span class="tc-blocker"><Icon name="alert" /><span>{task.blocker}</span></span> : null}
    <span class="pills">
      {task.reviewer ? <span class="badge">Reviewer {task.reviewer.userId === me ? "you" : task.reviewer.displayName}</span> : null}
      {task.reviewState === "approved" ? <span class="badge ok">Approved</span> : task.reviewState === "changes-requested" ? <span class="badge warn">Changes requested</span> : task.reviewState === "pending" ? <span class="badge">Review pending</span> : null}
      {task.handoff?.state === "offered" ? <span class="badge warn">Hand-over to {whoLabel(task.handoff.to, me)}</span> : null}
    </span>
    <span class="tc-footer"><span class="tc-owner" title={task.owner ? whoLabel(task.owner, me) : "Unassigned"}><span class={`team-avatar ${task.owner ? "" : "unassigned"}`} aria-hidden="true">{task.owner ? initials(task.owner.displayName) : <Icon name="people" />}</span><span>{task.owner ? whoLabel(task.owner, me) : "Unassigned"}</span></span><time class="tc-updated" dateTime={new Date(task.updatedAt).toISOString()} title={`Updated ${new Date(task.updatedAt).toLocaleString()}`}><span class="sr-only">Updated </span>{ago(task.updatedAt)}</time></span>
  </button>;
}

/** The inline "New task" form: the fields a card needs now; everything else is edited on the task page. */
function NewTaskForm({ b, projectId: initial, shared, draftWithAgent, onDone, onCancel }: { b: Board; projectId?: string; shared: boolean; draftWithAgent?: boolean; onDone: (task: Task) => void; onCancel: () => void }) {
  const options = b.projects.filter((entry) => roleAtLeast(entry.role, "contributor"));
  const draftKey = taskDraftKey(b.me.userId, initial);
  const [saved] = useState(() => { const draft = readTaskDraft(draftKey); return draft && options.some(entry => entry.id === draft.projectId) && (!initial || initial === draft.projectId) ? draft : null; });
  const [projectId, setProjectId] = useState(initial && options.some((entry) => entry.id === initial) ? initial : options.some(entry => entry.id === saved?.projectId) ? saved!.projectId : options[0]?.id ?? "");
  const project = options.find((entry) => entry.id === projectId);
  const [title, setTitle] = useState(saved?.title ?? ""), [repository, setRepository] = useState(project?.repositories.some(repo => repo.key === saved?.repository) ? saved!.repository : project?.repositories[0]?.key ?? ""), [goal, setGoal] = useState(saved?.goal ?? ""), [acceptance, setAcceptance] = useState(saved?.acceptance ?? ""), [baseRef, setBaseRef] = useState(saved?.baseRef ?? ""), [owner, setOwner] = useState(saved?.owner ?? (draftWithAgent ? b.me.userId : "")), [reviewer, setReviewer] = useState(saved?.reviewer ?? "");
  const [saving, setSaving] = useState(false), [draftBusy, setDraftBusy] = useState(false), [drafting, setDrafting] = useState(!!draftWithAgent), [draftApplied, setDraftApplied] = useState(false);
  const busy = saving || draftBusy;
  const [error, setError] = useState("");
  const [draftSaved, setDraftSaved] = useState(true);
  useLayoutEffect(() => { setDraftSaved(saveTaskDraft(draftKey, { projectId, repository, title, goal, acceptance, baseRef, owner, reviewer })); }, [draftKey, projectId, repository, title, goal, acceptance, baseRef, owner, reviewer]);
  useEffect(() => { if (draftSaved) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [draftSaved]);
  const cancel = () => { saveTaskDraft(draftKey, null); onCancel(); };
  const maintainer = roleAtLeast(project?.role, "maintainer");
  const members: Member[] = project?.members ?? [];
  const owners = members.filter((member) => roleAtLeast(member.role, "contributor") && (maintainer || member.userId === b.me.userId));
  const reviewers = members.filter(member => roleAtLeast(member.role, "reviewer") && member.userId !== owner);
  const submit = async (event: Event) => {
    event.preventDefault(); if (busy || !project) return; setSaving(true); setError("");
    try {
      const created = await post<Task>("/api/team/tasks", { projectId, repository, title: title.trim(), goal, acceptance, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}), ...(owner ? { owner } : {}), ...(reviewer ? { reviewer } : {}) });
      saveTaskDraft(draftKey, null); showToast("Task created"); onDone(created);
    } catch (err) { setError((err as Error).message); } finally { setSaving(false); }
  };
  return <form id="team-new" class="team-section team-new" aria-labelledby="team-new-title" onSubmit={(event) => void submit(event)}>
    <header class="task-create-head"><div><h2 id="team-new-title">New task</h2><p>Define the outcome, then choose who’s involved.</p></div><button type="button" class="icon-btn" aria-label="Close new task" disabled={busy} onClick={cancel}><Icon name="close" /></button></header>
    <div class="task-create-layout">
      <div class="task-create-content">
        {draftApplied ? <p class="msg ok" role="status">Draft applied. Review and edit the fields, then create the task.</p> : null}
        {!shared && drafting ? <TaskDraftAssistant key={`${projectId}/${repository}`} projectId={projectId} repository={repository} baseRef={baseRef} onBusy={setDraftBusy} onApply={(draft) => { setTitle(draft.title); setGoal(draft.goal); setAcceptance(draft.acceptance); setDrafting(false); setDraftApplied(true); }} /> : null}
        <label class="task-create-title">Title<input class="field" required maxLength={200} placeholder="A short, specific name for the work" value={title} disabled={busy} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
        <label>Goal<textarea class="field" rows={4} maxLength={16384} placeholder="What should be true when this task is done, and why it matters" value={goal} disabled={busy} onInput={(event) => setGoal(event.currentTarget.value)} /></label>
        <label>Acceptance criteria<textarea class="field" rows={3} maxLength={8192} placeholder="How a reviewer will check the result" value={acceptance} disabled={busy} onInput={(event) => setAcceptance(event.currentTarget.value)} /></label>
      </div>
      <aside class="task-create-settings" aria-label="Task settings">
        <fieldset><legend><Icon name="folder" /> Workspace</legend><div class="task-create-fields">
          {options.length > 1 ? <label>Project<select class="field" value={projectId} disabled={busy} onChange={(event) => { const id = event.currentTarget.value; setProjectId(id); setRepository(options.find(entry => entry.id === id)?.repositories[0]?.key ?? ""); setOwner(draftWithAgent ? b.me.userId : ""); setReviewer(""); }}>{options.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label> : null}
          <label>Repository<select class="field" required value={repository} disabled={busy || !project?.repositories.length} onChange={(event) => setRepository(event.currentTarget.value)}>{project?.repositories.map((repo) => <option key={repo.key} value={repo.key}>{repo.label} ({repo.key})</option>)}</select></label>
          <label>Base branch<input class="field" maxLength={100} placeholder={project?.repositories.find((repo) => repo.key === repository)?.defaultBranch ?? "The repository's default branch"} value={baseRef} disabled={busy} onInput={(event) => setBaseRef(event.currentTarget.value)} /></label>
        </div></fieldset>
        {project && !project.repositories.length ? <p class="msg warn" role="status">{project.name} has no repository keys yet. A maintainer defines repository keys in Connections → Share access{!shared && maintainer ? <>: <a href="#/settings/connections/manage">open Connections → Share access</a></> : null}.</p> : null}
        <fieldset><legend><Icon name="people" /> Assignment</legend><div class="task-create-fields task-create-assignees">
          <label>Owner<select class="field" value={owner} disabled={busy} onChange={(event) => { const next = event.currentTarget.value; setOwner(next); if (reviewer === next) setReviewer(""); }}><option value="">Unassigned</option>{owners.map((member) => <option key={member.userId} value={member.userId}>{member.userId === b.me.userId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
          <label>Reviewer<select class="field" value={reviewer} disabled={busy} onChange={(event) => setReviewer(event.currentTarget.value)}><option value="">None yet</option>{reviewers.map((member) => <option key={member.userId} value={member.userId}>{member.userId === b.me.userId ? `${member.displayName} (you)` : member.displayName}</option>)}</select></label>
        </div><p class="help">You can assign teammates later.</p></fieldset>
      </aside>
    </div>
    <p class="help" role="status">{draftSaved ? "Draft saved in this tab for this team." : "Draft storage is unavailable. Keep this page open until you create the task."}</p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    <footer class="task-create-footer"><p><span class="dot" aria-hidden="true" /> Your task will appear in Planned.</p><div class="team-actions"><button type="button" class="btn ghost" disabled={busy} onClick={cancel}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !project?.repositories.length || !title.trim()}><Icon name="plus" />{saving ? "Creating…" : "Create task"}</button></div></footer>
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
