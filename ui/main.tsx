import { effect } from "@preact/signals";
import { render } from "preact";
import { App, notifyFinished } from "./app.js";
import { api, store } from "./lib.js";
import { agents, loadHealth, loadModels, patterns, refreshRuns, route, setRepo, watchAllRuns, type Route } from "./state.js";

/** The current view lives in the URL hash, so reload, back/forward and links work. */
function routeFromHash(): Route {
  const [view, id, ...rest] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (view === "run" && id) return { view: "run", id };
  if (view === "review" && id && rest.length) return { view: "review", id, branch: rest.join("/") };
  return { view: "composer" };
}
function hashFor(r: Route): string {
  if (r.view === "run") return `#/run/${encodeURIComponent(r.id)}`;
  if (r.view === "review") return `#/review/${encodeURIComponent(r.id)}/${r.branch.split("/").map(encodeURIComponent).join("/")}`;
  return "#/";
}

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
  const saved = store.get("repo");
  if (saved) void setRepo(saved, false);
  await refreshRuns();
  watchAllRuns(notifyFinished);
  setInterval(refreshRuns, 30_000); // safety net if the event stream drops
}

void boot();
