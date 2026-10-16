import { effect } from "@preact/signals";
import { render } from "preact";
import { App, notifyFinished } from "./app.js";
import logo from "./brand/vibesboard-mark.png";
import { api, store } from "./lib.js";
import { agents, loadHealth, loadModels, loadProjects, patterns, refreshRuns, route, setRepo, templates, watchAllRuns, type Route } from "./state.js";

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

async function boot() {
  const [agentList, patternList] = await Promise.all([api("/api/agents"), api("/api/patterns")]);
  agents.value = agentList;
  patterns.value = patternList;
  route.value = routeFromHash();
  effect(() => {
    const hash = hashFor(route.value);
    if (location.hash !== hash) history.pushState(null, "", hash);
  });
  window.addEventListener("popstate", () => (route.value = routeFromHash()));
  window.addEventListener("hashchange", () => (route.value = routeFromHash()));
  render(<App />, document.getElementById("root")!);
  void loadModels();
  void loadHealth();
  api("/api/templates").then((t) => (templates.value = t), () => {});
  const saved = store.get("repo");
  if (saved) void setRepo(saved, false);
  await Promise.all([refreshRuns(), loadProjects()]);
  watchAllRuns(notifyFinished);
  // A safety net if the event stream drops; projects change when a run starts in a new repo.
  setInterval(() => void Promise.all([refreshRuns(), loadProjects()]), 30_000);
}

void boot();
