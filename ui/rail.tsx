import { ChatRowMenu } from "./chat-row-menu.js";
import { useDialog } from "./app.js";
import { runTitle } from "../src/run-title.js";
import { sidebarStatusLabel as statusText } from "./run-experience.js";
import { dispatchLabel } from "../src/run-outcome.js";
import { chatTaskId, chatUpdatedAt, groupChatTasks } from "../src/chat-family.js";
import { peopleEnabled } from "./preferences.js";
import { DesktopUpdateNotice } from "./desktop-updates.js";
import { chats, watchChats, openChat, chatQuery, archivedChats, chatSearchTarget } from "./chat-state.js";
import { ComputerProjects, useComputerProjects } from "./connected-projects.js";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { inbox } from "./automations.js";
import { pendingApprovals } from "./approval-inbox.js";
import { Icon } from "./icons.js";
import { Menu, MenuItem } from "./panel-bits.js";
import { ArchiveDialog, DeleteRunsDialog } from "./run-actions.js";
import { store, ownerOnLocalListener, collaborationConfigured, api, ago, baseName, fmtCost, fmtTokens, post, showToast, showError, STATUS_TEXT } from "./lib.js";
import {
  NONE,
  lastAgentTabs,
  agentTabClosed,
  setSideChat,
  openSide,
  draftsReady,
  composerLoading,
  agents,
  editProject,
  filterActive,
  health,
  healthOpen,
  attentionTotal,
  attentionTruncated,
  ALL,
  historyNextCursor,
  historyLoading,
  historyLoadingMore,
  historyError,
  loadOlderRuns,
  retryHistory,
  projectCounts,
  projectCountsError,
  refreshProjectCounts,
  watchProjectCounts,
  isFlagged,
  matchesFilter,
  needsYou,
  patterns,
  projectEdit,
  projectFor,
  projects,
  projectsOpen,
  railOpen,
  setRailCollapsed, peekRail, railPeek, railIsCollapsed, railDisplayWidth, railMaxWidth, setRailWidth,
  railView,
  repo,
  route,
  runFilter,
  runs,
  runState,
  openComposer,
  setRailView,
  setRunFilter,
  shortcutsOpen,
} from "./state.js";
import type { Project, RunSummary } from "./types.js";
import { teamAwaitingAnswer, teamNeedsResume } from "./team-state.js";
import { inboxUnread } from "./collab-state.js";

/** A project lists this many runs until you ask for the rest. */
const PER_PROJECT = 5;

function RailResizeHandle() {
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stop = (event: PointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null; setDragging(false);
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  return <div class={`rail-handle ${dragging ? "dragging" : ""}`} role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="run-navigation" aria-valuemin={220} aria-valuemax={railMaxWidth.value} aria-valuenow={railDisplayWidth.value} aria-valuetext={`${railDisplayWidth.value} pixels`} title="Drag or use arrow keys to resize; double-click to reset"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); event.currentTarget.focus();
      drag.current = { pointer: event.pointerId, x: event.clientX, width: railDisplayWidth.value };
      event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => { const start = drag.current; if (start?.pointer === event.pointerId) setRailWidth(start.width + event.clientX - start.x); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onDblClick={() => setRailWidth(null)}
    onKeyDown={event => {
      const width = event.key === "ArrowLeft" ? railDisplayWidth.value - 24 : event.key === "ArrowRight" ? railDisplayWidth.value + 24 : event.key === "Home" ? 220 : event.key === "End" ? railMaxWidth.value : undefined;
      if (width !== undefined) { event.preventDefault(); event.stopPropagation(); setRailWidth(width); }
    }} />;
}

const short = (ts: number) => ago(ts).replace(" ago", "").replace("just now", "now");

interface Group {
  key: string;
  project?: Project;
  name: string;
  runs: RunSummary[];
  /** The newest run in the project, whichever section it's listed in: projects sort by it. */
  last: number;
  archived: number;
}

/**
 * The sidebar, as in Claude's apps: new run and the app's pages on top, then what needs you, then
 * every project with its runs. Nothing in it depends on a project you picked somewhere else.
 */
export function Rail() {
  const [projectsCollapsed, setProjectsCollapsed] = useState(() => store.get("railProjectsCollapsed") === "1");
  const collapseProjects = (value: boolean) => { setProjectsCollapsed(value); store.set("railProjectsCollapsed", value ? "1" : "0"); };
  const [phone, setPhone] = useState(() => window.matchMedia?.("(max-width: 760px)").matches ?? false);
  useEffect(() => { const media = window.matchMedia("(max-width: 760px)"), change = () => setPhone(media.matches); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  const drawer = useDialog(phone && railOpen.value, () => { railOpen.value = false; });
  const railRef = useCallback((element: HTMLElement | null) => drawer(element instanceof HTMLDialogElement ? element : null), [drawer]);
  const RailElement = phone ? "dialog" : "nav";
  useEffect(watchProjectCounts, []);
  useEffect(watchChats, []);
  const computerProjects = useComputerProjects();
  const computers = computerProjects.directory;
  const currentComputer = computers && computers.computers.length > 1 ? computers.computers.find((computer) => computer.id === computers.currentComputerId) : undefined;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState<RunSummary[] | null>(null);
  const [cleaning, setCleaning] = useState<{ run: RunSummary; members?: RunSummary[] } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const view = railView.value;
  const long = new Set(view.expanded ?? []);
  const setLong = (keys: Set<string>) => setRailView({ expanded: [...keys] });
  const f = runFilter.value;
  useEffect(() => { const timer = setTimeout(() => { chatQuery.value = f.q; }, 200); return () => clearTimeout(timer); }, [f.q]);
  const filtering = filterActive.value;
  const r = route.value;
  const current = r.view === "run" || r.view === "review" ? r.id : undefined;
  /** The project whose page is open. */
  const page = r.view === "project" ? r.id : undefined;
  const ownedRunIds = new Set(chats.value.flatMap(chat => chat.runIds));
  const tasks = groupChatTasks([...runs.value.values()].filter(run => !ownedRunIds.has(run.id) && run.cliTeam?.taskConversation?.phase !== "preparation"));
  const families = new Map(tasks.map(task => [task.root.id, task]));
  const members = (run: RunSummary) => families.get(run.id)?.chats ?? [run];
  const approvalRunIds = new Set(pendingApprovals.value.filter(record => record.status === "pending").map(record => record.runId));
  const waitingForUser = (chat: RunSummary) => !!chat.awaiting || teamAwaitingAnswer(chat) || chat.status === "running" && (chat.approvalPending === true || approvalRunIds.has(chat.id));
  const taskArchived = (run: RunSummary) => members(run).every(chat => chat.archived);
  const taskRunning = (run: RunSummary) => members(run).some(chat => chat.status === "running");
  const taskNeedsYou = (run: RunSummary) => members(run).some(chat => waitingForUser(chat) || needsYou(chat));
  const taskFlagged = (run: RunSummary) => members(run).some(isFlagged);
  const activityAt = (run: RunSummary) => families.get(run.id)?.updatedAt ?? run.createdAt;
  const activity = (run: RunSummary) => {
    const chats = members(run).filter(chat => !chat.archived).sort((a, b) => chatUpdatedAt(b) - chatUpdatedAt(a));
    return chats.find(waitingForUser) ?? chats.find(chat => chat.status === "running") ?? chats.find(needsYou) ?? chats[0] ?? run;
  };
  const currentTask = current && runs.value.get(current) ? chatTaskId(runs.value.get(current)!) : current;
  const all = tasks.map(task => task.root);
  const list = all.filter(run => members(run).some(chat => matchesFilter(chat) && (!chat.archived || view.archived)));
  const archivedCount = projectCounts.value?.[""]?.archivedTasks;
  const eligible = list.filter(run => !taskRunning(run));
  const eligibleKey = eligible.map(run => run.id).join(",");
  const selectedRuns = eligible.filter(run => selected.has(run.id));
  useEffect(() => {
    const ids = new Set(eligibleKey.split(","));
    setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
    setBulkError("");
  }, [eligibleKey]);
  const deselect = (id: string) => setSelected(previous => { const next = new Set(previous); next.delete(id); return next; });
  const toggleSelected = (id: string) => { setBulkError(""); setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); };
  const familyForAction = async (run: RunSummary) => run.pattern === "solo" ? await api<RunSummary[]>(`/api/runs/${run.id}/chats`) : [run];
  const archiveTask = async (run: RunSummary, archived: boolean) => {
    const family = await familyForAction(run);
    if (family.some(chat => chat.status === "running")) throw new Error("Finish or stop all chats in this task before archiving it");
    for (const chat of family) await post(`/api/runs/${chat.id}/archive`, { archived, cleanup: false });
  };
  /** Archive with its worktrees removed: an Agent conversation as a whole, as its chats share one workspace. */
  const cleanUpTask = async (run: RunSummary) => {
    const family = await familyForAction(run);
    if (family.some(chat => chat.status === "running")) throw new Error("Finish or stop all chats in this task before archiving it");
    setCleaning(run.pattern === "solo" ? { run, members: family } : { run });
  };
  const deleteTasks = async (selected: RunSummary[]) => {
    setBulkError("");
    try {
      const chats = (await Promise.all(selected.map(familyForAction))).flat();
      if (chats.some(chat => chat.status === "running")) throw new Error("Finish or stop all chats in this task before deleting it");
      setBulkDeleting(chats.sort((a, b) => Number(!a.taskExecution) - Number(!b.taskExecution) || Number(!a.chatLink) - Number(!b.chatLink)));
    } catch (error) { showError((error as Error).message); }
  };
  const archiveSelected = async (archived: boolean) => {
    setBulkBusy(true); setBulkError("");
    const failures: string[] = [];
    let count = 0;
    for (const run of selectedRuns) {
      try { await archiveTask(run, archived); deselect(run.id); count++; }
      catch (error) { failures.push(`${run.task.split("\n")[0]}: ${(error as Error).message}`); }
    }
    if (count) showToast(`${count} ${count === 1 ? "chat" : "chats"} ${archived ? "archived" : "unarchived"}`);
    setBulkError(failures.join("\n")); setBulkBusy(false);
  };
  const waiting = list.filter(taskNeedsYou);
  const pending = projectCounts.value?.[ALL]?.inboxRuns ?? inbox().length;
  const unread = inboxUnread.value;
  const collapsed = railIsCollapsed.value;
  // Paused by a filesystem restriction isn't something to set up: the CLIs are there, just not probed.
  const agentsPaused = agents.value.some((agent) => agent.unavailableReason === "filesystem-policy");
  const agentProblems = agentsPaused ? 0 : agents.value.filter((agent) => !agent.available || health.value?.find((entry) => entry.id === agent.id)?.signedIn === false).length;

  const go = (to: typeof route.value) => {
    route.value = to;
    railOpen.value = false;
  };
  const newRunIn = (p: Project) => {
    openChat(p.id);
  };
  const toggle = (key: string) =>
    setRailView({ collapsed: view.collapsed.includes(key) ? view.collapsed.filter((k) => k !== key) : [...view.collapsed, key] });

  const renderedRuns = new Set<string>();
  const row = (r: RunSummary, meta: string) => {
    renderedRuns.add(r.id);
    const state = activity(r), archived = taskArchived(r), working = taskRunning(r);
    const active = currentTask === chatTaskId(r);
    const openTask = () => {
      if (r.cliTeam?.taskConversation) { go({ view: "task", id: r.cliTeam.taskConversation.id }); return; }
      const chats = members(r).filter(chat => !chat.archived);
      const main = chats.filter(chat => chat.chatLink?.kind !== "side");
      const opened = main.filter(chat => !agentTabClosed(chat));
      const choices = opened.length ? opened : main;
      const waiting = chats.find(waitingForUser);
      const preferred = choices.find(chat => chat.id === (active ? current : lastAgentTabs.value[chatTaskId(r)])) ?? choices.find(needsYou) ?? choices.at(-1) ?? r;
      if (waiting?.chatLink?.kind === "side") { setSideChat(waiting.id, `run:${chatTaskId(r)}`); openSide("chat"); }
      go({ view: "run", id: waiting && waiting.chatLink?.kind !== "side" ? waiting.id : preferred.id });
    };
    const tokens = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    const p = projectFor(r);
    const details = [
      statusText(state),
      taskFlagged(r) ? "tests changed in ways that could hide failures" : "",
      patterns.value.find((x) => x.id === r.pattern)?.name ?? r.pattern,
      p ? (p.repos.length > 1 ? `${p.name} · ${baseName(r.repo)}` : p.name) : baseName(r.repo),
      ago(activityAt(r)),
      tokens ? `${fmtTokens(tokens)} tok` : "",
      r.usage?.costUsd ? fmtCost(r.usage.costUsd) : "",
    ].filter(Boolean);
    return (
      <div class={`rail-run-row ${selecting ? "selecting" : ""}`} role="group" aria-label={runTitle(r)} key={r.id}>
      {selecting ? <input type="checkbox" class="rail-run-check" aria-label={`Select ${runTitle(r)}`} checked={selected.has(r.id)} disabled={bulkBusy || !!bulkDeleting || working} onChange={() => toggleSelected(r.id)} /> : null}
      <button
        key={r.id}
        type="button"
        data-task={chatTaskId(r)}
        class={`run-item ${active ? "active" : ""} ${taskNeedsYou(r) ? "unseen" : ""} ${archived ? "archived" : ""}`}
        title={`${runTitle(r)}\n${details.join(" · ")}`}
        aria-current={active ? "page" : undefined}
        disabled={selecting && (bulkBusy || !!bulkDeleting || working)}
        onClick={() => selecting ? toggleSelected(r.id) : openTask()}
      >
        <span class={`dot ${dispatchLabel(state) === "Dispatch paused" ? "stopped" : runState(state)}`} aria-hidden="true" />
        <span class="t">
          {/* how it started: the same marks as the Automations inbox */}
          {r.trigger ? <Icon name={r.trigger.via === "sweep" ? "layers" : r.trigger.via === "webhook" ? "globe" : "clock"} class="inline-icon" /> : null}
          {r.group ? <Icon name="compare" class="inline-icon" /> : null}
          {runTitle(r)}
        </span>
        <span class="m">
          {taskFlagged(r) ? (
            <span class="flag">
              <Icon name="alert" />
            </span>
          ) : null}
          {meta}
        </span>
        <span class="sr-only">
          {" "}
          · {statusText(state)}
          {archived ? " · archived" : ""}
        </span>
      </button>
      {!selecting ? <Menu above class="chat-choice rail-run-menu" label="Chat actions" icon="more">
        {close => <>
          <MenuItem disabled={working} onClick={() => {
            close();
            archiveTask(r, !archived).then(() => showToast(archived ? "Chat unarchived" : "Chat archived"), error => showError(error.message));
          }}>{archived ? "Unarchive" : "Archive"}</MenuItem>
          <MenuItem disabled={working} onClick={() => { close(); cleanUpTask(r).catch(error => showError(error.message)); }}>{archived ? "Clean up…" : "Archive and clean up…"}</MenuItem>
          <MenuItem disabled={working} onClick={() => { close(); void deleteTasks([r]); }}>Delete…</MenuItem>
        </>}
      </Menu> : null}
      </div>
    );
  };

  const actions = (p: Project) => (
    <span class="proj-actions">
      <Menu label={`Project actions for ${p.name}`} icon="more" class="proj-more">{close => <><MenuItem onClick={() => { close(); route.value = { view: "project", id: p.id, section: "settings" }; }}>Project settings</MenuItem><MenuItem onClick={() => { close(); route.value = { view: "project", id: p.id, section: "runs" }; }}>History</MenuItem><MenuItem onClick={() => { close(); editProject(p.id); }}>Rename or edit project</MenuItem></>}</Menu>
      <button type="button" class="icon-btn" disabled={!draftsReady.value || composerLoading.value} aria-label={`New chat in ${p.name}`} title={`New chat in ${p.name}`} onClick={() => newRunIn(p)}>
        <Icon name="compose" />
      </button>
    </span>
  );

  const visibleChats = chats.value.filter(chat => {
    if (f.q && !chat.title.toLowerCase().includes(f.q.toLowerCase()) && !chat.match) return false;
    if (f.pattern || f.agent || f.repo) return chat.runIds.some(id => { const run = runs.value.get(id); return !!run && matchesFilter(run); });
    return f.status === "all" || f.status === "running" && ["Working", "Responding", "Paused"].includes(chat.status) || f.status === "attention" && ["Needs attention", "Approach ready", "Waiting for your decision", "Inspect preserved work", "Allowance reached"].includes(chat.status) || f.status === "passed" && chat.status === "Changes verified" || f.status === "failing" && ["Needs attention", "Stopped with partial work", "Allowance reached", "Inspect preserved work"].includes(chat.status);
  });
  const chatRow = (chat: typeof chats.value[number]) => <div class="rail-run-row" role="group" aria-label={chat.title} key={chat.id}><button type="button" data-chat={chat.id} class={`run-item ${r.view === "chat" && r.id === chat.id ? "active" : ""}`} aria-current={r.view === "chat" && r.id === chat.id ? "page" : undefined} title={`${chat.title}\n${chat.status}`} onClick={() => { if (chat.match) chatSearchTarget.value = { id: chat.id, sequence: chat.match.sequence }; go({ view: "chat", id: chat.id }); }}><span class={`dot ${chat.status === "Working" || chat.status === "Responding" ? "running" : "done"}`} aria-hidden="true"/><span class="t">{chat.pinned ? "⌁ " : ""}{chat.title}</span><span class="m">{short(chat.updatedAt)}</span><span class="chat-sidebar-status">{chat.status}</span>{chat.match ? <span class="chat-search-snippet">{chat.match.snippet}</span> : null}</button><ChatRowMenu chat={chat}/></div>;

  /** One project: its header folds it; its runs, newest first, a few at a time. */
  const projectGroup = (g: Group) => {
    const conversations = visibleChats.filter(chat => chat.project === (g.project?.id ?? ""));
    const chatKey = `chats:${g.key}`, shownChats = long.has(chatKey) || filtering ? conversations : conversations.slice(0, PER_PROJECT);
    const chatRows = <>{shownChats.map(chatRow)}{conversations.length > shownChats.length ? <button class="rail-more" onClick={() => setLong(new Set([...long, chatKey]))}>Show {conversations.length - shownChats.length} more chats</button> : null}</>;
    // A project with nothing to list is just its name: there's nothing to fold.
    if (!g.runs.length && !conversations.length)
      return (
        <div key={g.key} class="proj quiet" role="group" aria-label={g.name}>
          <div class={`proj-head ${page && page === g.project?.id ? "here" : ""}`}>
            {g.project ? (
              <button type="button" class="proj-name" title={`Open ${g.name}: ${g.project.repos.join(", ")}`} aria-current={page === g.project.id ? "page" : undefined} onClick={() => go({ view: "project", id: g.project!.id })}>
                <Icon name="folder" /><span class="pn">{g.name}</span>
                {g.archived ? <span class="pc">{g.archived} loaded archived</span> : null}
              </button>
            ) : (
              <span class="proj-name">
                <span class="pn">{g.name}</span>
              </span>
            )}
            {g.project ? actions(g.project) : null}
          </div>
          {chatRows}
        </div>
      );
    const folded = view.collapsed.includes(g.key);
    const showAll = long.has(g.key) || filtering;
    const shown = folded ? g.runs.filter((r) => chatTaskId(r) === currentTask) : showAll ? g.runs : g.runs.slice(0, PER_PROJECT);
    const hidden = folded ? 0 : g.runs.length - shown.length;
    const hiddenSelected = g.runs.filter(run => selected.has(run.id) && !shown.some(item => item.id === run.id)).length;
    return (
      <div key={g.key} class="proj" role="group" aria-label={g.name}>
        <div class={`proj-head ${page && page === g.project?.id ? "here" : ""}`}>
          <button type="button" class="proj-fold" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} the chats in ${g.name}`} title={folded ? "Show its chats" : "Hide its chats"} onClick={() => toggle(g.key)}>
            <Icon name="chevron" class="caret" />
          </button>
          <button
            type="button"
            class="proj-toggle"
            aria-current={g.project && page === g.project.id ? "page" : undefined}
            title={g.project ? `Open ${g.name}: ${g.project.repos.join(", ")}` : "Runs whose project was deleted"}
            onClick={() => (g.project ? go({ view: "project", id: g.project.id }) : toggle(g.key))}
          >
            <span class="pn">{g.name}</span>
            {folded ? <span class="pc">{g.runs.length + conversations.length}{hiddenSelected ? ` · ${hiddenSelected} selected` : ""}</span> : null}
          </button>
          {g.project ? actions(g.project) : null}
        </div>
        {!folded ? chatRows : null}
        {shown.map((r) => row(r, short(activityAt(r))))}
        {hidden > 0 ? (
          <button type="button" class="rail-more" onClick={() => setLong(new Set([...long, g.key]))}>
            Show {hidden} more{hiddenSelected ? ` (${hiddenSelected} selected)` : ""}
          </button>
        ) : null}
      </div>
    );
  };

  let body;
  if (view.group === "status") {
    const sections: [string, RunSummary[]][] = [
      ["Needs you", waiting],
      ["Running", list.filter((r) => taskRunning(r) && !taskNeedsYou(r))],
      ["Recent", list.filter((r) => !taskArchived(r) && !taskRunning(r) && !taskNeedsYou(r))],
      ["Archived", list.filter(taskArchived)],
    ];
    const where = (r: RunSummary) => projectFor(r)?.name ?? baseName(r.repo);
    body = sections.map(([title, items]) => {
      const matchingChats = visibleChats.filter(chat => title === "Running" ? ["Working", "Responding", "Paused"].includes(chat.status) : title === "Needs you" ? ["Needs attention", "Approach ready", "Waiting for your decision", "Inspect preserved work", "Allowance reached"].includes(chat.status) : title === "Recent" ? !["Working", "Responding", "Paused", "Needs attention", "Approach ready", "Waiting for your decision", "Inspect preserved work", "Allowance reached"].includes(chat.status) : false);
      return items.length || matchingChats.length ? (
        <section key={title} aria-label={title}>
          <div class="rail-title rail-section">
            {title}
            {title === "Needs you" ? <span class="count">{items.length}</span> : null}
          </div>
          {matchingChats.map(chatRow)}
          {items.map((r) => row(r, where(r)))}
        </section>
      ) : null;
    });
  } else {
    // Every project, the ones with the newest runs first; runs that need you are listed above them instead.
    const byKey = new Map<string, Group>(projects.value.map((p) => [p.id, { key: p.id, project: p, name: p.name, runs: [], last: 0, archived: 0 }]));
    const groupOf = (r: RunSummary) => {
      const key = projectFor(r)?.id ?? NONE;
      if (!byKey.has(key)) byKey.set(key, { key, name: "No project", runs: [], last: 0, archived: 0 });
      return byKey.get(key)!;
    };
    for (const r of all) {
      const g = groupOf(r);
      g.last = Math.max(g.last, activityAt(r));
      if (taskArchived(r)) g.archived++;
    }
    for (const r of list) if (!taskNeedsYou(r) && !taskArchived(r)) groupOf(r).runs.push(r);
    for (const chat of visibleChats) { const key = chat.project || NONE; if (!byKey.has(key) && !chat.project) byKey.set(key, { key, name: "No project", runs: [], last: 0, archived: 0 }); const group = byKey.get(key); if (group) group.last = Math.max(group.last, chat.updatedAt); }
    const groups = [...byKey.values()].sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));
    body = (
      <>
        {waiting.length ? (
          <section aria-label="Needs you">
            <div class="rail-title rail-section">
              Needs you <span class="count">{filtering ? waiting.length : projectCounts.value?.[ALL]?.attentionTasks ?? waiting.length}</span>
            </div>
            {waiting.map((r) => row(r, projectFor(r)?.name ?? baseName(r.repo)))}
          </section>
        ) : null}
        <section aria-label="Projects">
          <div class="rail-title rail-section rail-projects-title">
            <button type="button" class="rail-projects-toggle" aria-expanded={!projectsCollapsed} aria-controls="rail-project-groups" onClick={() => collapseProjects(!projectsCollapsed)}>Projects<Icon name="chevron" class="caret"/></button>
            <button
              type="button"
              class="icon-btn"
              aria-label="New project"
              title="New project"
              onClick={() => {
                projectEdit.value = "new";
                projectsOpen.value = true;
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
          <div id="rail-project-groups" hidden={projectsCollapsed}><ComputerProjects directory={computers} error={computerProjects.error} query={f.q}>
            {groups.filter(g => g.runs.length || visibleChats.some(chat => chat.project === (g.project?.id ?? "")) || !filtering && g.project).map(projectGroup)}
          </ComputerProjects></div>
        </section>
        {view.archived && list.some(taskArchived) ? <section aria-label="Archived runs"><div class="rail-title rail-section">Archived runs</div>{list.filter(taskArchived).map(run => row(run, projectFor(run)?.name ?? baseName(run.repo)))}</section> : null}
      </>
    );
  }
  const hiddenSelected = selectedRuns.filter(run => !renderedRuns.has(run.id)).length;
  const empty = !list.length && !chats.value.length;
  return (
    <RailElement ref={railRef} inert={phone && !railOpen.value} aria-hidden={phone && !railOpen.value ? true : undefined} class={`rail ${railOpen.value ? "open" : ""}`} aria-label="Workspace navigation" onClick={event => {
      if (!phone || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) railOpen.value = false;
    }} onFocusOut={event => {
      const nav = event.currentTarget;
      // Expanding replaces the focused search icon; allow its next-frame search focus to settle.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!nav.contains(document.activeElement)) railPeek.value = false; }));
    }}>
      {!phone && !collapsed ? <RailResizeHandle /> : null}
      <div class="rail-head">
        <a class="brand" href="#/" aria-label="Code Flow: new chat" onClick={() => (railOpen.value = false)}>
          <span class="brand-name">
            code<span>-flow</span>
          </span>
        </a>
        <button type="button" class="icon-btn rail-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="run-navigation" onClick={() => setRailCollapsed(!collapsed)}><Icon name="sidebar" /></button>
        <button type="button" class="icon-btn rail-close" aria-label="Close menu" autoFocus={phone} onClick={() => (railOpen.value = false)}>
          <Icon name="close" />
        </button>
      </div>
      <button class="btn primary new-run" disabled={!draftsReady.value || composerLoading.value} aria-label="New chat" title="New chat (n)" onClick={() => openChat()}>
        <Icon name="compose" /> <span>New chat</span>
      </button>
      <div class="rail-destinations" role="group" aria-label="Work navigation">
        <a class="nav-item" href="#/projects" title="Projects" aria-current={r.view === "projects" ? "page" : undefined}><Icon name="project" /><span class="nav-label">Projects</span></a>
      </div>
      {collapsed ? <button type="button" class="icon-btn rail-search-button" aria-label="Search chats" title="Search chats (/)" onClick={() => { peekRail(); requestAnimationFrame(() => document.getElementById("run-search")?.focus()); }}><Icon name="search" /></button> : null}
      <div class="rail-search">
        <Icon name="search" />
        <input
          id="run-search"
          class="field"
          type="search"
          placeholder="Search chats"
          aria-label="Search chats (press / to focus)"
          value={f.q}
          onInput={(e) => setRunFilter({ q: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (f.q) { e.preventDefault(); e.stopPropagation(); setRunFilter({ q: "" }); }
              else if (phone) { e.preventDefault(); railOpen.value = false; }
              else { railPeek.value = false; e.currentTarget.blur(); }
            } else if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              (document.querySelector(".rail .run-item") as HTMLButtonElement | null)?.[e.key === "Enter" ? "click" : "focus"]();
            }
          }}
        />
      </div>
      {!collapsed && ownerOnLocalListener.value && archivedChats.value ? <div class="rail-archive-view"><span>Archived chats</span><button type="button" class="rail-archive-toggle" onClick={() => { archivedChats.value = false; }}>Back to active chats</button></div> : null}
      {filtering ? (
        <div class="rail-hint">
          {list.length} of {all.length} tasks
          <button type="button" onClick={() => setRunFilter({ q: "", status: "all", pattern: "", agent: "", repo: "" })}>
            Clear
          </button>
        </div>
      ) : null}
      <div class="rail-list" id="run-navigation">
        {view.group === "status" ? <ComputerProjects directory={computers} error={computerProjects.error} query={f.q}>{body}</ComputerProjects> : body}
        {empty && filtering ? <div class="rail-empty">No chats match. Clear your search or filters to see more.</div> : null}
      </div>
      <div class="rail-history" role="region" aria-label="Chat history pages">
        {projectCountsError.value ? <span class="help" role="status">Complete history totals are unavailable. Counts show loaded items. <button class="btn small" onClick={() => void refreshProjectCounts().catch(() => {})}>Retry totals</button></span> : null}
        {historyLoading.value ? <span class="help" role="status">Searching history…</span> : null}
        {historyNextCursor.value ? <button type="button" class="btn small" disabled={historyLoading.value || historyLoadingMore.value} onClick={() => void loadOlderRuns()}>{historyLoadingMore.value ? "Loading…" : "Load older chats"}</button> : null}
        {attentionTruncated.value && historyNextCursor.value ? <span class="help" role="status">{attentionTotal.value} running or attention items at last refresh. Older attention is paged; use Load older chats to include more.</span> : null}
        {historyError.value ? <div class="help" role="alert">{historyError.value}<button class="btn small" disabled={historyLoading.value || historyLoadingMore.value} onClick={() => void retryHistory()}>Retry history</button></div> : null}
        {filtering && !f.q.trim() && historyNextCursor.value ? <span class="help">Filters apply to loaded pages. Load older chats to include more history.</span> : null}
      </div>
      <DesktopUpdateNotice collapsed={collapsed} />
      <div class="rail-foot">
        <Menu class="rail-menu" label="Application menu" icon="more" trigger={<>
          <span class="rail-menu-avatar"><Icon name="layers" /></span>
          <span class="rail-menu-label"><strong>Code Flow</strong></span>
          {unread + pending ? <span class="rail-menu-count" aria-label={`${unread + pending} items need attention`}>{unread + pending > 99 ? "99+" : unread + pending}</span> : null}
          <Icon name="more" />
        </>}>
          {(close) => <>
            <MenuItem on={r.view === "settings"} onClick={() => { close(); go({ view: "settings" }); }}><Icon name="sliders" /><span>Settings</span><kbd class="rail-menu-meta">⌘,</kbd></MenuItem>
            <div class="rail-menu-divider" role="separator" />
            <MenuItem on={view.archived} onClick={() => { close(); setRailView({ archived: !view.archived }); }}><Icon name="archive" /><span>{view.archived ? "Hide archived chats" : "Show archived chats"}</span><span class="rail-menu-meta">{archivedCount ?? "…"}</span></MenuItem>
            <MenuItem onClick={() => { close(); railOpen.value = false; shortcutsOpen.value = true; }}><Icon name="keyboard" /><span>Keyboard shortcuts</span><kbd class="rail-menu-meta">?</kbd></MenuItem>
            <a class="pop-item" role="menuitem" href="/docs/" target="_blank" rel="noreferrer" onClick={close}><span class="pi-main"><Icon name="help" /><span>Help & documentation</span><Icon name="external" class="rail-menu-meta" /></span></a>
          </>}
        </Menu>
      </div>
      {bulkDeleting ? <DeleteRunsDialog runs={bulkDeleting} onDeleted={deselect} onClose={() => setBulkDeleting(null)} /> : null}
      {cleaning ? <ArchiveDialog run={cleaning.run} members={cleaning.members} onClose={() => setCleaning(null)} /> : null}
    </RailElement>
  );
}
