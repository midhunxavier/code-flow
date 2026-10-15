import { useEffect, useState } from "preact/hooks";
import { Composer, FilesPanel } from "./composer.js";
import { RunView } from "./run.js";
import { Review } from "./review.js";
import { ago, api, baseName, showToast, STATUS_TEXT, store, toast } from "./lib.js";
import {
  agents,
  filesOpen,
  health,
  healthOpen,
  loadHealth,
  needsYou,
  patterns,
  pickerOpen,
  railOpen,
  recentRepos,
  repo,
  repoChecking,
  repoError,
  repoInfo,
  route,
  runs,
  runState,
  setRepo,
  waitingCount,
} from "./state.js";
import type { DirListing, RunSummary } from "./types.js";

export function App() {
  const view = route.value.view;
  const showFiles = view === "composer" && filesOpen.value;
  useEffect(() => {
    document.title = waitingCount.value ? `(${waitingCount.value}) code-flow` : "code-flow";
  }, [waitingCount.value]);

  return (
    <>
      <TopBar />
      <div class={`app ${showFiles ? "" : "no-files"}`}>
        <Rail />
        <main>
          {route.value.view === "run" ? (
            <RunView key={route.value.id} id={route.value.id} />
          ) : route.value.view === "review" ? (
            <Review key={`${route.value.id}:${route.value.branch}`} id={route.value.id} branch={route.value.branch} />
          ) : (
            <Composer />
          )}
        </main>
        {view === "composer" ? <FilesPanel open={showFiles} /> : null}
      </div>
      <FolderPicker />
      {healthOpen.value ? <HealthDialog /> : null}
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
  const info = repoInfo.value;
  return (
    <header class="topbar">
      <button class="btn ghost menu-btn" aria-label="Show runs" onClick={() => (railOpen.value = !railOpen.value)}>
        ☰
      </button>
      <span class="brand">code-flow</span>
      <button
        class={`repo-btn ${info ? "" : "empty"} ${repoError.value ? "bad" : ""}`}
        title={info ? info.repo : "Choose repository"}
        onClick={() => (pickerOpen.value = true)}
      >
        <span>📁</span>
        <span class="name">{info ? baseName(info.repo) : repoChecking.value ? "Checking…" : repoError.value || "Choose repository…"}</span>
        {info ? <span class="branch">{info.current || "detached"}</span> : null}
        <span style="color:var(--faint)">▾</span>
      </button>
      <span class="spacer" />
      <button class="agent-status" title="Health: install, sign-in and quota for each CLI" onClick={() => (healthOpen.value = true)}>
        {agents.value.map((a) => {
          const h = health.value?.find((x) => x.id === a.id);
          const problem = !a.available || h?.signedIn === false;
          return (
            <span key={a.id} class={`agent ${a.id} ${a.available ? "" : "off"} ${problem ? "problem" : ""}`}>
              {a.displayName}
              {h?.signedIn === false ? " ⚠" : ""}
            </span>
          );
        })}
      </button>
      <Bell />
    </header>
  );
}

// ---------------------------------------------------------------- notifications
const canNotify = () => "Notification" in window && Notification.permission === "granted" && store.get("notify") !== "0";

function Bell() {
  const [on, setOn] = useState(canNotify());
  return (
    <button
      class="btn ghost bell"
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
      🔔
    </button>
  );
}

export function notifyFinished(run: RunSummary) {
  const viewing = route.value.view !== "composer" && route.value.id === run.id;
  if (!canNotify() || (viewing && !document.hidden)) return;
  const verbs: Record<string, string> = {
    done: run.verdict === "failing" ? "finished, but its check fails" : "finished",
    failed: "failed",
    stopped: "stopped at a limit",
    interrupted: "was interrupted",
  };
  const title = run.awaiting ? `code-flow: ${run.awaiting.title.toLowerCase()}` : `code-flow: run ${verbs[run.status] ?? run.status}`;
  const n = new Notification(title, { body: run.task.split("\n")[0], tag: run.id });
  n.onclick = () => {
    window.focus();
    route.value = { view: "run", id: run.id };
    n.close();
  };
}

// ---------------------------------------------------------------- sidebar
function Rail() {
  const [showArchived, setShowArchived] = useState(false);
  const list = [...runs.value.values()].sort((a, b) => b.createdAt - a.createdAt);
  const current = route.value.view !== "composer" ? route.value.id : undefined;
  const groups: [string, RunSummary[], boolean][] = [
    ["Needs you", list.filter(needsYou), true],
    ["Running", list.filter((r) => r.status === "running"), false],
    ["Recent", list.filter((r) => !r.archived && r.status !== "running" && !needsYou(r)), false],
  ];
  const archived = list.filter((r) => r.archived);
  const open = (id: string) => {
    route.value = { view: "run", id };
    railOpen.value = false;
  };
  const item = (r: RunSummary) => (
    <button
      key={r.id}
      type="button"
      class={`run-item ${current === r.id ? "active" : ""} ${needsYou(r) ? "unseen" : ""} ${r.archived ? "archived" : ""}`}
      title={r.task}
      onClick={() => open(r.id)}
    >
      <span class={`dot ${runState(r)}`} />
      <span class="t">{r.task.split("\n")[0] || "(no task)"}</span>
      <span class="s">
        {r.awaiting ? "Waiting for you" : STATUS_TEXT[r.status] ?? r.status} · {patterns.value.find((p) => p.id === r.pattern)?.name ?? r.pattern} · {baseName(r.repo)} · {ago(r.createdAt)}
      </span>
    </button>
  );
  const empty = !groups.some(([, l]) => l.length) && !archived.length;
  return (
    <nav class={`rail ${railOpen.value ? "open" : ""}`}>
      <button
        class="btn primary new-run"
        onClick={() => {
          route.value = { view: "composer" };
          railOpen.value = false;
        }}
      >
        ＋ New run
      </button>
      {groups.map(([title, items, counted]) =>
        items.length ? (
          <div key={title}>
            <div class="rail-title rail-section">
              {title}
              {counted ? <span class="count">{items.length}</span> : null}
            </div>
            {items.map(item)}
          </div>
        ) : null,
      )}
      {archived.length ? (
        <div>
          <div class="rail-title rail-section">
            Archived ({archived.length})
            <button type="button" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? "hide" : "show"}
            </button>
          </div>
          {showArchived ? archived.map(item) : null}
        </div>
      ) : null}
      {empty ? <div class="rail-empty">No runs yet — start one on the right</div> : null}
    </nav>
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
    <dialog class="picker small-dialog health" ref={ref}>
      <div class="picker-inner">
        <div class="picker-head">
          <h3>Health</h3>
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
              {h.fix ? <div class="msg warn">{h.fix}</div> : null}
            </div>
          ))}
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
  const dialog = useDialog(pickerOpen.value, () => (pickerOpen.value = false));

  const browse = async (target?: string, showHidden = hidden) => {
    setStatus("Loading…");
    const q = new URLSearchParams();
    if (target) q.set("path", target);
    if (showHidden) q.set("hidden", "1");
    try {
      const d = await api<DirListing>(`/api/fs?${q}`);
      setDir(d);
      setPath(d.path);
      setStatus(d.isRepo ? "✓ This folder is a git repository" : "Open a folder marked GIT, or type a path");
    } catch (err) {
      setStatus((err as Error).message);
      if (!dir) void browse(undefined, showHidden);
    }
  };
  useEffect(() => {
    if (pickerOpen.value) void browse(repo.value || undefined);
  }, [pickerOpen.value]);

  const choose = (p: string) => {
    pickerOpen.value = false;
    void setRepo(p);
  };
  const parts = dir ? dir.path.split("/").filter(Boolean) : [];
  const recent = dir && dir.path === dir.home ? recentRepos() : [];
  const row = (icon: string, name: string, p: string, isRepo: boolean) => (
    <div key={p} class="dir" tabIndex={0} title={p} onClick={() => browse(p)} onKeyDown={(e) => e.key === "Enter" && browse(p)}>
      <span class="di">{icon}</span>
      <span class="dn">{name}</span>
      {isRepo ? <span class="git-badge">GIT</span> : null}
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
    <dialog class="picker" ref={dialog}>
      <div class="picker-inner">
        <div class="picker-head">
          <h3>Choose a repository</h3>
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
              value={path}
              onInput={(e) => setPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void browse(path.trim());
                }
              }}
            />
            <button class="btn small" type="button" onClick={() => browse(path.trim())}>
              Go
            </button>
          </div>
          <div class="crumbs">
            <a onClick={() => browse("/")}>/</a>
            {parts.map((part, i) => (
              <span key={i}>
                <a onClick={() => browse("/" + parts.slice(0, i + 1).join("/"))}>{part}</a>
                {i < parts.length - 1 ? "/" : ""}
              </span>
            ))}
          </div>
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
          <button class="btn" type="button" onClick={() => (pickerOpen.value = false)}>
            Cancel
          </button>
          <button class="btn primary" type="button" disabled={!dir} onClick={() => dir && choose(dir.path)}>
            Use this folder
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Open/close a <dialog> from state, and report Esc/backdrop closes back. */
export function useDialog(open: boolean, onClose: () => void) {
  const [el, setEl] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    const handler = () => onClose();
    el.addEventListener("close", handler);
    return () => el.removeEventListener("close", handler);
  }, [el, open]);
  return setEl;
}
