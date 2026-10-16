import { effect } from "@preact/signals";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, notifyFinished } from "./app.js";
import logo from "./brand/vibesboard-mark.png";
import { api, showToast, store } from "./lib.js";
import { agents, loadHealth, loadModels, patterns, refreshRuns, route, setRepo, templates, watchAllRuns, type Route } from "./state.js";

/** The current view lives in the URL hash, so reload, back/forward and links work. */
function routeFromHash(): Route {
  const [view, id, ...rest] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (view === "run" && id) return { view: "run", id };
  if (view === "review" && id && rest.length) return { view: "review", id, branch: rest.join("/") };
  if (view === "automations") return { view: "automations" };
  if (view === "insights") return { view: "insights", group: id || undefined };
  return { view: "composer" };
}
function hashFor(r: Route): string {
  if (r.view === "run") return `#/run/${encodeURIComponent(r.id)}`;
  if (r.view === "automations") return "#/automations";
  if (r.view === "insights") return r.group ? `#/insights/${encodeURIComponent(r.group)}` : "#/insights";
  if (r.view === "review") return `#/review/${encodeURIComponent(r.id)}/${r.branch.split("/").map(encodeURIComponent).join("/")}`;
  return "#/";
}

// The tab icon: the vibesboard mark, like the top bar.
const icon = Object.assign(document.createElement("link"), { rel: "icon", type: "image/png", href: logo });
document.head.append(icon);

const root = document.getElementById("root")!;

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
    <div role="alert" style="max-width:480px;margin:15vh auto;padding:0 16px">
      <h3>code-flow couldn't load</h3>
      <div class="msg err">{message}</div>
      <p class="help">{left > 0 ? `Trying again in ${left}s…` : "Trying again…"}</p>
      <button class="btn primary" disabled={left <= 0} onClick={() => setLeft(0)}>
        Retry now
      </button>
    </div>
  );
}

async function boot() {
  let agentList, patternList;
  try {
    [agentList, patternList] = await Promise.all([api("/api/agents"), api("/api/patterns")]);
  } catch (err) {
    const seconds = RETRY_SECONDS[Math.min(attempts, RETRY_SECONDS.length - 1)]!;
    render(<BootError key={attempts++} message={(err as Error).message} seconds={seconds} onRetry={() => void boot()} />, root);
    return;
  }
  agents.value = agentList;
  patterns.value = patternList;
  route.value = routeFromHash();
  effect(() => {
    const hash = hashFor(route.value);
    if (location.hash !== hash) history.pushState(null, "", hash);
  });
  window.addEventListener("popstate", () => (route.value = routeFromHash()));
  window.addEventListener("hashchange", () => (route.value = routeFromHash()));
  render(<App />, root);
  void loadModels();
  void loadHealth();
  api("/api/templates").then(
    (t) => (templates.value = t),
    (err) => showToast(`Couldn't load the templates: ${(err as Error).message}`, 5000),
  );
  const saved = store.get("repo");
  if (saved) void setRepo(saved, false);
  await refreshRuns();
  watchAllRuns(notifyFinished);
  setInterval(refreshRuns, 30_000); // safety net if the event stream drops
}

void boot();
