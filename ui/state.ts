import { computed, signal } from "@preact/signals";
import { api, ApiError, post, store } from "./lib.js";
import type {
  AgentId,
  AgentInfo,
  AgentSettings,
  Attachment,
  CatalogOrError,
  ContextItem,
  PatternInfo,
  Project,
  ProjectDefaults,
  RepoInfo,
  RunSummary,
} from "./types.js";

// ---------------------------------------------------------------- app-wide
export const agents = signal<AgentInfo[]>([]);
export const patterns = signal<PatternInfo[]>([]);
export const catalogs = signal<Record<string, CatalogOrError>>({});
export const runs = signal<Map<string, RunSummary>>(new Map());

export type Route =
  | { view: "composer" }
  | { view: "automations" }
  | { view: "insights"; group?: string }
  | { view: "run"; id: string }
  | { view: "review"; id: string; branch: string };
export const route = signal<Route>({ view: "composer" });
export const railOpen = signal(false);
export const pickerOpen = signal(false);

// ---------------------------------------------------------------- side panel
/** The side panel's tabs: a chat with one agent, the files, a terminal, a browser, your notes. */
export type SideTab = "chat" | "files" | "terminal" | "browser" | "notes";
export const SIDE_TABS: SideTab[] = ["chat", "files", "terminal", "browser", "notes"];
/** Open as you left it on a wide screen; on a phone it covers the work, so it starts closed. */
export const sideOpen = signal(window.innerWidth > 760 && (store.get("sideOpen") ? store.get("sideOpen") === "1" : window.innerWidth > 1180));
export const sideTab = signal<SideTab>(SIDE_TABS.includes(store.get("sideTab") as SideTab) ? (store.get("sideTab") as SideTab) : "chat");
/** Width of the side panel on wide screens, in pixels; dragged, and remembered. */
export const sideWidth = signal(Math.min(Math.max(Number(store.get("sideWidth")) || 420, 300), 900));
export function openSide(tab?: SideTab) {
  if (tab) {
    sideTab.value = tab;
    store.set("sideTab", tab);
  }
  sideOpen.value = true;
  store.set("sideOpen", "1");
}
export function closeSide() {
  sideOpen.value = false;
  store.set("sideOpen", "0");
}
export function setSideWidth(px: number) {
  sideWidth.value = Math.min(Math.max(Math.round(px), 300), 900);
  store.set("sideWidth", String(sideWidth.value));
}
/** The chat shown in the side panel: a Single-agent run, or none (a fresh chat). */
export const sideChat = signal<string | null>(store.get("sideChat"));
export function setSideChat(id: string | null) {
  sideChat.value = id;
  if (id) store.set("sideChat", id);
  else store.set("sideChat", "");
}
/** Text handed to the side chat's composer (from Notes, or a file). */
export const sideDraft = signal("");
/** A file the Files tab should show: set by anything that opens a file (a transcript, a diff). */
export const sideFile = signal<{ root: string; path: string } | null>(null);
export function openFile(root: string, path: string) {
  sideFile.value = { root, path };
  openSide("files");
}

export const available = (id: AgentId) => agents.value.find((a) => a.id === id)?.available ?? false;
/** Read out by screen readers when a run finishes or needs you (an aria-live region). */
export const announcement = signal("");
export const shortcutsOpen = signal(false);

// ---------------------------------------------------------------- repository
export const repoInfo = signal<RepoInfo | null>(null);
export const repoError = signal("");
export const repoChecking = signal(false);
export const repo = computed(() => repoInfo.value?.repo ?? "");

export async function setRepo(path: string, remember = true) {
  path = path.trim();
  const previous = repo.value;
  repoChecking.value = true;
  repoError.value = "";
  try {
    const info = await api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`);
    repoInfo.value = info;
    if (remember) {
      store.set("repo", info.repo);
      store.set("recentRepos", JSON.stringify([info.repo, ...recentRepos().filter((p) => p !== info.repo)].slice(0, 8)));
    }
  } catch (err) {
    repoInfo.value = null;
    repoError.value = path ? repoProblem(path.split("/").pop() || path, err) : "";
  } finally {
    repoChecking.value = false;
  }
  if (repo.value !== previous) {
    contextPaths.value = new Map(); // paths are relative to the repo they came from
    void loadCheck();
  }
}
export const recentRepos = () => store.json<string[]>("recentRepos", []);
/** The folder picker adds a repo to something (a project you're editing) instead of choosing the composer's repo. */
export const pickerChoose = signal<{ title: string; choose: (path: string) => void } | null>(null);

// ---------------------------------------------------------------- projects
/** Which runs the app shows: one project's (its id), every run (ALL), or the runs in no project (NONE). */
export const ALL = "";
export const NONE = "none";
export const projects = signal<Project[]>([]);
export const currentProject = signal(store.get("project") ?? ALL);
export const activeProject = computed(() => projects.value.find((p) => p.id === currentProject.value));
export const projectsOpen = signal(false);
/** The Projects dialog opens straight on this project's editor ("new" for a new one), not on the list. */
export const projectEdit = signal<string | null>(null);
export function editProject(id: string) {
  projectEdit.value = id;
  projectsOpen.value = true;
}

export async function loadProjects() {
  try {
    projects.value = await api<Project[]>("/api/projects");
  } catch {
    return; // keep what we have
  }
  const id = currentProject.value;
  if (id !== ALL && id !== NONE && !projects.value.some((p) => p.id === id)) setCurrentProject(ALL); // deleted, maybe in another tab
}

/** The project a run belongs to, as the server decides it (projectOf in projects.ts). */
export function projectFor(run: { project?: string; repo: string }): Project | undefined {
  if (run.project) return projects.value.find((p) => p.id === run.project);
  return projects.value.find((p) => p.repos.includes(run.repo));
}

/** Is the run in what the app is showing? */
export function inScope(run: RunSummary, scope = currentProject.value): boolean {
  if (scope === ALL) return true;
  const p = projectFor(run);
  return scope === NONE ? !p : p?.id === scope;
}

function setCurrentProject(id: string) {
  currentProject.value = id;
  store.set("project", id);
}

/**
 * Show a project: its runs in the sidebar, and new runs start in it. Unless told not to, the
 * composer moves to the project's repo you used last and to the team you last picked here.
 */
export function selectProject(id: string, opts: { defaults?: boolean; repo?: boolean } = {}) {
  setCurrentProject(id);
  const p = projects.value.find((x) => x.id === id);
  if (!p) return;
  if (opts.defaults !== false && p.defaults) applyDefaults(p.defaults);
  if (opts.repo !== false && p.repos.length && !p.repos.includes(repo.value)) void setRepo(lastRepo(p));
}

function lastRepo(p: Project): string {
  const latest = [...runs.value.values()].filter((r) => p.repos.includes(r.repo) && projectFor(r)?.id === p.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  return latest?.repo ?? p.repos[0]!;
}

function applyDefaults(d: ProjectDefaults) {
  for (const [patternId, team] of Object.entries(d.teams)) {
    roleSel.value = { ...roleSel.value, [patternId]: team.roles as Record<string, RoleValue[]> };
    roleModels.value = { ...roleModels.value, [patternId]: team.roleSettings ?? {} };
  }
  if (patterns.value.some((p) => p.id === d.pattern)) setPattern(d.pattern);
  agentSettings.value = d.agentSettings ?? {};
  store.set("roleSel", JSON.stringify(roleSel.value));
  store.set("roleModels", JSON.stringify(roleModels.value));
  store.set("agentSettings", JSON.stringify(agentSettings.value));
}

/** You picked a repo: if the project you're in doesn't hold it, show the repo's own project (or every run, if none holds it yet). */
export async function pickRepo(path: string) {
  await setRepo(path);
  const p = activeProject.value;
  const r = repo.value;
  if (!r || !p || !p.repos.length || p.repos.includes(r)) return;
  const own = projects.value.find((x) => x.repos.includes(r));
  if (own) selectProject(own.id);
  else setCurrentProject(ALL);
}

/**
 * Where the next run goes: the project you're in, else the repo's. `adds`: the repo joins that
 * project when the run starts; `creates`: no project holds the repo yet, so starting makes one.
 */
export const target = computed(() => {
  const r = repo.value;
  const p = activeProject.value ?? projects.value.find((x) => x.repos.includes(r));
  return { project: p, adds: !!p && !!r && !p.repos.includes(r), creates: !p && !!r };
});

/** A run started: its project may be new, or have a new repo. Keep showing the project it went in. */
export async function afterStart(project?: string) {
  await loadProjects();
  if (project && currentProject.value !== ALL) setCurrentProject(project);
}

/** Why a folder couldn't be opened: not a repository is only one of the reasons. */
function repoProblem(name: string, err: unknown): string {
  if (!(err instanceof ApiError)) return `Couldn't reach code-flow to open ${name}`;
  if (err.status === 400 && /not a git repository/i.test(err.message)) return `${name} isn't a git repository`;
  if (err.status === 401) return "Not signed in to code-flow";
  if (err.status >= 500) return `Couldn't open ${name}: ${err.message}`;
  return err.message;
}

// ---------------------------------------------------------------- composer
export const task = signal(store.get("draftTask") ?? "");
export const contextPaths = signal<Map<string, ContextItem>>(new Map());
export const attachments = signal<Attachment[]>([]);
export const contextError = signal("");
export const patternId = signal(store.get("pattern") ?? "pipeline");
export const pattern = computed(() => patterns.value.find((p) => p.id === patternId.value) ?? patterns.value[0]);
/** A role is filled by an agent, or "auto": code-flow picks one whose plan has room. */
export type RoleValue = AgentId | "auto";
export const roleSel = signal<Record<string, Record<string, RoleValue[]>>>(store.json("roleSel", {}));
export const optionValues = signal<Record<string, Record<string, number | boolean>>>({});
export const agentSettings = signal<AgentSettings>(store.json("agentSettings", {}));
export const baseRef = signal(store.get("baseRef") ?? "");
export const branchPrefix = signal("");
export const checkCmd = signal("");
export const checkHint = signal("");
export const setupCmd = signal("");
export const limits = signal(store.json("limits", { maxMinutes: 60, maxSteps: 40 }));
export type Trust = "safe" | "standard" | "trusted" | "full";
export const trust = signal<Trust>((store.get("trust") as Trust) || "standard");
export function setTrust(value: Trust) {
  trust.value = value;
  store.set("trust", value);
}
/** Per-role model/effort overrides, per pattern: { pattern: { role: { agent: { model, effort } } } }. */
export const roleModels = signal<Record<string, Record<string, AgentSettings>>>(store.json("roleModels", {}));
export function setRoleModel(patternId: string, roleId: string, agent: AgentId, patch: { model?: string; effort?: string }) {
  const forPattern = roleModels.value[patternId] ?? {};
  const forRole = forPattern[roleId] ?? {};
  roleModels.value = { ...roleModels.value, [patternId]: { ...forPattern, [roleId]: { ...forRole, [agent]: { ...(forRole[agent] ?? {}), ...patch } } } };
  store.set("roleModels", JSON.stringify(roleModels.value));
}
/** .codeflow/config.json of the selected repo, if it has one. */
export const repoConfig = signal<{ config: Record<string, any>; found: boolean; error?: string } | null>(null);

export interface Health {
  id: AgentId;
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  signedIn: boolean | null;
  account?: string;
  quota?: { status: string; windows: Record<string, { utilization?: number; resetsAt?: number }>; at: number };
  fix?: string;
  /** false: the CLI's --help lacks a flag code-flow passes, so steps will fail on it. */
  compatible?: boolean;
  missing?: string[];
  warnings?: string[];
}
export interface GitHealth {
  installed: boolean;
  version?: string;
  ok: boolean;
  warning?: string;
}
export const health = signal<Health[] | null>(null);
export const gitHealth = signal<GitHealth | null>(null);
export const healthOpen = signal(false);
export async function loadHealth() {
  const [agents, git] = await Promise.allSettled([api<Health[]>("/api/doctor"), api<GitHealth>("/api/doctor/git")]);
  health.value = agents.status === "fulfilled" ? agents.value : null;
  gitHealth.value = git.status === "fulfilled" ? git.value : null;
}

/** "Let me approve the plan before agents build" (patterns that have a plan step). */
export const approvePlan = signal(store.get("approvePlan") === "1");
export function setApprovePlan(on: boolean) {
  approvePlan.value = on;
  store.set("approvePlan", on ? "1" : "0");
}
/** Patterns with a plan checkpoint, and what you approve there. */
export const CHECKPOINTS: Record<string, string> = { pipeline: "the plan", debate: "the plan", supervisor: "the subtasks", tdd: "the tests" };

export function setTask(value: string) {
  task.value = value;
  store.set("draftTask", value);
}
export function setPattern(id: string) {
  patternId.value = id;
  store.set("pattern", id);
}
export function setRoles(patternId: string, roleId: string, ids: RoleValue[]) {
  roleSel.value = { ...roleSel.value, [patternId]: { ...(roleSel.value[patternId] ?? {}), [roleId]: ids } };
  store.set("roleSel", JSON.stringify(roleSel.value));
}
export function setAgentSetting(id: AgentId, patch: { model?: string; effort?: string }) {
  agentSettings.value = { ...agentSettings.value, [id]: { ...(agentSettings.value[id] ?? {}), ...patch } };
  store.set("agentSettings", JSON.stringify(agentSettings.value));
}
export function setCheck(value: string) {
  checkCmd.value = value;
  if (repo.value) store.set(`check:${repo.value}`, value);
}
export function setSetup(value: string) {
  setupCmd.value = value;
  if (repo.value) store.set(`setup:${repo.value}`, value);
}
export function setLimits(patch: Partial<{ maxMinutes: number; maxSteps: number }>) {
  limits.value = { ...limits.value, ...patch };
  store.set("limits", JSON.stringify(limits.value));
}

/** Who fills each role: saved choice, else the pattern default — only installed agents. */
export function rolesFor(p: PatternInfo | undefined): Record<string, RoleValue[]> {
  if (!p) return {};
  const saved = roleSel.value[p.id] ?? {};
  const firstAvailable = agents.value.find((a) => a.available)?.id;
  const roles: Record<string, RoleValue[]> = {};
  for (const role of p.roles) {
    let ids = (saved[role.id] ?? role.default).filter((id) => id === "auto" || available(id));
    if (!role.multiple) ids = ids.slice(0, 1);
    if (!ids.length && !role.optional && !saved[role.id] && firstAvailable) ids = [firstAvailable];
    roles[role.id] = ids;
  }
  // A race is fairer when the judge isn't also competing: default to a vendor that isn't.
  if (p.id === "race" && !saved.judge) {
    const outsider = agents.value.find((a) => a.available && !roles.contestants?.includes(a.id) && !roles.contestants?.includes("auto"));
    if (outsider) roles.judge = [outsider.id];
  }
  // Nobody re-reviews the supervisor's fixes to its own review: default the reviewer to another vendor.
  if (p.id === "supervisor" && !saved.reviewer) {
    const [supervisor] = roles.supervisor ?? [];
    const other = agents.value.find((a) => a.available && a.id !== supervisor);
    if (supervisor && supervisor !== "auto" && (roles.reviewer?.[0] ?? supervisor) === supervisor && other) roles.reviewer = [other.id];
  }
  return roles;
}

export function optionsFor(p: PatternInfo | undefined): Record<string, number | boolean> {
  if (!p) return {};
  const current = optionValues.value[p.id] ?? {};
  return Object.fromEntries(p.options.map((o) => [o.id, current[o.id] ?? o.default]));
}
export function setOption(p: PatternInfo, id: string, value: number | boolean) {
  optionValues.value = { ...optionValues.value, [p.id]: { ...(optionValues.value[p.id] ?? {}), [id]: value } };
}

/** "Done when" check: remembered per repo; auto-detected until you edit it. */
export async function loadCheck() {
  const r = repo.value;
  setupCmd.value = r ? store.get(`setup:${r}`) ?? "" : "";
  if (!r) {
    checkCmd.value = "";
    checkHint.value = "";
    return;
  }
  try {
    repoConfig.value = await api(`/api/repo-config?repo=${encodeURIComponent(r)}`);
  } catch {
    repoConfig.value = null;
  }
  const config = repoConfig.value?.config ?? {};
  if (!store.get(`setup:${r}`) && config.setup) setupCmd.value = config.setup;
  if (config.trust && !store.get("trust")) trust.value = config.trust;
  const saved = store.get(`check:${r}`);
  // A detected setup (`uv sync`, `poetry install`) fills an empty setup you haven't edited.
  const detectSetup = !setupCmd.value && store.get(`setup:${r}`) === null;
  if (saved !== null || config.check) {
    checkCmd.value = saved ?? config.check!;
    checkHint.value = saved !== null ? "" : "From .codeflow/config.json.";
    if (!detectSetup) return;
  } else {
    checkCmd.value = "";
  }
  try {
    const d = await api<{ command: string | null; source?: string; setup?: string }>(`/api/check?repo=${encodeURIComponent(r)}`);
    if (repo.value !== r) return;
    if (detectSetup && d.setup) setupCmd.value = d.setup;
    if (saved !== null || config.check) return;
    checkCmd.value = d.command ?? "";
    checkHint.value = d.command ? `Detected from ${d.source}${d.setup ? `; each worktree is set up with “${d.setup}” (Settings)` : ""}.` : "No test command found in this repo.";
  } catch {
    if (saved === null && !config.check) checkHint.value = "";
  }
}

export async function loadModels() {
  try {
    catalogs.value = await api("/api/models");
  } catch {
    catalogs.value = {};
  }
}

// ---------------------------------------------------------------- runs
/** A run needs you when it finished and you haven't looked, or it was interrupted. */
export const needsYou = (r: RunSummary) => !r.archived && (!!r.awaiting || (r.status !== "running" && (r.status === "interrupted" || !r.seen)));
/**
 * A finished run whose result fails its check is a warning, not a success; so is one whose check
 * couldn't run here at all ("unchecked": nobody knows whether it works).
 */
export const runState = (r: { status: string; verdict?: string; checkCantRun?: unknown }) =>
  r.status === "done" && r.verdict === "failing" ? "failing" : r.status === "done" && r.checkCantRun ? "unchecked" : r.status;

export function upsertRun(run: RunSummary) {
  const next = new Map(runs.value);
  next.set(run.id, run);
  runs.value = next;
}

/**
 * Where the event stream is: the server start it belongs to (its epoch), the newest event it
 * brought, and per run the event its snapshot came with. A snapshot older than the one shown
 * (a list fetched while the stream moved on) never replaces a newer one.
 */
const feed = { epoch: "", seq: 0, runSeq: new Map<string, number>() };
/** Called when a run finishes, pauses for you, or a PR watch hands it back (see watchAllRuns). */
let onFinished: ((run: RunSummary) => void) | undefined;

/**
 * A run snapshot from a run's own stream (the run view): it updates the list only when it's newer
 * than what the list shows. That stream replays a run's history first, and an old "running"
 * snapshot in the list would make the next refresh announce a finish that happened long ago.
 */
export function upsertRunFrom(run: RunSummary, seq: number) {
  if (seq <= (feed.runSeq.get(run.id) ?? 0)) return;
  feed.runSeq.set(run.id, seq);
  upsertRun(run);
}

/** Tell `onFinished` about what changed between two snapshots of a run. */
function noticeChange(before: RunSummary | undefined, run: RunSummary) {
  if (!onFinished) return;
  if (before?.status === "running" && run.status !== "running") onFinished(run);
  else if (run.awaiting && !before?.awaiting) onFinished(run); // paused for your decision
  else if (watchNeedingYou(run) && !watchNeedingYou(before)) onFinished(run); // a PR watch handed back to you
}

/** A whole list of runs: `fresher` says which runs this list may not replace. */
function applyRunList(list: RunSummary[], fresher: (id: string) => boolean) {
  const before = runs.value;
  const next = new Map<string, RunSummary>();
  for (const run of list) next.set(run.id, fresher(run.id) && before.has(run.id) ? before.get(run.id)! : run);
  for (const [id, run] of before) if (!next.has(id) && fresher(id)) next.set(id, run);
  runs.value = next;
  for (const run of next.values()) noticeChange(before.get(run.id), run);
}

export async function refreshRuns() {
  const { epoch, seq } = feed;
  try {
    const list = await api<RunSummary[]>("/api/runs");
    // The server restarted while this was on its way: the stream's own list is newer.
    if (feed.epoch !== epoch) return;
    applyRunList(list, (id) => (feed.runSeq.get(id) ?? 0) > seq);
  } catch {
    // keep what we have; the event stream will catch up
  }
}

export const waitingCount = computed(() => [...runs.value.values()].filter(needsYou).length);

// ---------------------------------------------------------------- finding runs
export interface RunFilter {
  q: string;
  /** all | attention (needs you) | running | passed | failing (check fails, failed, stopped) | flagged (tests changed) */
  status: "all" | "attention" | "running" | "passed" | "failing" | "flagged";
  pattern: string;
  agent: string;
  /** Only runs in the selected repository. */
  thisRepo: boolean;
}
// Filters are remembered; the search text isn't.
export const runFilter = signal<RunFilter>({ status: "all", pattern: "", agent: "", thisRepo: false, ...store.json<Partial<RunFilter>>("runFilter", {}), q: "" });
export function setRunFilter(patch: Partial<RunFilter>) {
  runFilter.value = { ...runFilter.value, ...patch };
  const { q: _q, ...kept } = runFilter.value;
  store.set("runFilter", JSON.stringify(kept));
}
export const filterActive = computed(() => {
  const f = runFilter.value;
  return !!(f.q.trim() || f.status !== "all" || f.pattern || f.agent || f.thisRepo);
});
const flagged = (r: RunSummary) => Object.keys(r.integrity ?? {}).length > 0 || !!r.followUps?.some((f) => f.integrity?.length); // replayed snapshots of older runs have no followUps
export function matchesFilter(r: RunSummary, f = runFilter.value): boolean {
  if (f.thisRepo && repo.value && r.repo !== repo.value) return false;
  if (f.pattern && r.pattern !== f.pattern) return false;
  if (f.agent && !Object.values(r.roles).some((ids) => ids.includes(f.agent as AgentId))) return false;
  switch (f.status) {
    case "attention":
      if (!needsYou(r)) return false;
      break;
    case "running":
      if (r.status !== "running") return false;
      break;
    case "passed":
      if (!(r.status === "done" && r.verdict !== "failing" && !r.checkCantRun)) return false;
      break;
    case "failing":
      if (!(r.verdict === "failing" || ["failed", "stopped", "interrupted"].includes(r.status))) return false;
      break;
    case "flagged":
      if (!flagged(r)) return false;
      break;
  }
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.task, r.id, r.repo, r.pattern, r.branchPrefix, r.source ? `#${r.source.number} ${r.source.title}` : "", r.trigger?.name ?? "", r.group?.label ?? ""].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}
export const isFlagged = flagged;

/**
 * How the sidebar lists runs: under their projects or by status, whether archived runs show,
 * and which project groups you folded. Remembered, like the filters.
 */
export interface RailView {
  group: "project" | "status";
  archived: boolean;
  collapsed: string[];
}
export const railView = signal<RailView>({ group: "project", archived: false, collapsed: [], ...store.json<Partial<RailView>>("railView", {}) });
export function setRailView(patch: Partial<RailView>) {
  railView.value = { ...railView.value, ...patch };
  store.set("railView", JSON.stringify(railView.value));
}

const fetchedFor = new Set<string>();

type FeedMessage =
  | { type: "hello"; epoch: string; seq: number; runs?: RunSummary[]; resumed?: boolean }
  | { type: "run"; seq: number; run: RunSummary };

export function watchAllRuns(notify: (run: RunSummary) => void) {
  onFinished = notify;
  const connect = () => {
    const source = new EventSource("/api/events");
    let dropped = false;
    source.onmessage = (msg) => {
      const data = JSON.parse(msg.data) as FeedMessage;
      if (data.type === "hello") {
        // Another server start numbers its events afresh: what we kept from the last one says nothing.
        if (data.epoch !== feed.epoch) feed.runSeq.clear();
        feed.epoch = data.epoch;
        if (data.runs) {
          // The whole list, in step with the stream: every run in it is as new as this event.
          for (const run of data.runs) feed.runSeq.set(run.id, data.seq);
          applyRunList(data.runs, () => false);
        }
        feed.seq = Math.max(data.runs ? 0 : feed.seq, data.seq);
        return;
      }
      const { run, seq } = data;
      if (seq <= (feed.runSeq.get(run.id) ?? 0)) return; // older than what's shown
      feed.runSeq.set(run.id, seq);
      feed.seq = Math.max(feed.seq, seq);
      const before = runs.value.get(run.id);
      upsertRun(run);
      // A project made elsewhere (an automation's first run in a repo, another tab): fetch it once.
      if (run.project && !projects.value.some((p) => p.id === run.project) && !fetchedFor.has(run.project)) {
        fetchedFor.add(run.project);
        void loadProjects();
      }
      noticeChange(before, run);
    };
    // Back after a drop (the browser reconnects by itself): catch up on what the stream may have missed.
    source.onopen = () => {
      if (dropped) void refreshRuns();
      dropped = false;
    };
    // A closed stream (the server restarted, or this session ended): find out which, then reconnect.
    source.onerror = () => {
      dropped = true;
      if (source.readyState !== EventSource.CLOSED) return;
      setTimeout(() => {
        api("/api/health").then(
          () => {
            void refreshRuns();
            connect();
          },
          () => setTimeout(connect, 5_000),
        );
      }, 1_000);
    };
  };
  connect();
}

/** A PR watch that gave up and handed the PR back to you. */
export const watchNeedingYou = (run?: RunSummary) => Object.values(run?.watches ?? {}).find((w) => w.state === "needs-you");

// ---------------------------------------------------------------- GitHub
export interface Template {
  id: string;
  name: string;
  description: string;
  pattern: string;
  task: string;
  needs?: "issue" | "pr";
  ciLogs?: boolean;
  /** A sweep: list this kind of work and start one run per picked item. */
  sweep?: "issues" | "dependabot" | "alerts";
}
export interface SourcePick {
  kind: "issue" | "pr" | "alert";
  number: number;
  title: string;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  ciLogs?: boolean;
  tool?: "dependabot" | "code-scanning";
  numbers?: number[];
}
export const templates = signal<Template[]>([]);
/** The sweep dialog, open with the sweep template you picked. */
export const sweepPicker = signal<Template | null>(null);
/** The issue or PR the next run starts from. */
export const source = signal<SourcePick | null>(null);
/** The GitHub picker, and the template waiting for its pick. */
export const ghPicker = signal<{ kind: "issue" | "pr"; template?: Template } | null>(null);

export function applyTemplate(t: Template, pick?: SourcePick) {
  setPattern(t.pattern);
  const fill = (text: string) => (pick ? text.replace(/\{number\}/g, String(pick.number)).replace(/\{title\}/g, pick.title) : text);
  setTask(fill(t.task));
  source.value = pick ? { ...pick, ciLogs: !!t.ciLogs } : null;
}

export const markSeen = (id: string) => post(`/api/runs/${id}/seen`).catch(() => {});
