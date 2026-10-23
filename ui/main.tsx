import { pollVisible } from "./polling.js";
import { shellReady } from "./performance.js";
import "./theme.js"; // first: the theme follows your pick (or the system) before anything renders
import { watchNotificationPermission } from "./preferences.js";
import { loadExecutionHost, executionHost, readConnectionIntent } from "./ssh-projects.js";
import { effect, untracked } from "@preact/signals";
import { cancelConfirmations } from "./confirm-state.js";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, notifyFinished } from "./app.js";
import { ConfirmationHost } from "./confirm-dialog.js";
import { SharedDashboard, SharedLogin } from "./shared.js";
import type { SharedPrincipal } from "../src/shared-accounts.js";
import { configureStreamSharing, type StreamSharing } from "./stream.js";
import logo from "./brand/code-flow-mark.svg";
import { api, localApi, workspaceId, initializeTeamConnection, ensureCollaborationSource, showToast, store, SHORT } from "./lib.js";
import { agents, composerProject, composerLoading, draftsReady, openBrowserPage, openComposer, hashFor, initializeProjectDrafts, listenForHandOffs, loadHealth, loadModels, loadProjects, loadTeamRollout, patterns, refreshRuns, route, routeFromHash, setRepo, templates, watchAllRuns } from "./state.js";

// Reuse the sidebar's stacked-layers mark for the browser tab.
const icon = Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml", href: logo });
document.head.append(icon);

watchNotificationPermission();
// Opening an invitation in an already running app must enter the join screen too.
window.addEventListener("hashchange", () => { if (!workspaceId && location.hash.startsWith("#/join/")) location.reload(); });

const root = document.getElementById("root")!;
// Keep ordinary agent/document links in the workspace; modified clicks retain browser defaults.
root.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".md a[href]") : null;
  if (!link || !/^https?:\/\//i.test(link.href) || new URL(link.href).origin === location.origin) return;
  event.preventDefault();
  const current = route.value;
  openBrowserPage(link.href, current.view === "run" || current.view === "review" ? current.id : undefined);
});

/** Waits between attempts to reach the server; the last one repeats. */
const RETRY_SECONDS = [1, 2, 5, 10];
let attempts = 0;

/** The server didn't answer (a restart, a dev rebuild, a crash): say so and keep trying. */
function BootError({ message, seconds, onRetry }: { message: string; seconds: number; onRetry: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return onRetry();
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return (
    <div role="alert" class="boot-error">
      <h3>code-flow couldn't load</h3>
      <div class="msg err">{message}</div>
      <p class="help">{left > 0 ? `Trying again in ${left}s…` : "Trying again…"}</p>
      <button class="btn primary" disabled={left <= 0} onClick={() => setLeft(0)}>
        Retry now
      </button>
      {workspaceId ? <a class="btn" href="/#/settings/connections/workspace">Manage connections</a> : null}
    </div>
  );
}

async function boot() {
  let agentList, patternList;
  try {
    if (location.hash.startsWith("#/join/") && !workspaceId) { const { JoinProject } = await import("./join-project.js"); render(<JoinProject token={location.hash.slice("#/join/".length)} />, root); return; }
    const identity = await localApi<{ kind: "owner"; streamSharing?: StreamSharing } | { kind: "anonymous" } | SharedPrincipal>("/api/auth/self");
    if (identity.kind === "anonymous") { render(<SharedLogin />, root); return; }
    if (identity.kind === "shared") { render(<><SharedDashboard identity={identity} /><ConfirmationHost /></>, root); return; }
    await loadExecutionHost();
    await initializeTeamConnection();
    const streamIdentity = executionHost.value.kind === "ssh" ? await api<{ streamSharing?: StreamSharing }>("/api/auth/self") : identity;
    configureStreamSharing(streamIdentity.streamSharing);
    [agentList, patternList] = await Promise.all([api("/api/agents"), api("/api/patterns")]);
  } catch (err) {
    const seconds = RETRY_SECONDS[Math.min(attempts, RETRY_SECONDS.length - 1)]!;
    render(<BootError key={attempts++} message={(err as Error).message} seconds={seconds} onRetry={() => void boot()} />, root);
    return;
  }
  agents.value = agentList;
  for (const agent of agentList) SHORT[agent.id as keyof typeof SHORT] = agent.displayName;
  patterns.value = patternList;
  void loadTeamRollout();
  readConnectionIntent();
  route.value = routeFromHash();
  effect(() => {
    const hash = hashFor(route.value);
    if (!ensureCollaborationSource(hash)) return;
    // pushState navigation does not emit hashchange; discard actions from the old view.
    untracked(cancelConfirmations);
    // Opened at a bare `/` (the startup link lands there), the composer needs no "#/" of its own:
    // pushing one would make Back return to `/`, which pushes it again, so Back could never leave.
    if (location.hash !== hash && !(hash === "#/" && !location.hash)) {
      // Replace legacy addresses so Back cannot get stuck on an alias.
      if (hashFor(routeFromHash(location.hash)) === hash) history.replaceState(null, "", hash);
      else history.pushState(null, "", hash);
    }
  });
  const readRoute = () => { if (ensureCollaborationSource(location.hash)) route.value = routeFromHash(); };
  window.addEventListener("popstate", readRoute);
  window.addEventListener("hashchange", readRoute);
  effect(() => {
    const destination = route.value;
    if (!draftsReady.value || destination.view !== "composer" || destination.project === undefined) return;
    untracked(() => {
      if (destination.project !== composerProject.value || composerLoading.value) void openComposer(destination.project, { stay: true });
    });
  });
  render(<App />, root);
  shellReady();
  listenForHandOffs();
  void loadModels();
  void loadHealth();
  api("/api/templates").then(
    (t) => (templates.value = t),
    (err) => showToast(`Couldn't load the templates: ${(err as Error).message}`, 5000),
  );
  const inventory = Promise.all([refreshRuns(), loadProjects()]);
  const saved = store.get("repo");
  if (saved) await setRepo(saved, false);
  await inventory;
  await initializeProjectDrafts();
  watchAllRuns(notifyFinished);
  // A safety net if the event stream drops; projects change when a run starts in a new repo.
  pollVisible(() => Promise.all([refreshRuns(), loadProjects()]), 30_000);
}

void boot();
