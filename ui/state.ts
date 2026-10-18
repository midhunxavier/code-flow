import { computed, signal } from "@preact/signals";
import { api, ApiError, post, showToast, store } from "./lib.js";
import { independentRoles, type RoleValue } from "./roles.js";
import { defaultPlanApproval, teamAwaitingAnswer } from "./team-state.js";
import { hashFor, parseRouteHash, SIDE_TABS, type Route, type SideTab } from "./navigation.js";
export { hashFor, SIDE_TABS, type Route, type SideTab } from "./navigation.js";
import type { TeamRollout } from "../src/team-evaluation.js";
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
export const teamRollout = signal<TeamRollout | null>(null);
export async function loadTeamRollout() {
  try {
    const rollout = await api<TeamRollout>("/api/team-rollout");
    teamRollout.value = rollout;
    if (rollout.enabled && rollout.stage === "default" && !store.get("pattern") && patterns.value.some((item) => item.id === "auto-team")) patternId.value = "auto-team";
  } catch { /* The existing app remains usable if optional evaluation metadata cannot load. */ }
}
/** The first list of runs has come: until then, a run missing from `runs` may just not be here yet. */
export const runsLoaded = signal(false);

export const route = signal<Route>({ view: "composer" });
/** The current view lives in the URL hash, so reload, back/forward and links work. */
export function routeFromHash(hash = location.hash): Route {
  return parseRouteHash(hash);
}
export const railOpen = signal(false);
export const pickerOpen = signal(false);

// ---------------------------------------------------------------- side panel
/** The side panel's tabs: a chat with one agent, a run's changes, the files, a terminal, a browser, your notes. */
/** Open as you left it on a wide screen; on a phone it covers the work, so it starts closed. */
export const sideOpen = signal(window.innerWidth > 760 && store.get("sideOpen") === "1");
export const sideTab = signal<SideTab>(SIDE_TABS.includes(store.get("sideTab") as SideTab) ? (store.get("sideTab") as SideTab) : "chat");
/** Width of the side panel on wide screens, in pixels; dragged, and remembered. */
export const sideWidth = signal(Math.min(Math.max(Number(store.get("sideWidth")) || 420, 300), 900));
export function openSide(tab?: SideTab) {
  if (tab) {
    showSideTab(tab);
    rememberSide({ tab });
  }
  sideOpen.value = true;
  store.set("sideOpen", "1");
}
function showSideTab(tab: SideTab) {
  sideTab.value = tab;
  store.set("sideTab", tab);
}
export function closeSide() {
  sideOpen.value = false;
  store.set("sideOpen", "0");
}
export function setSideWidth(px: number) {
  sideWidth.value = Math.min(Math.max(Math.round(px), 300), 900);
  store.set("sideWidth", String(sideWidth.value));
}
/**
 * The chat shown in the side panel for what it's looking at: a run's side chat ("side:<chat>"), a
 * Single-agent run (its id), a new separate chat ("solo"), or null for a new chat. `scope` is the
 * key of the run or project it's for, when that may not be what the panel shows now.
 */
export const sideChat = computed(() => sideMemo.value.chat || null);
export function setSideChat(key: string | null, scope = sideScope.value.key) {
  const m = sideMemory.value[scope] ?? { at: 0 };
  const run = key && !key.startsWith("side:") && key !== "solo";
  // A chat you open here gets a place in the strip; a side chat you go back to comes back to it.
  rememberSide(
    {
      chat: key ?? "",
      chats: run && !(m.chats ?? []).includes(key) ? [...(m.chats ?? []), key] : m.chats,
      closed: key?.startsWith("side:") ? m.closed?.filter((k) => k !== key) : m.closed,
    },
    scope,
  );
}
/** Text handed to the side chat's composer (from Notes, or a file). */
export const sideDraft = signal("");

/**
 * Something to send that came from elsewhere, for a message box to pick up: the Browser's pins (text
 * and snapshots). `to`: "main:<run>" (the run's own conversation), "side:<chat>", "side:new", or
 * "composer" (a new run's task).
 */
export interface ChatDraft {
  to: string;
  text: string;
  images: Attachment[];
}
export const chatDrafts = signal<ChatDraft[]>([]);
export function draftTo(to: string, text: string, images: Attachment[] = []) {
  chatDrafts.value = [...chatDrafts.value, { to, text, images }];
}
/** The drafts waiting for a message box, taken out of the queue. */
export function takeDrafts(to: string): ChatDraft[] {
  const mine = chatDrafts.value.filter((d) => d.to === to);
  if (mine.length) chatDrafts.value = chatDrafts.value.filter((d) => d.to !== to);
  return mine;
}
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
export const commandPaletteOpen = signal(false);

// ---------------------------------------------------------------- repository
export const repoInfo = signal<RepoInfo | null>(null);
export const repoError = signal("");
export const repoChecking = signal(false);
export const configChecking = signal(false);
export const repo = computed(() => repoInfo.value?.repo ?? "");
let repoSelection = 0;
let configRequest = 0;

export async function setRepo(path: string, remember = true) {
  path = path.trim();
  const request = ++repoSelection;
  ++configRequest;
  repoInfo.value = null;
  repoConfig.value = null;
  setupCmd.value = "";
  checkCmd.value = "";
  checkHint.value = "";
  trust.value = (["safe", "standard", "trusted", "full"].includes(store.get("trust") ?? "") ? store.get("trust") : "standard") as Trust;
  contextPaths.value = new Map();
  configChecking.value = false;
  repoChecking.value = true;
  repoError.value = "";
  try {
    const info = await api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`);
    if (request !== repoSelection) return false;
    repoInfo.value = info;
    if (baseRef.value && !info.branches.some((branch) => branch.name === baseRef.value)) baseRef.value = "";
    if (remember) {
      store.set("repo", info.repo);
      store.set("recentRepos", JSON.stringify([info.repo, ...recentRepos().filter((p) => p !== info.repo)].slice(0, 8)));
    }
  } catch (err) {
    if (request !== repoSelection) return false;
    repoInfo.value = null;
    repoError.value = path ? repoProblem(path.split("/").pop() || path, err) : "";
  } finally {
    if (request === repoSelection) repoChecking.value = false;
  }
  if (request !== repoSelection) return false;
  await loadCheck();
  return request === repoSelection;
}
export const recentRepos = () => store.json<string[]>("recentRepos", []);
/** The folder picker adds a repo to something (a project you're editing) instead of choosing the composer's repo. */
export const pickerChoose = signal<{ title: string; choose: (path: string) => void } | null>(null);

// ---------------------------------------------------------------- projects
/** Which runs the app shows: one project's (its id), every run (ALL), or the runs in no project (NONE). */
export const ALL = "";
export const NONE = "none";
export const projects = signal<Project[]>([]);
/** The list of projects has come: until then, an empty list says nothing about a project being gone. */
export const projectsLoaded = signal(false);
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
    projectsLoaded.value = true;
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
  composerOrigins.value = { ...composerOrigins.value, pattern: "Project defaults", roles: "Project defaults", models: "Project defaults" };
}

/** You picked a repo: if the project you're in doesn't hold it, show the repo's own project (or every run, if none holds it yet). */
export async function pickRepo(path: string) {
  if (!(await setRepo(path))) return;
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

// ---------------------------------------------------------------- what the side panel is about
/**
 * The side panel follows what you're looking at: on a run (or its review), that run, its project
 * and its worktrees; anywhere else, the composer's project and repository. Pinned, it stays put.
 */
export interface SideScope {
  /** Names the scope in the panel's memory: run:<id>, project:<id>, repo:<path>, or none. */
  key: string;
  kind: "run" | "project";
  run?: RunSummary;
  project?: Project;
  /** The repository to work in; "" when there's none to go on. */
  repo: string;
  pinned: boolean;
  /** Its run or project hasn't loaded yet: the panel waits, so no tab acts on a scope without them. */
  waiting?: boolean;
}
type SidePin = { kind: "run"; id: string } | { kind: "project"; project?: string; repo: string };
const sidePin = signal<SidePin | null>(store.json<SidePin | null>("sidePin", null));

const runScope = (run: RunSummary, pinned = false): SideScope => ({ key: `run:${run.id}`, kind: "run", run, project: projectFor(run), repo: run.repo, pinned });
function projectScope(project: Project | undefined, repo: string, pinned = false): SideScope {
  const r = repo || project?.repos[0] || "";
  return { key: project ? `project:${project.id}` : r ? `repo:${r}` : "none", kind: "project", project, repo: r, pinned };
}
/** A run's or project's scope by its key alone, for while the list it's in is on its way. */
function waitingScope(key: string, pinned: boolean): SideScope {
  const run = key.startsWith("run:");
  return { key, kind: run ? "run" : "project", repo: "", pinned, waiting: !(run ? runsLoaded.value : projectsLoaded.value) };
}
/** Where a run's project-level memory lives (its app's address, say), for the run to fall back on. */
export const projectKeyOf = (run: RunSummary) => projectScope(projectFor(run), run.repo).key;

/** What the panel would show if it weren't pinned. */
const followed = computed<SideScope>(() => {
  const r = route.value;
  if (r.view === "project") {
    // A project's page: its repository you're working in, else the one its latest run used.
    const p = projects.value.find((x) => x.id === r.id);
    if (p) return projectScope(p, p.repos.includes(repo.value) ? repo.value : p.repos.length ? lastRepo(p) : "");
  }
  if (r.view === "run" || r.view === "review") {
    const run = runs.value.get(r.id);
    if (run) return runScope(run);
    // On a reload the page can come before the runs: the panel waits on the run, not on the composer's scope.
    if (!runsLoaded.value) return waitingScope(`run:${r.id}`, false);
  }
  return projectScope(target.value.project, repo.value);
});
/**
 * In a side panel popped out into its own window: the scope it shows, from its own address
 * (#/side/<tab>/<scope>), never saved. A window that stops being a popped-out panel stops showing it.
 */
export const poppedScope = computed(() => (route.value.view === "side" ? route.value.scope : null));
function scopeFromKey(key: string): SideScope | undefined {
  if (key.startsWith("run:")) {
    const run = runs.value.get(key.slice(4));
    return run ? runScope(run, true) : undefined;
  }
  if (key.startsWith("project:")) {
    const p = projects.value.find((x) => x.id === key.slice(8));
    return p ? projectScope(p, p.repos.includes(repo.value) ? repo.value : p.repos.length ? lastRepo(p) : "", true) : undefined;
  }
  return key.startsWith("repo:") ? projectScope(undefined, key.slice(5), true) : undefined;
}

export const sideScope = computed<SideScope>(() => {
  const popped = poppedScope.value;
  // Until its run or project has loaded, a popped-out panel waits on its key.
  if (popped) return scopeFromKey(popped) ?? waitingScope(popped, true);
  const pin = sidePin.value;
  if (pin?.kind === "run") {
    // A run that isn't loaded (yet, or any more) can't be shown: follow until it is.
    const run = runs.value.get(pin.id);
    if (run) return runScope(run, true);
  } else if (pin) {
    return projectScope(projects.value.find((p) => p.id === pin.project), pin.repo, true);
  }
  return followed.value;
});
function setPin(pin: SidePin | null) {
  sidePin.value = pin;
  store.set("sidePin", JSON.stringify(pin));
}
export function pinSide(on: boolean) {
  const s = sideScope.value;
  setPin(!on ? null : s.run ? { kind: "run", id: s.run.id } : { kind: "project", project: s.project?.id, repo: s.repo });
}

/**
 * Show a run's side chat in the panel. On another run, the panel moves to this one: it follows you
 * again if you're on this run's page, else it's pinned to it. A popped-out panel shows only its own
 * scope: the main window opens the run, with the chat in its panel.
 */
export function openSideChat(runId: string, chat: string) {
  const key = `run:${runId}`;
  if (poppedScope.value && poppedScope.value !== key) return handOff({ type: HANDOFF, route: { view: "run", id: runId }, drafts: [], sideChat: { run: runId, chat } });
  setSideChat(`side:${chat}`, key);
  if (sideScope.value.key !== key) setPin(followed.value.key === key ? null : { kind: "run", id: runId });
  openSide("chat");
}

/** What the panel remembers per scope, so going back to a run brings back its panel. */
export interface SideMemory {
  tab?: SideTab;
  /** The chat shown (see `sideChat`); "" for a new chat. */
  chat?: string;
  /** Chats (Single-agent runs) open in the strip, in order. */
  chats?: string[];
  /** Side chats whose pill you closed (they stay in the list of all chats). */
  closed?: string[];
  /** Per chat, how many of its turns had finished when you last looked: more is a new reply. */
  seen?: Record<string, number>;
  /** The folder the Files tab shows. */
  files?: string;
  /** Terminals open in the strip, the one shown, and with the panel split, the one below. */
  shells?: string[];
  shell?: string;
  below?: string;
  split?: boolean;
  /** The Browser tab's pages (tabs of its own), the one shown, the one beside it to compare, and the width. */
  pages?: { id: string; url: string }[];
  page?: string;
  compare?: string;
  device?: "phone" | "tablet" | "full";
  /** Where the Browser's pins went last (see ChatDraft). */
  sendTo?: string;
  /** Before pages: the one address the Browser had. */
  url?: string;
  at: number;
}
const MAX_SIDE_MEMORIES = 200;
export const sideMemory = signal<Record<string, SideMemory>>(store.json("sideMemory", {}));
export const sideMemo = computed<SideMemory>(() => sideMemory.value[sideScope.value.key] ?? { at: 0 });
export function rememberSide(patch: Omit<Partial<SideMemory>, "at">, key = sideScope.value.key) {
  const all = { ...sideMemory.value, [key]: { ...sideMemory.value[key], ...patch, at: Date.now() } };
  const keys = Object.keys(all);
  if (keys.length > MAX_SIDE_MEMORIES) for (const k of keys.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, keys.length - MAX_SIDE_MEMORIES)) delete all[k];
  sideMemory.value = all;
  store.set("sideMemory", JSON.stringify(all));
}
// Another window (a popped-out panel) changed the memory: take it, so neither writes over the other.
window.addEventListener("storage", (e) => {
  if (e.key === "sideMemory" && e.newValue) {
    try {
      sideMemory.value = JSON.parse(e.newValue);
    } catch {
      // a half-written value: the next change brings a whole one
    }
  }
});

/** The scope changed: show the tab you last had open there, if any. */
export function restoreSideTab() {
  const tab = sideMemo.value.tab;
  if (tab && SIDE_TABS.includes(tab) && tab !== sideTab.value) showSideTab(tab);
}

// ---------------------------------------------------------------- a popped-out panel and the main window
const HANDOFF = "codeflow:open";
const READY = "codeflow:ready";
/**
 * What a popped-out panel hands to the main window: a page to show, drafts for its message boxes,
 * and a run's side chat to show in its panel.
 */
interface HandOff {
  type: typeof HANDOFF;
  route: Route;
  drafts: ChatDraft[];
  sideChat?: { run: string; chat: string };
}
/** The main window this panel opened, the one that opened it being gone, and what waits until it's ready. */
let opened: Window | null = null;
let openedReady = false;
const forOpened: HandOff[] = [];

/**
 * Go to a page, with drafts for its message boxes. A popped-out panel stays a panel: the page opens
 * in the main window, the one that opened it (or a new one if that's gone), and the drafts go along.
 */
export function navigate(to: Route, drafts: ChatDraft[] = []) {
  if (route.value.view === "side") return handOff({ type: HANDOFF, route: to, drafts });
  for (const d of drafts) draftTo(d.to, d.text, d.images);
  route.value = to;
}

/** The window to hand off to: one this panel opened, else its opener, while it's still code-flow's. */
function mainWindow(): Window | null {
  for (const w of [opened, window.opener as Window | null]) {
    try {
      if (w && !w.closed && w.location.origin === location.origin) return w;
    } catch {
      // another site's window: its location can't be read
    }
  }
  return null;
}

function handOff(h: HandOff) {
  const main = mainWindow();
  if (main && (main !== opened || openedReady)) {
    main.postMessage(h, location.origin);
    main.focus();
    return;
  }
  // A new window can't take a message until it has loaded: it asks for what waits once it has.
  if (!main) {
    forOpened.length = 0;
    openedReady = false;
    opened = window.open(`${location.origin}${location.pathname}${hashFor(h.route)}`, "_blank");
    if (!opened) return showToast("The browser blocked the window: allow pop-ups for code-flow", 5000);
  }
  forOpened.push(h);
}

/**
 * Every window listens to the others: a main window takes what a popped-out panel hands over, and
 * one a panel opened says it's ready for it. Only code-flow's own pages count, not one in the Browser tab.
 */
export function listenForHandOffs() {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const m = e.data as Partial<HandOff> | { type?: string } | null;
    if (m?.type === READY && opened && e.source === opened) {
      openedReady = true;
      for (const h of forOpened.splice(0)) opened.postMessage(h, location.origin);
      return;
    }
    if (m?.type !== HANDOFF || route.value.view === "side") return;
    const h = m as HandOff;
    if (typeof h.route?.view !== "string" || h.route.view === "side") return;
    navigate(h.route, Array.isArray(h.drafts) ? h.drafts : []);
    if (h.sideChat) openSideChat(h.sideChat.run, h.sideChat.chat);
  });
  if (route.value.view !== "side") (window.opener as Window | null)?.postMessage({ type: READY }, location.origin);
}

// ---------------------------------------------------------------- composer
export const task = signal(store.get("draftTask") ?? "");
export const acceptanceCriteria = signal<string[]>(store.json<unknown>("draftAcceptance", []) instanceof Array ? store.json<unknown[]>("draftAcceptance", []).filter((v): v is string => typeof v === "string").slice(0, 100) : []);
export function setAcceptanceCriteria(criteria: string[]) {
  acceptanceCriteria.value = criteria.slice(0, 100).map((c) => c.slice(0, 2000));
  store.set("draftAcceptance", JSON.stringify(acceptanceCriteria.value));
}
export const composerOrigins = signal<Record<string, string>>({ pattern: store.get("pattern") ? "Browser preference" : "Application default", roles: store.get("roleSel") ? "Browser preferences" : "Workflow defaults", models: store.get("agentSettings") ? "Browser preferences" : "CLI defaults" });
export const contextPaths = signal<Map<string, ContextItem>>(new Map());
export const attachments = signal<Attachment[]>([]);
export const contextError = signal("");
export const patternId = signal(store.get("pattern") ?? "pipeline");
export const pattern = computed(() => patterns.value.find((p) => p.id === patternId.value) ?? patterns.value[0]);
/** A role is filled by an agent, or "auto": code-flow picks one whose plan has room. */
export type { RoleValue } from "./roles.js";
export const roleSel = signal<Record<string, Record<string, RoleValue[]>>>(store.json("roleSel", {}));
export const optionValues = signal<Record<string, Record<string, number | boolean>>>({});
export const agentSettings = signal<AgentSettings>(store.json("agentSettings", {}));
export const baseRef = signal(store.get("baseRef") ?? "");
export const branchPrefix = signal("");
export const checkCmd = signal("");
export const checkHint = signal("");
export const setupCmd = signal("");
export const limits = signal(store.json<{ maxMinutes: number; maxSteps: number; maxTokens?: number; maxCostUsd?: number }>("limits", { maxMinutes: 60, maxSteps: 40 }));
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
interface RepoConfiguration { config: Record<string, any>; found: boolean; error?: string }
export const repoConfig = signal<RepoConfiguration | null>(null);

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

/**
 * "Let me approve the plan before agents build" (patterns that have a plan step). The choice is
 * remembered per pattern: unticking it for Plan → Build → Review must not silently dispatch an
 * Auto team without its approval checkpoint. Older installs stored one shared choice; it still
 * applies to the manual patterns.
 */
const approvalChoices = signal<Record<string, boolean>>(store.json<Record<string, boolean>>("approvePlanByPattern", {}));
const legacyApproval = store.get("approvePlan");
export function setApprovePlan(on: boolean, patternId: string) {
  approvalChoices.value = { ...approvalChoices.value, [patternId]: on };
  store.set("approvePlanByPattern", JSON.stringify(approvalChoices.value));
}
/** New Auto teams pause before dispatch unless the user has chosen otherwise for Auto team itself. */
export function planApprovalFor(patternId: string): boolean {
  const chosen = approvalChoices.value[patternId];
  if (chosen !== undefined) return chosen;
  return defaultPlanApproval(patternId, patternId !== "auto-team" && legacyApproval !== null ? legacyApproval === "1" : undefined);
}
/** Patterns with a plan checkpoint, and what you approve there. */
export const CHECKPOINTS: Record<string, string> = { pipeline: "the plan", debate: "the plan", supervisor: "the subtasks", tdd: "the tests", "auto-team": "the team and plan" };

export function setTask(value: string) {
  task.value = value;
  store.set("draftTask", value);
}
export function setPattern(id: string) {
  patternId.value = id;
  store.set("pattern", id);
  composerOrigins.value = { ...composerOrigins.value, pattern: "This run (remembered)" };
}
export function setRoles(patternId: string, roleId: string, ids: RoleValue[]) {
  roleSel.value = { ...roleSel.value, [patternId]: { ...(roleSel.value[patternId] ?? {}), [roleId]: ids } };
  store.set("roleSel", JSON.stringify(roleSel.value));
  composerOrigins.value = { ...composerOrigins.value, roles: "This run (remembered)" };
}
export function setAgentSetting(id: AgentId, patch: { model?: string; effort?: string }) {
  agentSettings.value = { ...agentSettings.value, [id]: { ...(agentSettings.value[id] ?? {}), ...patch } };
  store.set("agentSettings", JSON.stringify(agentSettings.value));
  composerOrigins.value = { ...composerOrigins.value, models: "This run (remembered)" };
}
export function setCheck(value: string) {
  checkCmd.value = value;
  if (repo.value) store.set(`check:${repo.value}`, value);
}
export function setSetup(value: string) {
  setupCmd.value = value;
  if (repo.value) store.set(`setup:${repo.value}`, value);
}
export function setLimits(patch: Partial<{ maxMinutes: number; maxSteps: number; maxTokens?: number; maxCostUsd?: number }>) {
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
    if (p.id === "auto-team" && role.id === "coordinator" && !saved[role.id]) ids = ["auto"];
    if (!role.multiple) ids = ids.slice(0, 1);
    if (!ids.length && !role.optional && !saved[role.id] && firstAvailable) ids = [firstAvailable];
    roles[role.id] = ids;
  }
  // Judges, reviewers and synthesizers default to a vendor that didn't do the work they check.
  return independentRoles(p.id, roles, saved, agents.value.filter((a) => a.available).map((a) => a.id));
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
  const request = ++configRequest;
  const selection = repoSelection;
  const current = () => request === configRequest && selection === repoSelection && repo.value === r;
  configChecking.value = !!r;
  repoConfig.value = null;
  setupCmd.value = r ? store.get(`setup:${r}`) ?? "" : "";
  checkCmd.value = r ? store.get(`check:${r}`) ?? "" : "";
  checkHint.value = "";
  if (!r) {
    return;
  }
  let result: RepoConfiguration | null = null;
  try {
    result = await api(`/api/repo-config?repo=${encodeURIComponent(r)}`);
  } catch {
    // Repository commands remain editable even when configuration cannot be read.
  }
  if (!current()) return;
  repoConfig.value = result;
  const config = repoConfig.value?.config ?? {};
  if (store.get(`setup:${r}`) === null && !setupCmd.value && config.setup) setupCmd.value = config.setup;
  if (config.trust && !store.get("trust")) trust.value = config.trust;
  const saved = store.get(`check:${r}`);
  // A detected setup (`uv sync`, `poetry install`) fills an empty setup you haven't edited.
  const detectSetup = !setupCmd.value && store.get(`setup:${r}`) === null;
  if (saved !== null || config.check) {
    checkCmd.value = saved ?? config.check!;
    checkHint.value = saved !== null ? "" : "From .codeflow/config.json.";
    if (!detectSetup) {
      configChecking.value = false;
      return;
    }
  } else {
    checkCmd.value = "";
  }
  try {
    const d = await api<{ command: string | null; source?: string; setup?: string }>(`/api/check?repo=${encodeURIComponent(r)}`);
    if (!current()) return;
    // A late result fills only fields nobody touched during the lookup: it must neither replace
    // what you typed meanwhile nor land in the input while you are typing into it.
    if (detectSetup && d.setup && !setupCmd.value && store.get(`setup:${r}`) === null) setupCmd.value = d.setup;
    if (saved !== null || config.check || store.get(`check:${r}`) !== null || checkCmd.value) return;
    checkCmd.value = d.command ?? "";
    checkHint.value = d.command ? `Detected from ${d.source}${d.setup ? `; each worktree is set up with “${d.setup}” (Settings)` : ""}.` : "No test command found in this repo.";
  } catch {
    if (current() && saved === null && !config.check) checkHint.value = "";
  } finally {
    if (current()) configChecking.value = false;
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
export const needsYou = (r: RunSummary) => !r.archived && (!!r.awaiting || teamAwaitingAnswer(r) || (r.status !== "running" && (r.status === "interrupted" || !r.seen)));
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
interface RunPage { runs: RunSummary[]; total: number; nextCursor?: string }
export const historyTotal = signal<number | null>(null);
export const historyNextCursor = signal<string | null>(null);
export const historyLoading = signal(false);
export const historyLoadingMore = signal(false);
export const historyError = signal("");
let historyQuery = "";
let historyGeneration = 0;
let historyPages = 0;
let historyRefresh = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function prepareHistoryQuery(query: string) {
  if (query === historyQuery) return;
  historyQuery = query;
  historyGeneration++;
  historyPages = 0;
  historyTotal.value = null;
  historyNextCursor.value = null;
  historyLoadingMore.value = false;
  historyError.value = "";
}
export const connection = signal<{ state: "connecting" | "connected" | "reconnecting" | "offline"; since: number; lastReceived?: number }>({ state: "connecting", since: Date.now() });
function connectionState(state: typeof connection.value.state) {
  connection.value = { ...connection.value, state, since: connection.value.state === state ? connection.value.since : Date.now() };
}
/** Called when a run finishes, pauses for you, or a PR watch hands it back (see watchAllRuns). */
let onFinished: ((run: RunSummary) => void) | undefined;

/** Tell `onFinished` about what changed between two snapshots of a run. */
function noticeChange(before: RunSummary | undefined, run: RunSummary) {
  if (!onFinished) return;
  if (before?.status === "running" && run.status !== "running") onFinished(run);
  else if (run.awaiting && !before?.awaiting) onFinished(run); // paused for your decision
  else if (teamAwaitingAnswer(run) && run.team!.awaitingRequestId !== before?.team?.awaitingRequestId) onFinished(run);
  else if (watchNeedingYou(run) && !watchNeedingYou(before)) onFinished(run); // a PR watch handed back to you
}

/** A whole list of runs: `fresher` says which runs this list may not replace. */
function applyRunList(list: RunSummary[], fresher: (id: string) => boolean, preserve = false) {
  const before = runs.value;
  const next = preserve ? new Map(before) : new Map<string, RunSummary>();
  for (const run of list) next.set(run.id, fresher(run.id) && before.has(run.id) ? before.get(run.id)! : run);
  for (const [id, run] of before) if (!next.has(id) && fresher(id)) next.set(id, run);
  runs.value = next;
  runsLoaded.value = true;
  for (const run of next.values()) noticeChange(before.get(run.id), run);
}

export async function refreshRuns() {
  const { epoch, seq } = feed;
  const query = runFilter.value.q.trim();
  prepareHistoryQuery(query);
  const generation = historyGeneration;
  const request = ++historyRefresh;
  historyLoading.value = true;
  try {
    const page = await api<RunPage | RunSummary[]>(`/api/runs?limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    // The server restarted while this was on its way: the stream's own list is newer.
    if (feed.epoch !== epoch || generation !== historyGeneration || query !== runFilter.value.q.trim() || request !== historyRefresh) return;
    const list = Array.isArray(page) ? page : page.runs;
    applyRunList(list, (id) => (feed.runSeq.get(id) ?? 0) > seq, true);
    historyTotal.value = Array.isArray(page) ? page.length : page.total;
    if (historyPages <= 1) historyNextCursor.value = Array.isArray(page) ? null : page.nextCursor ?? null;
    historyPages = Math.max(1, historyPages);
    historyError.value = "";
  } catch (error) {
    if (generation === historyGeneration && request === historyRefresh) historyError.value = (error as Error).message;
  } finally {
    if (generation === historyGeneration && request === historyRefresh) historyLoading.value = false;
  }
}

export async function loadOlderRuns() {
  const query = runFilter.value.q.trim();
  prepareHistoryQuery(query);
  const cursor = historyNextCursor.value;
  if (!cursor || historyLoadingMore.value || historyLoading.value) return;
  const generation = historyGeneration;
  const { epoch, seq } = feed;
  historyLoadingMore.value = true;
  historyError.value = "";
  try {
    const page = await api<RunPage>(`/api/runs?limit=100&cursor=${encodeURIComponent(cursor)}${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    if (generation !== historyGeneration || query !== runFilter.value.q.trim() || feed.epoch !== epoch) return;
    applyRunList(page.runs, (id) => (feed.runSeq.get(id) ?? 0) > seq, true);
    historyNextCursor.value = page.nextCursor ?? null;
    historyTotal.value = page.total;
    historyPages++;
  } catch (error) {
    if (generation === historyGeneration) historyError.value = (error as Error).message;
  } finally { if (generation === historyGeneration) historyLoadingMore.value = false; }
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
  if (patch.q !== undefined) {
    prepareHistoryQuery(runFilter.value.q.trim());
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refreshRuns(), 250);
  }
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
  const hay = [r.task, r.id, r.repo, r.pattern, r.branchPrefix, r.source ? `#${r.source.number} ${r.source.title}` : "", r.trigger?.name ?? "", r.group?.label ?? "", r.externalSource?.title ?? ""].join("\n").toLowerCase();
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
  | { type: "hello"; epoch: string; seq: number; runs?: RunSummary[]; resumed?: boolean; nextCursor?: string; total?: number }
  | { type: "run"; seq: number; run: RunSummary };

export function watchAllRuns(notify: (run: RunSummary) => void) {
  onFinished = notify;
  const connect = () => {
    const source = new EventSource("/api/events?limit=100");
    let dropped = false;
    source.onmessage = (msg) => {
      let data: FeedMessage;
      try { data = JSON.parse(msg.data) as FeedMessage; }
      catch { return; }
      if (!data || (data.type !== "hello" && data.type !== "run") || !Number.isSafeInteger(data.seq) || (data.type === "run" && !data.run?.id)) return;
      connection.value = { state: "connected", since: connection.value.state === "connected" ? connection.value.since : Date.now(), lastReceived: Date.now() };
      if (data.type === "hello") {
        // Another server start numbers its events afresh: what we kept from the last one says nothing.
        const restarted = !!feed.epoch && data.epoch !== feed.epoch;
        if (data.epoch !== feed.epoch) feed.runSeq.clear();
        feed.epoch = data.epoch;
        if (restarted) { feed.seq = data.seq; historyGeneration++; historyPages = 0; historyNextCursor.value = null; historyLoading.value = false; historyLoadingMore.value = false; }
        if (data.runs) {
          // The whole list, in step with the stream: every run in it is as new as this event.
          for (const run of data.runs) feed.runSeq.set(run.id, data.seq);
          applyRunList(data.runs, () => false, !restarted);
          if (!runFilter.value.q.trim()) {
            if (typeof data.total === "number") historyTotal.value = data.total;
            if (historyPages <= 1) historyNextCursor.value = data.nextCursor ?? null;
            historyPages = Math.max(1, historyPages);
          } else if (restarted) void refreshRuns();
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
      connectionState("connected");
      if (dropped) void refreshRuns();
      dropped = false;
    };
    // A closed stream (the server restarted, or this session ended): find out which, then reconnect.
    source.onerror = () => {
      dropped = true;
      connectionState(navigator.onLine === false ? "offline" : "reconnecting");
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
  window.addEventListener("offline", () => connectionState("offline"));
  window.addEventListener("online", () => connectionState("reconnecting"));
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
export const externalSource = signal<import("../src/integrations.js").ExternalSource | null>(null);
/** The GitHub picker, and the template waiting for its pick. */
export const ghPicker = signal<{ kind: "issue" | "pr"; template?: Template } | null>(null);

export function applyTemplate(t: Template, pick?: SourcePick) {
  externalSource.value = null;
  setPattern(t.pattern);
  const fill = (text: string) => (pick ? text.replace(/\{number\}/g, String(pick.number)).replace(/\{title\}/g, pick.title) : text);
  setTask(fill(t.task));
  setAcceptanceCriteria([]);
  source.value = pick ? { ...pick, ciLogs: !!t.ciLogs } : null;
}

export const markSeen = (id: string) => post(`/api/runs/${id}/seen`).catch(() => {});
