import { settingsSection, type SettingsSection } from "./settings-sections.js";
export type SideTab = "chat" | "changes" | "files" | "terminal" | "browser" | "notes";
export const SIDE_TABS: SideTab[] = ["chat", "changes", "files", "terminal", "browser", "notes"];
export const PROJECT_SECTIONS = ["runs", "repositories", "connections", "board", "people", "automation", "settings"] as const;
export type ProjectSection = typeof PROJECT_SECTIONS[number];
export const REPOSITORY_TOOLS = ["verification", "code", "context", "history", "services", "coordination", "filtered-tasks"] as const;
export type RepositoryTool = typeof REPOSITORY_TOOLS[number];

export type Route =
  | { view: "composer"; project?: string }
  | { view: "inbox" }
  | { view: "automations"; kind?: string }
  | { view: "workspace"; project?: string }
  | { view: "insights"; group?: string }
  | { view: "settings"; section?: SettingsSection; group?: string; connection?: string }
  | { view: "project"; id: string; section?: ProjectSection; repository?: string; tool?: RepositoryTool; kind?: string }
  | { view: "side"; tab: SideTab; scope: string }
  | { view: "run"; id: string }
  | { view: "review"; id: string; branch: string }
  | { view: "team"; project?: string }
  | { view: "team-people"; project?: string }
  | { view: "team-task"; id: string }
  | { view: "invalid"; hash: string };

/** Decode a deep link without allowing malformed URL escapes to prevent the app rendering. */
export function parseRouteHash(hash: string): Route {
  if (hash.startsWith("#/settings/connections/join?")) return { view: "settings", section: "connections", group: "join", connection: new URLSearchParams(hash.split("?")[1]).get("connection") ?? undefined };
  let parts: string[];
  try { parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent); }
  catch { return { view: "invalid", hash }; }
  const [view, id, ...rest] = parts;
  if (view === "run" && id) return { view: "run", id };
  if (view === "review" && id && rest.length) return { view: "review", id, branch: rest.join("/") };
  if (view === "settings" && (id === "workspace" || id === "automations" || id === "insights")) return { view: id, ...(id === "insights" && rest[0] ? { group: rest[0] } : {}) };
  if (view === "settings" && ["ssh", "remote-access", "team"].includes(id ?? "")) return { view: "settings", section: "connections", group: id === "ssh" ? "workspace" : id === "remote-access" ? "devices" : "manage" };
  if (view === "settings") return { view: "settings", ...(id ? { section: settingsSection(id) } : {}), ...((id === "insights" || id === "connections") && rest[0] ? { group: rest[0] } : {}) };
  // Everyday work has standalone destinations; old Settings bookmarks remain valid.
  if (view === "workspace") return { view: "workspace" };
  if (view === "automations") return { view, ...(id ? { kind: id } : {}) };
  if (view === "inbox") return { view };
  if (view === "insights") return { view: "insights", ...(id ? { group: id } : {}) };
  if (view === "new" && id === "unassigned" && !rest.length) return { view: "composer", project: "" };
  if (view === "project" && id && rest[0] === "new" && rest.length === 1) return { view: "composer", project: id };
  if (view === "project" && id && rest[0] === "workspace" && rest.length === 1) return { view: "workspace", project: id };
  if (view === "project" && id) {
    if (!rest.length) return { view: "project", id };
    const [section, repository, tool, ...extra] = rest;
    if (section === "automation") return extra.length || tool || repository && !["once", "repeat", "backlog", "missions"].includes(repository) ? { view: "invalid", hash } : { view: "project", id, section, ...(repository ? { kind: repository } : {}) };
    if (!PROJECT_SECTIONS.includes(section as ProjectSection) || extra.length || (section !== "repositories" && rest.length !== 1) || (tool && !REPOSITORY_TOOLS.includes(tool as RepositoryTool))) return { view: "invalid", hash };
    return { view: "project", id, section: section as ProjectSection, ...(repository ? { repository } : {}), ...(tool ? { tool: tool as RepositoryTool } : {}) };
  }
  // The team board and its tasks: #/team, #/team/project/<id>, #/team/task/<id>; anything else under #/team is the board.
  if (view === "team") return id === "people" ? { view: "team-people", ...(rest[0] ? { project: rest[0] } : {}) } : id === "task" && rest[0] ? { view: "team-task", id: rest[0] } : id === "project" && rest[0] ? { view: "team", project: rest[0] } : { view: "team" };
  if (view === "side" && id && rest[0]) return { view: "side", tab: SIDE_TABS.includes(id as SideTab) ? id as SideTab : "chat", scope: rest[0] };
  return { view: "composer" };
}

export function hashFor(r: Route): string {
  if (r.view === "composer" && r.project !== undefined) return r.project ? `#/project/${encodeURIComponent(r.project)}/new` : "#/new/unassigned";
  if (r.view === "invalid") return r.hash;
  if (r.view === "inbox") return "#/inbox";
  if (r.view === "automations") return `#/automations${r.kind ? `/${encodeURIComponent(r.kind)}` : ""}`;
  if (r.view === "workspace") return r.project ? `#/project/${encodeURIComponent(r.project)}/workspace` : "#/workspace";
  if (r.view === "insights") return `#/insights${r.group ? `/${encodeURIComponent(r.group)}` : ""}`;
  if (r.view === "run") return `#/run/${encodeURIComponent(r.id)}`;
  if (r.view === "settings" && r.connection && r.section === "connections" && r.group === "join") return `#/settings/connections/join?connection=${encodeURIComponent(r.connection)}`;
  if (r.view === "settings") return r.section ? `#/settings/${r.section}${(r.section === "insights" || r.section === "connections") && r.group ? `/${encodeURIComponent(r.group)}` : ""}` : "#/settings";
  if (r.view === "project") return `#/project/${encodeURIComponent(r.id)}${r.section ? `/${r.section}` : ""}${r.section === "automation" && r.kind ? `/${encodeURIComponent(r.kind)}` : ""}${r.section === "repositories" && (r.repository || r.tool) ? `/${encodeURIComponent(r.repository ?? "")}${r.tool ? `/${r.tool}` : ""}` : ""}`;
  if (r.view === "team-people") return `#/team/people${r.project ? `/${encodeURIComponent(r.project)}` : ""}`;
  if (r.view === "team") return r.project ? `#/team/project/${encodeURIComponent(r.project)}` : "#/team";
  if (r.view === "team-task") return `#/team/task/${encodeURIComponent(r.id)}`;
  if (r.view === "side") return `#/side/${r.tab}/${encodeURIComponent(r.scope)}`;
  if (r.view === "review") return `#/review/${encodeURIComponent(r.id)}/${r.branch.split("/").map(encodeURIComponent).join("/")}`;
  return "#/";
}

/** Project collaboration is the owning computer's board, never the currently linked server. */
export function projectCollaboration(hash: string): boolean {
  const route = parseRouteHash(hash);
  return route.view === "project" && (route.section === "board" || route.section === "people");
}
