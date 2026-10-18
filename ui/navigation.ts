import { settingsSection, type SettingsSection } from "./settings-sections.js";
export type SideTab = "chat" | "changes" | "files" | "terminal" | "browser" | "notes";
export const SIDE_TABS: SideTab[] = ["chat", "changes", "files", "terminal", "browser", "notes"];

export type Route =
  | { view: "composer" }
  | { view: "settings"; section?: SettingsSection; group?: string }
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
  if (view === "settings") return { view: "settings", ...(id ? { section: settingsSection(id) } : {}), ...(id === "insights" && rest[0] ? { group: rest[0] } : {}) };
  // Preserve bookmarked links to the former standalone pages.
  if (view === "workspace") return { view: "settings", section: "workspace" };
  if (view === "automations") return { view: "settings", section: "automations" };
  if (view === "insights") return { view: "settings", section: "insights", ...(id ? { group: id } : {}) };
  if (view === "project" && id) return { view: "project", id };
  if (view === "side" && id && rest[0]) return { view: "side", tab: SIDE_TABS.includes(id as SideTab) ? id as SideTab : "chat", scope: rest[0] };
  return { view: "composer" };
}

export function hashFor(r: Route): string {
  if (r.view === "invalid") return r.hash;
  if (r.view === "run") return `#/run/${encodeURIComponent(r.id)}`;
  if (r.view === "settings") return r.section ? `#/settings/${r.section}${r.section === "insights" && r.group ? `/${encodeURIComponent(r.group)}` : ""}` : "#/settings";
  if (r.view === "project") return `#/project/${encodeURIComponent(r.id)}`;
  if (r.view === "side") return `#/side/${r.tab}/${encodeURIComponent(r.scope)}`;
  if (r.view === "review") return `#/review/${encodeURIComponent(r.id)}/${r.branch.split("/").map(encodeURIComponent).join("/")}`;
  return "#/";
}
