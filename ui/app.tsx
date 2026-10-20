import { ActivityView } from "./activity.js";
import { ConfirmationHost } from "./confirm-dialog.js";
import { lazyView } from "./lazy-view.js";
const SettingsView = lazyView(() => import("./settings.js").then((module) => module.SettingsView));
import { SETTINGS_SECTIONS } from "./settings-sections.js";
import { canNotify, setDesktopNotifications } from "./preferences.js";
import { HostControl, executionHost } from "./ssh-projects.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApprovalInbox } from "./approval-inbox.js";
import { Composer } from "./composer.js";
import { CommandPalette } from "./command-palette.js";
import { SidePanel } from "./side.js";
import { RunView } from "./run.js";
import { Review } from "./review.js";
import { GitHubPicker } from "./github.js";
import { SweepDialog } from "./sweeps.js";
import { ProjectsDialog } from "./projects.js";
import { ProjectView } from "./project.js";
import { TeamBoardView } from "./collab-board.js";
import { TeamTaskView } from "./collab-task.js";
import { board as teamBoard, openTask, watchTeam } from "./collab-state.js";
import { Rail } from "./rail.js";
import { Icon } from "./icons.js";
import { api, showToast, store, toast } from "./lib.js";
import { theme, toggleTheme } from "./theme.js";
import {
  pickRepo,
  pickerChoose,
  projectFor,
  projects,
  projectsOpen,
  announcement,
  shortcutsOpen,
  commandPaletteOpen,
  connection,
  closeSide,
  openSide,
  sideOpen,
  sideWidth,
  gitHealth,
  health,
  healthOpen,
  loadHealth,
  pickerOpen,
  railOpen,
  railCollapsed,
  setRailCollapsed,
  recentRepos,
  repo,
  route,
  runs,
  waitingCount,
  watchNeedingYou,
  navigate,
  routeFromHash,
  sideTab,
  type SideTab,
} from "./state.js";
import type { DirListing, RunSummary } from "./types.js";
import { teamNeedsResume } from "./team-state.js";

export function App() {
  return <>{route.value.view === "side" ? <PoppedSide tab={route.value.tab} /> : <MainApp />}<ConfirmationHost /></>;
}

/**
 * The side panel in a window of its own: one run's or project's, whatever the main window shows.
 * Its scope is the route's (see `poppedScope`), and it stays a panel: the pages it opens open in
 * the main window (see `navigate`).
 */
function PoppedSide({ tab }: { tab: SideTab }) {
  useEffect(() => {
    sideTab.value = tab;
    sideOpen.value = true;
    document.addEventListener("click", handOffLink);
    return () => document.removeEventListener("click", handOffLink);
  }, []);
  useEffect(() => {
    document.title = `code-flow · ${tab}`;
  }, [tab]);
  return (
    <div class="popped">
      <SidePanel popped />
      <div class="sr-only" role="status" aria-live="polite">
        {announcement.value}
      </div>
      {toast.value ? (
        <div class="toast" role="status" key={toast.value.id}>
          {toast.value.text}
        </div>
      ) : null}
    </div>
  );
}

/** A link to one of the app's pages, clicked in a popped-out panel: the main window shows the page. */
export function handOffLink(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as Element | null)?.closest?.("a[href^='#/']");
  if (!link || link.getAttribute("target")) return;
  e.preventDefault();
  navigate(routeFromHash(link.getAttribute("href")!));
}

function MainApp() {
  useEffect(() => {
    const host = executionHost.value;
    document.title = `${waitingCount.value ? `(${waitingCount.value}) ` : ""}code-flow${host.kind === "ssh" ? ` · SSH ${host.name}` : ""}`;
  }, [waitingCount.value, executionHost.value]);
  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  // The team board's live updates (and the Team entry's unread count) for as long as the app is open.
  useEffect(() => { watchTeam(); }, []);
  // On phones the runs list is a drawer: going anywhere closes it.
  useEffect(() => {
    railOpen.value = false;
  }, [route.value]);

  return (
    <>
      <a class="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to main content</a>
      <ApprovalInbox />
      <div class={`app ${sideOpen.value ? "with-side" : ""} ${railCollapsed.value ? "rail-collapsed" : ""}`} style={`--side-w:${sideWidth.value}px`}>
        <Rail />
        {railOpen.value ? <div class="rail-scrim" aria-hidden="true" onClick={() => (railOpen.value = false)} /> : null}
        <div class="main-col">
          <TopBar />
          <main id="main-content" tabIndex={-1}>
            {route.value.view === "run" ? (
              <RunView key={route.value.id} id={route.value.id} />
            ) : route.value.view === "review" ? (
              <Review key={`${route.value.id}:${route.value.branch}`} id={route.value.id} branch={route.value.branch} />
            ) : route.value.view === "project" ? (
              <ProjectView key={route.value.id} id={route.value.id} />
            ) : ["inbox", "automations", "workspace", "insights"].includes(route.value.view) ? (
              <ActivityView key={route.value.view === "workspace" ? `workspace:${route.value.project ?? ""}` : route.value.view} current={route.value} />
            ) : route.value.view === "settings" ? (
              <SettingsView section={route.value.section} group={route.value.group} />
            ) : route.value.view === "team" ? (
              <TeamBoardView key="team" project={route.value.project} navigate={navigate} />
            ) : route.value.view === "team-task" ? (
              <TeamTaskView key={route.value.id} id={route.value.id} navigate={navigate} />
            ) : route.value.view === "invalid" ? (
              <div class="composer" role="alert">
                <h1>This link is invalid</h1>
                <p class="lede">The address contains an incomplete or invalid URL escape. Your saved work is available from the run list.</p>
                <button class="btn primary" onClick={() => (route.value = { view: "composer" })}>Open new run</button>
              </div>
            ) : (
              <Composer />
            )}
          </main>
        </div>
        {sideOpen.value ? <div class="side-scrim" aria-hidden="true" onClick={closeSide} /> : null}
        <SidePanel />
      </div>
      <FolderPicker />
      <GitHubPicker />
      <SweepDialog />
      {projectsOpen.value ? <ProjectsDialog /> : null}
      {healthOpen.value ? <HealthDialog /> : null}
      {shortcutsOpen.value ? <ShortcutsDialog /> : null}
      {commandPaletteOpen.value ? <CommandPalette /> : null}
      <div class="sr-only" role="status" aria-live="polite">
        {announcement.value}
      </div>
      {toast.value ? (
        <div class="toast" role="status" key={toast.value.id}>
          {toast.value.text}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- top bar
/** The command palette's modifier as this keyboard labels it: ⌘ on Apple devices, Ctrl elsewhere. */
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl ";

/** Above the page, beside the sidebar: where you are, live updates, commands, then the theme and the side panel. */
function TopBar() {
  const dark = theme.value === "dark";
  return (
    <header class="topbar">
      <button class="icon-btn menu-btn" aria-label="Show runs" aria-expanded={railOpen.value} onClick={() => (railOpen.value = !railOpen.value)}>
        <Icon name="menu" />
      </button>
      <HostControl />
      <Crumbs />
      <span class={`connection-status ${connection.value.state}`} role="status" title={connection.value.state === "connected" ? "Live updates are connected" : "Live updates are unavailable; displayed run information may be out of date"}>
        <span class="cs-dot" aria-hidden="true" />
        <span class="cs-label">{connection.value.state === "connected" ? "Connected" : connection.value.state === "offline" ? "Offline" : connection.value.state === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
      </span>
      {/* a search glass and the shortcut as a key; a phone shows only the glass */}
      <button class="btn ghost command-btn" aria-label="Open command palette" title={`Commands and navigation (${MOD_KEY}K)`} onClick={() => (commandPaletteOpen.value = true)}>
        <Icon name="search" />
        <kbd class="kbd-key" aria-hidden="true">{MOD_KEY}K</kbd>
      </button>
      <button class="icon-btn" aria-label={dark ? "Use the light theme" : "Use the dark theme"} title={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
        <Icon name={dark ? "sun" : "moon"} />
      </button>
      <button
        class="icon-btn side-btn"
        aria-pressed={sideOpen.value}
        aria-label="Side panel"
        title="Side panel: chat, files, terminal, browser, notes (\\)"
        onClick={() => (sideOpen.value ? closeSide() : openSide())}
      >
        <Icon name="panel" />
      </button>
    </header>
  );
}

/** Where you are: the page, or on a run (and its review) the project it's in and the run. */
function Crumbs() {
  const r = route.value;
  const run = r.view === "run" || r.view === "review" ? runs.value.get(r.id) : undefined;
  const sep = (
    <span class="sep" aria-hidden="true">
      /
    </span>
  );
  let trail;
  if (run) {
    const project = projectFor(run);
    trail = (
      <>
        {project ? (
          <a class="crumb" href={`#/project/${encodeURIComponent(project.id)}`} title={run.repo}>
            {project.name}
          </a>
        ) : (
          <span class="crumb" title={run.repo}>
            No project
          </span>
        )}
        {sep}
        <span class={`crumb title ${r.view === "run" ? "here" : ""}`} title={run.task} aria-current={r.view === "run" ? "page" : undefined}>
          {run.task.split("\n")[0] || "(no task)"}
        </span>
        {r.view === "review" ? (
          <>
            {sep}
            <span class="crumb here" aria-current="page">
              Review
            </span>
          </>
        ) : null}
      </>
    );
  } else if (r.view === "project") {
    trail = (
      <span class="crumb here" aria-current="page">
        {projects.value.find((p) => p.id === r.id)?.name ?? "Project"}
      </span>
    );
  } else if (r.view === "team" || r.view === "team-task") {
    // The board, or a task under it: its title comes from the open task, else from the board's card.
    const title = r.view === "team-task" ? (openTask.value?.id === r.id ? openTask.value.title : teamBoard.value?.tasks.find((t) => t.id === r.id)?.title ?? "Task") : undefined;
    const projectName = r.view === "team" && r.project ? teamBoard.value?.projects.find((p) => p.id === r.project)?.name : undefined;
    trail = title !== undefined ? (
      <>
        <a class="crumb" href="#/team">
          People
        </a>
        {sep}
        <span class="crumb title here" title={title} aria-current="page">
          {title}
        </span>
      </>
    ) : projectName ? (
      <>
        <a class="crumb" href="#/team">
          People
        </a>
        {sep}
        <span class="crumb here" aria-current="page">
          {projectName}
        </span>
      </>
    ) : (
      <span class="crumb here" aria-current="page">
        People
      </span>
    );
  } else if (r.view === "inbox" || r.view === "automations" || r.view === "workspace" || r.view === "insights") {
    trail = <>{r.view === "workspace" && r.project ? <><a class="crumb" href={`#/project/${encodeURIComponent(r.project)}`}>{projects.value.find(p => p.id === r.project)?.name ?? "Project"}</a>{sep}</> : null}<span class="crumb here" aria-current="page">{{ inbox: "Inbox", automations: "Scheduling", workspace: "Repository workspace", insights: "Insights" }[r.view]}</span></>;
  } else if (r.view === "settings") {
    const section = r.section ? SETTINGS_SECTIONS.find((item) => item.id === r.section) : undefined;
    trail = section ? (
      <>
        <a class="crumb" href="#/settings">
          Settings
        </a>
        {sep}
        <span class="crumb here" aria-current="page">
          {section.label}
        </span>
      </>
    ) : (
      <span class="crumb here" aria-current="page">
        Settings
      </span>
    );
  } else {
    const page = r.view === "composer" ? "New run" : "";
    trail = page ? (
      <span class="crumb here" aria-current="page">
        {page}
      </span>
    ) : null;
  }
  return (
    <nav class="crumbs-bar" aria-label="Where you are">
      {trail}
    </nav>
  );
}

// ---------------------------------------------------------------- notifications
export function Bell() {
  const on = canNotify();
  return (
    <button
      class="btn ghost foot-btn bell"
      aria-label="Notifications"
      aria-pressed={on}
      title={on ? "Notifications on — click to turn off" : "Notify me when a run finishes or needs me"}
      onClick={() => void setDesktopNotifications(!on)}
    >
      <Icon name="bell" />
    </button>
  );
}

export function notifyFinished(run: RunSummary) {
  if (route.value.view === "side") return; // a popped-out panel: the main window says it
  const viewing = (route.value.view === "run" || route.value.view === "review") && route.value.id === run.id;
  const verbs: Record<string, string> = {
    done: run.verdict === "failing" ? "finished, but its check fails" : run.checkCantRun ? "finished, but its check couldn't run" : "finished",
    failed: "failed",
    stopped: teamNeedsResume(run) ? "has unresolved work" : "stopped at a limit",
    interrupted: "was interrupted",
  };
  const watch = run.status !== "running" && !run.awaiting ? watchNeedingYou(run) : undefined;
  const title = run.awaiting
    ? `code-flow: ${run.awaiting.title.toLowerCase()}`
    : run.team?.awaitingRequestId ? "code-flow: your team needs an answer" : watch
      ? `code-flow: PR needs you — ${watch.detail}`
      : `code-flow: run ${verbs[run.status] ?? run.status}`;
  announcement.value = `${title.replace(/^code-flow: /, "")}: ${run.task.split("\n")[0]!.slice(0, 120)}`;
  if (!canNotify() || (viewing && !document.hidden)) return;
  let n: Notification;
  try {
    n = new Notification(title, { body: run.task.split("\n")[0], tag: run.id });
  } catch {
    // Android Chrome (the phone link) only shows notifications from a service worker: a toast instead.
    return showToast(title.replace(/^code-flow: /, ""), 5000);
  }
  n.onclick = () => {
    window.focus();
    navigate({ view: "run", id: run.id });
    n.close();
  };
}

// ---------------------------------------------------------------- keyboard
const SHORTCUTS: [string, string][] = [
  ["⌘, / Ctrl+,", "Settings"],
  ["⌘K / Ctrl+K", "Commands, projects and runs"],
  ["/", "Search runs"],
  ["j / k", "Next / previous run in the list"],
  ["[ / ]", "Previous / next step of the open run"],
  ["n", "New run"],
  ["p", "Pick the project for new runs, Insights and Scheduling"],
  ["i", "Insights"],
  ["a", "Scheduling"],
  ["⌘↵", "Start the run, or send what you typed"],
  ["Esc", "Close a dialog, or leave the search box"],
  ["\\", "Show or hide the side panel"],
  ["?", "This list"],
];

function onShortcut(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "," && !e.defaultPrevented && !document.querySelector("dialog[open]")) {
    e.preventDefault(); navigate({ view: "settings" }); return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    commandPaletteOpen.value = !commandPaletteOpen.value;
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable=true], dialog")) return;
  const go = (r: typeof route.value) => {
    e.preventDefault();
    navigate(r);
  };
  switch (e.key) {
    case "/": {
      e.preventDefault();
      setRailCollapsed(false);
      railOpen.value = true;
      const search = () => document.getElementById("run-search") as HTMLInputElement | null;
      search()?.focus();
      // On phones the sidebar is hidden until it re-renders open.
      if (document.activeElement !== search()) requestAnimationFrame(() => search()?.focus());
      return;
    }
    case "n":
      return go({ view: "composer" });
    case "p":
      e.preventDefault();
      projectsOpen.value = true;
      return;
    case "i":
      return go({ view: "insights" });
    case "a":
      return go({ view: "automations" });
    case "?":
      e.preventDefault();
      shortcutsOpen.value = true;
      return;
    case "\\":
      e.preventDefault();
      if (sideOpen.value) closeSide();
      else openSide();
      return;
    case "j":
    case "k": {
      const items = [...document.querySelectorAll<HTMLButtonElement>(".rail .run-item")];
      if (!items.length) return;
      e.preventDefault();
      const at = items.findIndex((b) => b.classList.contains("active"));
      const next = items[at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))]!;
      next.click();
      next.scrollIntoView({ block: "nearest" });
      return;
    }
  }
}

function ShortcutsDialog() {
  const ref = useDialog(true, () => (shortcutsOpen.value = false));
  return (
    <dialog class="picker small-dialog" ref={ref} aria-labelledby="shortcuts-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="shortcuts-title">Keyboard shortcuts</h3>
        </div>
        <div class="dialog-body">
          <table class="shortcuts">
            <tbody>
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={keys}>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="picker-foot">
          <span class="ps" />
          <button class="btn primary" onClick={() => (shortcutsOpen.value = false)}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------- health
function HealthDialog() {
  const ref = useDialog(true, () => (healthOpen.value = false));
  useEffect(() => {
    void loadHealth();
  }, []);
  const pct = (u?: number) => (u === undefined ? "?" : `${Math.round(u * 100)}%`);
  const when = (t?: number) => (t ? new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");
  return (
    <dialog class="picker small-dialog health" ref={ref} aria-labelledby="health-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="health-title">Health</h3>
          <div class="help">What code-flow can see about each CLI — it uses the CLIs' own commands and never reads their credentials.</div>
        </div>
        <div class="dialog-body">
          {!health.value ? <div class="help">Checking…</div> : null}
          {health.value?.map((h) => (
            <div key={h.id} class="health-row">
              <div class="hr-title">
                <span class={`agent ${h.id}`}>{h.name}</span>
                <span class={`badge ${h.installed && h.signedIn !== false ? "ok" : ""}`}>
                  {!h.installed ? "Not installed" : h.signedIn === false ? "Signed out" : h.signedIn ? `Signed in · ${h.account ?? ""}` : "Installed"}
                </span>
                <span class="help">{h.version}</span>
              </div>
              {h.quota && Object.keys(h.quota.windows).length ? (
                <div class="quota">
                  {Object.entries(h.quota.windows).map(([name, w]) => (
                    <div key={name} class="q">
                      <span>{name.replace("_", "-")} window</span>
                      <span class="bar">
                        <span style={`width:${Math.min(100, Math.round((w.utilization ?? 0) * 100))}%`} />
                      </span>
                      <span>
                        {pct(w.utilization)} used{w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : h.quota?.status === "limited" ? (
                <div class="msg warn">Hit a usage limit recently.</div>
              ) : h.installed ? (
                <div class="help">{h.id === "claude" ? "Quota shows after the next Claude step." : "This CLI doesn't report remaining quota."}</div>
              ) : null}
              {h.warnings?.map((w) => (
                <div key={w} class="msg warn">
                  {w}
                </div>
              ))}
              {h.fix ? <div class="msg warn">{h.fix}</div> : null}
            </div>
          ))}
          {gitHealth.value ? (
            <div class="health-row">
              <div class="hr-title">
                <span class="agent">git</span>
                <span class={`badge ${gitHealth.value.ok ? "ok" : ""}`}>{gitHealth.value.ok ? "OK" : gitHealth.value.installed ? "Too old" : "Not found"}</span>
                <span class="help">{gitHealth.value.version}</span>
              </div>
              {gitHealth.value.warning ? <div class="msg warn">{gitHealth.value.warning}</div> : null}
            </div>
          ) : null}
        </div>
        <div class="picker-foot">
          <span class="ps" />
          <button class="btn" onClick={() => loadHealth()}>
            Check again
          </button>
          <button class="btn primary" onClick={() => (healthOpen.value = false)}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------- folder picker
/** Browsers never reveal absolute paths, so the local server lists folders. */
function FolderPicker() {
  const [dir, setDir] = useState<DirListing | null>(null);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState("");
  const [hidden, setHidden] = useState(false);
  const pathInput = useRef<HTMLInputElement>(null);
  const opened = useRef(false);
  const closePicker = () => {
    opened.current = false;
    latest.current++;
    pickerOpen.value = false;
    pickerChoose.value = null;
  };
  const dialog = useDialog(pickerOpen.value, closePicker);
  const adding = pickerChoose.value;
  // Only the latest listing counts: a slow earlier one must not replace a path you just typed.
  const latest = useRef(0);
  // You typed in the path field since the latest listing was requested: it lists, but keeps your text.
  const typed = useRef(false);

  const browse = async (target?: string, showHidden = hidden) => {
    if (!pickerOpen.value) return;
    opened.current = true;
    const request = ++latest.current;
    typed.current = false;
    setStatus("Loading…");
    const q = new URLSearchParams();
    if (target) q.set("path", target);
    if (showHidden) q.set("hidden", "1");
    try {
      const d = await api<DirListing>(`/api/fs?${q}`);
      if (request !== latest.current || !pickerOpen.value) return;
      setDir(d);
      if (!typed.current) setPath(d.path);
      setStatus(d.isRepo ? "✓ This folder is a git repository" : "Open a folder marked Git, or type a path");
    } catch (err) {
      if (request !== latest.current || !pickerOpen.value) return;
      setStatus((err as Error).message);
      if (!dir && target) void browse(undefined, showHidden);
    }
  };
  useEffect(() => {
    // A paste + Enter can precede this effect. Its explicit browse already owns this opening;
    // a delayed default listing must never supersede it (or erase text typed before the effect).
    if (pickerOpen.value && !opened.current) void browse(repo.value || undefined);
    if (!pickerOpen.value) opened.current = false;
  }, [pickerOpen.value]);

  const choose = (p: string) => {
    closePicker();
    if (adding) adding.choose(p);
    else void pickRepo(p);
  };
  const parts = dir ? dir.path.split("/").filter(Boolean) : [];
  const recent = dir && dir.path === dir.home ? recentRepos() : [];
  const row = (icon: string, name: string, p: string, isRepo: boolean) => (
    <div key={p} class="dir" title={p}>
      <button type="button" class="dir-browse" aria-label={`Open folder ${name}`} onClick={() => browse(p)}>
      <span class="di">{icon}</span>
      <span class="dn">{name}</span>
      {isRepo ? <span class="git-badge">Git</span> : null}
      </button>
      {isRepo ? (
        <button
          class="btn small"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            choose(p);
          }}
        >
          Use
        </button>
      ) : null}
    </div>
  );

  return (
    <dialog class="picker" ref={dialog} aria-labelledby="folder-picker-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="folder-picker-title">{adding ? adding.title : "Choose a repository"}</h3>
          <div class="row">
            <button class="btn" type="button" title="Parent folder" aria-label="Parent folder" disabled={!dir?.parent} onClick={() => dir?.parent && browse(dir.parent)}>
              ↑
            </button>
            <button class="btn" type="button" title="Home folder" aria-label="Home folder" onClick={() => browse(dir?.home)}>
              ~
            </button>
            <input
              class="field"
              type="text"
              spellcheck={false}
              aria-label="Folder path"
              ref={pathInput}
              value={path}
              onInput={(e) => {
                opened.current = true;
                typed.current = true;
                setPath(e.currentTarget.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void browse(e.currentTarget.value.trim());
                }
              }}
            />
            <button class="btn" type="button" onClick={() => browse((pathInput.current?.value ?? path).trim())}>
              Go
            </button>
          </div>
          <nav class="crumbs" aria-label="Folder breadcrumbs">
            <button type="button" aria-label="The root folder" onClick={() => browse("/")}>/</button>
            {parts.map((part, i) => (
              <span key={i}>
                <button type="button" aria-current={i === parts.length - 1 ? "location" : undefined} onClick={() => browse("/" + parts.slice(0, i + 1).join("/"))}>{part}</button>
                {i < parts.length - 1 ? "/" : ""}
              </span>
            ))}
          </nav>
        </div>
        <div class="picker-list">
          {recent.length ? <div class="picker-section">Recent</div> : null}
          {recent.map((p) => row("★", dir ? p.replace(dir.home, "~") : p, p, true))}
          {recent.length ? <div class="picker-section">Folders</div> : null}
          {dir?.entries.map((e) => row(e.isRepo ? "◆" : "▸", e.name, e.path, e.isRepo))}
          {dir && !dir.entries.length ? <div class="picker-section">No subfolders</div> : null}
          {dir?.truncated ? <div class="picker-section">Showing the first 500 — type a path above</div> : null}
        </div>
        <div class="picker-foot">
          <span class="ps">{status}</span>
          <label>
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.currentTarget.checked);
                void browse(dir?.path, e.currentTarget.checked);
              }}
            />{" "}
            Hidden folders
          </label>
          <button class="btn" type="button" onClick={closePicker}>
            Cancel
          </button>
          <button class="btn primary" type="button" disabled={!dir || path.trim() !== dir.path || status === "Loading…"} onClick={() => {
            const entered = (pathInput.current?.value ?? path).trim();
            if (dir && entered === dir.path && status !== "Loading…") choose(dir.path);
          }}>
            {adding ? "Add this folder" : "Use this folder"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Open/close a <dialog> from state, and report Esc/backdrop closes back. */
export function useDialog(open: boolean, onClose: () => void) {
  const [el, setEl] = useState<HTMLDialogElement | null>(null);
  // close() queues a native event. It may arrive after the same dialog has reopened, so it
  // acknowledges the controlled transition rather than requesting another state change.
  const controlledCloses = useRef(new WeakMap<HTMLDialogElement, number>());
  useEffect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) {
      controlledCloses.current.set(el, (controlledCloses.current.get(el) ?? 0) + 1);
      el.close();
    }
    const handler = () => {
      const pending = controlledCloses.current.get(el) ?? 0;
      if (pending) { controlledCloses.current.set(el, pending - 1); return; }
      onClose();
    };
    el.addEventListener("close", handler);
    return () => el.removeEventListener("close", handler);
  }, [el, open]);
  return setEl;
}
