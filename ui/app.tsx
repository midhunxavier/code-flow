import { HostControl, executionHost } from "./ssh-projects.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApprovalInbox } from "./approval-inbox.js";
import { Composer } from "./composer.js";
import { WorkbenchView } from "./workbench.js";
import { CommandPalette } from "./command-palette.js";
import { SidePanel } from "./side.js";
import { RunView } from "./run.js";
import { Review } from "./review.js";
import { GitHubPicker } from "./github.js";
import { SweepDialog } from "./sweeps.js";
import { AutomationsView } from "./automations.js";
import { InsightsView } from "./insights.js";
import { ProjectsDialog } from "./projects.js";
import { ProjectView } from "./project.js";
import { Rail } from "./rail.js";
import { Icon } from "./icons.js";
import logo from "./brand/vibesboard-mark.png";
import { api, showToast, store, toast } from "./lib.js";
import {
  pickRepo,
  pickerChoose,
  projectFor,
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
  if (route.value.view === "side") return <PoppedSide tab={route.value.tab} />;
  return <MainApp />;
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
  }, [waitingCount.value]);
  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  // On phones the runs list is a drawer: going anywhere closes it.
  useEffect(() => {
    railOpen.value = false;
  }, [route.value]);

  return (
    <>
      <a class="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to main content</a>
      <TopBar />
      <ApprovalInbox />
      <div class={`app ${sideOpen.value ? "with-side" : ""}`} style={`--side-w:${sideWidth.value}px`}>
        <Rail />
        {railOpen.value ? <div class="rail-scrim" aria-hidden="true" onClick={() => (railOpen.value = false)} /> : null}
        <main id="main-content" tabIndex={-1}>
          {route.value.view === "run" ? (
            <RunView key={route.value.id} id={route.value.id} />
          ) : route.value.view === "review" ? (
            <Review key={`${route.value.id}:${route.value.branch}`} id={route.value.id} branch={route.value.branch} />
          ) : route.value.view === "automations" ? (
            <AutomationsView />
          ) : route.value.view === "insights" ? (
            <InsightsView group={route.value.group} />
          ) : route.value.view === "project" ? (
            <ProjectView key={route.value.id} id={route.value.id} />
          ) : route.value.view === "workspace" ? (
            <WorkbenchView />
          ) : route.value.view === "invalid" ? (
            <div class="composer" role="alert">
              <h1>This link is invalid</h1>
              <p>The address contains an incomplete or invalid URL escape. Your saved work is available from the run list.</p>
              <button class="btn primary" onClick={() => (route.value = { view: "composer" })}>Open new run</button>
            </div>
          ) : (
            <Composer />
          )}
        </main>
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
function TopBar() {
  return (
    <header class="topbar">
      <button class="btn ghost menu-btn" aria-label="Show runs" onClick={() => (railOpen.value = !railOpen.value)}>
        <Icon name="menu" />
      </button>
      <span class="brand">
        <img class="brand-mark" src={logo} alt="" width={28} height={28} />
        <span class="brand-name">code-flow</span>
      </span>
      <HostControl />
      <Crumbs />
      <span class={`connection-status ${connection.value.state}`} role="status" title={connection.value.state === "connected" ? "Live updates are connected" : "Live updates are unavailable; displayed run information may be out of date"}>
        <span aria-hidden="true">●</span> {connection.value.state === "connected" ? "Connected" : connection.value.state === "offline" ? "Offline" : connection.value.state === "reconnecting" ? "Reconnecting…" : "Connecting…"}
      </span>
      <button class="btn ghost command-btn" aria-label="Open command palette" title="Commands and navigation (⌘K / Ctrl+K)" onClick={() => (commandPaletteOpen.value = true)}>⌘K</button>
      <button
        class="btn ghost side-btn"
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

/** On a run or its review: the project it's in and the run. Other pages carry their own heading. */
function Crumbs() {
  const r = route.value;
  const run = r.view === "run" || r.view === "review" ? runs.value.get(r.id) : undefined;
  if (!run) return <span class="spacer" />;
  const project = projectFor(run);
  return (
    <nav class="crumbs-bar" aria-label="Where you are">
      <span class="crumb" title={run.repo}>
        <Icon name="project" /> {project?.name ?? "No project"}
      </span>
      <span class="sep" aria-hidden="true">
        ›
      </span>
      <span class={`crumb ${r.view === "run" ? "here" : ""}`} title={run.task}>
        {run.task.split("\n")[0] || "(no task)"}
      </span>
      {r.view === "review" ? (
        <>
          <span class="sep" aria-hidden="true">
            ›
          </span>
          <span class="crumb here">Review</span>
        </>
      ) : null}
    </nav>
  );
}

// ---------------------------------------------------------------- notifications
const canNotify = () => "Notification" in window && Notification.permission === "granted" && store.get("notify") !== "0";

export function Bell() {
  const [on, setOn] = useState(canNotify());
  return (
    <button
      class="btn ghost foot-btn bell"
      aria-label="Notifications"
      aria-pressed={on}
      title={on ? "Notifications on — click to turn off" : "Notify me when a run finishes or needs me"}
      onClick={async () => {
        if (!("Notification" in window)) return showToast("This browser doesn't support notifications");
        if (on) {
          store.set("notify", "0");
          setOn(false);
          return showToast("Notifications off");
        }
        const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        store.set("notify", permission === "granted" ? "1" : "0");
        setOn(permission === "granted");
        showToast(permission === "granted" ? "You'll be notified when a run needs you" : "Notifications are blocked in the browser settings");
      }}
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
  ["⌘K / Ctrl+K", "Commands, projects and runs"],
  ["/", "Search runs"],
  ["j / k", "Next / previous run in the list"],
  ["[ / ]", "Previous / next step of the open run"],
  ["n", "New run"],
  ["p", "Pick the project for new runs, Insights and Automations"],
  ["i", "Insights"],
  ["a", "Automations"],
  ["⌘↵", "Start the run, or send what you typed"],
  ["Esc", "Close a dialog, or leave the search box"],
  ["\\", "Show or hide the side panel"],
  ["?", "This list"],
];

function onShortcut(e: KeyboardEvent) {
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
                  {!h.installed ? "not installed" : h.signedIn === false ? "signed out" : h.signedIn ? `signed in · ${h.account ?? ""}` : "installed"}
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
                <span class={`badge ${gitHealth.value.ok ? "ok" : ""}`}>{gitHealth.value.ok ? "ok" : gitHealth.value.installed ? "too old" : "not found"}</span>
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
      setStatus(d.isRepo ? "✓ This folder is a git repository" : "Open a folder marked GIT, or type a path");
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
      {isRepo ? <span class="git-badge">GIT</span> : null}
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
            <button class="btn small" type="button" title="Parent folder" disabled={!dir?.parent} onClick={() => dir?.parent && browse(dir.parent)}>
              ↑
            </button>
            <button class="btn small" type="button" title="Home folder" onClick={() => browse(dir?.home)}>
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
            <button class="btn small" type="button" onClick={() => browse((pathInput.current?.value ?? path).trim())}>
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
            hidden folders
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
