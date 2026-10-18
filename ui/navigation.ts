export type SideTab = "chat" | "changes" | "files" | "terminal" | "browser" | "notes";
export const SIDE_TABS: SideTab[] = ["chat", "changes", "files", "terminal", "browser", "notes"];

export type Route =
  | { view: "composer" }
  | { view: "workspace" }
  | { view: "automations" }
  | { view: "insights"; group?: string }
  | { view: "project"; id: string }
  | { view: "side"; tab: SideTab; scope: string }
  | { view: "run"; id: string }
  | { view: "review"; id: string; branch: string }
  | { view: "invalid"; hash: string };

/** Decode a deep link without allowing malformed URL escapes to prevent the app rendering. */
export function parseRouteHash(hash: string): Route {
  let parts: string[];
  try { parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent); }
  catch { return { view: "invalid", hash }; }
  const [view, id, ...rest] = parts;
  if (view === "run" && id) return { view: "run", id };
  if (view === "review" && id && rest.length) return { view: "review", id, branch: rest.join("/") };
  if (view === "workspace") return { view: "workspace" };
  if (view === "automations") return { view: "automations" };
  if (view === "insights") return { view: "insights", group: id || undefined };
  if (view === "project" && id) return { view: "project", id };
  if (view === "side" && id && rest[0]) return { view: "side", tab: SIDE_TABS.includes(id as SideTab) ? id as SideTab : "chat", scope: rest[0] };
  return { view: "composer" };
}

export function hashFor(r: Route): string {
  if (r.view === "invalid") return r.hash;
  if (r.view === "run") return `#/run/${encodeURIComponent(r.id)}`;
  if (r.view === "workspace") return "#/workspace";
  if (r.view === "automations") return "#/automations";
  if (r.view === "project") return `#/project/${encodeURIComponent(r.id)}`;
  if (r.view === "side") return `#/side/${r.tab}/${encodeURIComponent(r.scope)}`;
  if (r.view === "insights") return r.group ? `#/insights/${encodeURIComponent(r.group)}` : "#/insights";
  if (r.view === "review") return `#/review/${encodeURIComponent(r.id)}/${r.branch.split("/").map(encodeURIComponent).join("/")}`;
  return "#/";
}
