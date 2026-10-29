import { fillTemplate } from "./composer-tools.js";
import { EXECUTION_LIMITS, numberProblem } from "../src/start-input-validation.js";
import type { ProjectHistoryCounts } from "../src/project-report.js";
import { chatTaskId, groupChatTasks } from "../src/chat-family.js";
import { needsYou, matchesHistoryFilter } from "../src/run-status.js";
import { DEFAULT_EXECUTION_BUDGET } from "../src/execution-budget.js";
export { needsYou, runState, isFlagged } from "../src/run-status.js";
import { rerunDraft } from "./rerun-draft.js";
import { contextBudget, contextBudgetOrigin } from "./context-budget.js";
import { intentDraft, journeyDraft } from "./composer-draft-fields.js";
import { batch, computed, effect, signal, untracked } from "@preact/signals";
import { legacyDraftProject, projectDestination, ProjectDraftStore } from "./project-context.js";
import { supportsRunPermissions } from "../src/run-permissions.js";
import { selectedTeamTemplate } from "./team-template-state.js";
import { readProjectDefaults } from "./project-defaults.js";
import { api, sharedGet, ApiError, post, showToast, showError, store, workspaceId, workspaceKey, SHORT } from "./lib.js";
import { independentRoles, type RoleValue } from "./roles.js";
import { onStreamState, subscribe } from "./stream.js";
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
/** A custom filesystem restriction in some project pauses app-managed work in every project (docs/filesystem-policy.md); every provider says so. */
export const executionPaused = computed(() => agents.value.some((agent) => agent.unavailableReason === "filesystem-policy"));
/** The project Settings → Projects shows first, after a link to review its filesystem policy. */
export const settingsProject = signal("");
let agentsRequest = 0;
export async function loadAgents(force = false) {
  const request = ++agentsRequest;
  const inventory = await sharedGet<AgentInfo[]>(force ? "/api/agents?refresh=1" : "/api/agents");
  if (request !== agentsRequest) return;
  for (const agent of inventory) SHORT[agent.id] = agent.displayName;
  agents.value = inventory;
}
export const patterns = signal<PatternInfo[]>([]);
export const catalogs = signal<Record<string, CatalogOrError>>({});
export const runs = signal<Map<string, RunSummary>>(new Map());
export const teamRollout = signal<TeamRollout | null>(null);
export async function loadTeamRollout() {
  try {
    const rollout = await api<TeamRollout>("/api/team-rollout");
    teamRollout.value = rollout;
    // Evaluation describes evidence; it never changes the selected execution mode.
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
export const railCollapsed = signal(store.get("railCollapsed") === "1");
export const railPeek = signal(false);
/** Reveal search without changing the saved desktop sidebar preference. */
export function peekRail() { if (window.innerWidth > 760) railPeek.value = true; }
export function setRailCollapsed(value: boolean) {
  railPeek.value = false;
  railCollapsed.value = value;
  store.set("railCollapsed", value ? "1" : "0");
}
export const pickerOpen = signal(false);

// ---------------------------------------------------------------- side panel
/** The side panel's tabs: a chat with one agent, a run's changes, the files, a terminal, a browser, your notes. */
/** Open as you left it on a wide screen; on a phone it covers the work, so it starts closed. */
export const sideOpen = signal(window.innerWidth > 760 && store.get("sideOpen") === "1");
export const sideTab = signal<SideTab>(SIDE_TABS.includes(store.get("sideTab") as SideTab) ? (store.get("sideTab") as SideTab) : "chat");
/** Width of the side panel on wide screens, in pixels; dragged, and remembered. */
export const sideWidth = signal(Math.min(Math.max(Number(store.get("sideWidth")) || 420, 300), 900));
const viewportWidth = signal(window.innerWidth);
window.addEventListener("resize", () => { viewportWidth.value = window.innerWidth; });
export const railIsCollapsed = computed(() => viewportWidth.value > 760 && railCollapsed.value && !railPeek.value);
export const sideExpanded = signal(false);
const savedRailWidth = Number(store.get("railWidth"));
/** A custom desktop width survives collapse and smaller viewports; null follows the default. */
export const railWidth = signal<number | null>(Number.isFinite(savedRailWidth) && savedRailWidth > 0 ? Math.min(520, Math.max(220, savedRailWidth)) : null);
export const railMaxWidth = computed(() => Math.max(220, Math.min(520, viewportWidth.value - 360 - (sideOpen.value && !sideExpanded.value ? 300 : 0))));
export const railDisplayWidth = computed(() => Math.min(railWidth.value ?? (viewportWidth.value <= 1180 ? 236 : 248), railMaxWidth.value));
export function setRailWidth(px: number | null) {
  if (px !== null && !Number.isFinite(px)) return;
  railWidth.value = px === null ? null : Math.min(Math.max(Math.round(px), 220), railMaxWidth.value);
  if (railWidth.value === null) store.remove("railWidth");
  else store.set("railWidth", String(railWidth.value));
}
/** Leave room for the conversation when the panel is docked; retain the saved width on resize. */
export const sideMaxWidth = computed(() => Math.max(300, Math.min(900, viewportWidth.value - (railIsCollapsed.value ? 64 : railDisplayWidth.value) - 360)));
export const sideDisplayWidth = computed(() => Math.min(sideWidth.value, sideMaxWidth.value));
export const sideFullWidth = computed(() => sideOpen.value && (sideExpanded.value || viewportWidth.value <= 760));
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
  sideExpanded.value = false;
  sideOpen.value = false;
  store.set("sideOpen", "0");
}
export function setSideWidth(px: number) {
  sideWidth.value = Math.min(Math.max(Math.round(px), 300), sideMaxWidth.value);
  store.set("sideWidth", String(sideWidth.value));
}
/**
 * The chat shown in the side panel for what it's looking at: a run's side chat ("side:<chat>"), a
 * Single-agent run (its id), a new separate chat ("solo"), or null for a new chat. `scope` is the
 * key of the run or project it's for, when that may not be what the panel shows now.
 */
export const sideChat = computed(() => sideMemo.value.chat || null);
export function setSideChat(key: string | null, scope = sideScope.value.key) {
  scope = taskSideKey(scope);
  const m = sideMemoryFor(scope);
  const run = key && !key.startsWith("side:") && key !== "solo";
  // A chat you open here gets a place in the strip; a side chat you go back to comes back to it.
  rememberSide(
    {
      chat: key ?? "",
      chats: run && !(m.chats ?? []).includes(key) ? [...(m.chats ?? []), key] : m.chats,
      closed: key ? m.closed?.filter((k) => k !== key) : m.closed,
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
export const requestedRepository = signal(store.get("repo") ?? "");
let repoSelection = 0;
let configRequest = 0;

let checkLoading: Promise<void> = Promise.resolve();
/** The repo's "Done when" lookup has finished: what's set after this (Edit & run again) isn't overwritten by it. */
export const checkLoaded = () => checkLoading;

export async function setRepo(path: string, remember = true) {
  path = path.trim();
  const retained = path && rerunDraft.value?.repo === repo.value ? rerunDraft.value : null;
  requestedRepository.value = path;
  const request = ++repoSelection;
  ++configRequest;
  const clearSelection = () => {
    rerunDraft.value = null;
    repoInfo.value = null;
    repoConfig.value = null;
    setupCmd.value = "";
    checkCmd.value = "";
    checkHint.value = "";
    checkWarning.value = "";
    // What the draft chose was for the repository it leaves.
    forgetChoices();
    deriveDefaults({});
    configRead = { repo: "", ref: "" };
    contextPaths.value = new Map();
  };
  // A picker path may be an alias of the current repository. Keep retry settings until
  // canonical discovery confirms a different selection; Start remains disabled meanwhile.
  if (!retained) clearSelection();
  configChecking.value = false;
  repoChecking.value = true;
  repoError.value = "";
  if (!path) { if (remember) store.remove("repo"); repoChecking.value = false; return true; }
  try {
    const info = await api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`);
    if (request !== repoSelection) return false;
    const sameRetry = retained && info.repo === retained.repo && rerunDraft.value?.repo === info.repo;
    if (retained && !sameRetry) clearSelection();
    repoInfo.value = info;
    requestedRepository.value = info.repo;
    if (!sameRetry && baseRef.value && !info.branches.some((branch) => branch.name === baseRef.value)) baseRef.value = "";
    if (remember) {
      store.set("repo", info.repo);
      store.set("recentRepos", JSON.stringify([info.repo, ...recentRepos().filter((p) => p !== info.repo)].slice(0, 8)));
    }
    if (sameRetry) return true;
  } catch (err) {
    if (request !== repoSelection) return false;
    if (!retained) repoInfo.value = null;
    repoError.value = path ? repoProblem(path.split("/").pop() || path, err) : "";
    if (retained) return false;
  } finally {
    if (request === repoSelection) repoChecking.value = false;
  }
  if (request !== repoSelection) return false;
  checkLoading = loadCheck();
  await checkLoading;
  return request === repoSelection;
}
export const recentRepos = () => store.json<string[]>("recentRepos", []);
/** The folder picker adds a repo to something (a project you're editing) instead of choosing the composer's repo. */
export const pickerChoose = signal<{ title: string; choose: (path: string) => void | Promise<unknown> } | null>(null);

// ---------------------------------------------------------------- projects
/** Which runs the app shows: one project's (its id), every run (ALL), or the runs in no project (NONE). */
export const ALL = "";
export const NONE = "none";
export const projects = signal<Project[]>([]);
/** The list of projects has come: until then, an empty list says nothing about a project being gone. */
export const projectsLoaded = signal(false);
export const projectsStatus = signal<import("../src/projects.js").ProjectsStatus>({ available: true });
let completeProjectInventory = false;
export const currentProject = signal(store.get("project") ?? ALL);
export const activeProject = computed(() => projects.value.find((p) => p.id === currentProject.value));
/** The draft's destination is independent of global list filters and the page being viewed. */
export const composerProject = signal(store.get("composerProject") ?? "");
export const composerLoading = signal(false);
export const draftsReady = signal(false);
export const draftError = signal("");
export const unreadableDrafts = signal<Record<string, string>>({});
export const draftUnavailable = computed(() => unreadableDrafts.value[composerProject.value] ?? "");
export const projectPickerPurpose = signal<"filter" | "composer">("filter");
export const repositoryChoice = signal<{ repository: string; project?: string } | null>(null);
export const composerRunOptions = signal<{
  taskTeam?: import("../src/task-team.js").TaskTeamConfig;
  remoteWorker?: import("./remote-workers.js").WorkerChoice;
  container?: { enabled: boolean; image: string; authVolume: string };
  verification?: string;
  verificationProfile?: import("../src/verification.js").VerificationProfile | null;
  toolApprovals?: boolean;
  antigravityExecution?: import("../src/run-permissions.js").AntigravityExecution;
  permissionRequirements?: import("../src/run-permissions.js").PermissionRequirement[];
}>({});
export const projectsOpen = signal(false);
/** The Projects dialog opens straight on this project's editor ("new" for a new one), not on the list. */
export const projectEdit = signal<string | null>(null);
export function editProject(id: string) {
  projectPickerPurpose.value = "filter";
  projectEdit.value = id;
  projectsOpen.value = true;
}

export async function loadProjects() {
  const previous = projects.value;
  completeProjectInventory = false;
  try {
    const diagnosis = sharedGet<{ projects?: import("../src/projects.js").ProjectsStatus }>("/api/health").catch(() => null);
    // Show available choices promptly; boot still awaits the storage diagnosis below
    // before restoring drafts or treating project storage as fully loaded.
    projects.value = await sharedGet<Project[]>("/api/projects");
    const status = await diagnosis;
    if (status?.projects) projectsStatus.value = status.projects;
    completeProjectInventory = !!status?.projects?.available && !status.projects.recovery;
    projectsLoaded.value = true;
  } catch {
    return; // keep what we have
  }
  const id = currentProject.value;
  if (id !== ALL && id !== NONE && !projects.value.some((p) => p.id === id)) setCurrentProject(ALL); // deleted, maybe in another tab
  if (completeProjectInventory && draftsReady.value) {
    const gone = previous.filter(project => !projects.value.some(item => item.id === project.id)).map(project => project.id);
    if (composerProject.value && !projects.value.some(project => project.id === composerProject.value)) gone.push(composerProject.value);
    for (const project of new Set(gone)) await discardProjectDraft(project);
  }
  if (completeProjectInventory) {
    const r = route.value;
    const destination = r.view === "project" ? r.id : r.view === "composer" || r.view === "workspace" ? r.project : undefined;
    if (destination && !projects.value.some(project => project.id === destination)) route.value = { view: "projects" };
  }
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
}

function lastRepo(p: Project): string {
  const remembered = store.get(`projectRepo:${p.id}`);
  if (remembered && p.repos.includes(remembered)) return remembered;
  const latest = [...runs.value.values()].filter((r) => p.repos.includes(r.repo) && projectFor(r)?.id === p.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  return latest?.repo ?? p.repos[0] ?? "";
}

/**
 * Prefill a fresh draft with the team a project remembers. Only this draft changes: the workflow,
 * team and models saved in Settings stay as they are for every other project.
 */
function applyDefaults(d: ProjectDefaults) {
  const origins = { ...composerOrigins.value };
  for (const [patternId, team] of Object.entries(d.teams)) {
    roleSel.value = { ...roleSel.value, [patternId]: structuredClone(team.roles) as Record<string, RoleValue[]> };
    roleModels.value = { ...roleModels.value, [patternId]: structuredClone(team.roleSettings ?? {}) };
    origins.roles = "Project defaults";
  }
  if (patterns.value.some((p) => p.id === d.pattern)) {
    selectedTeamTemplate.value = null;
    patternId.value = d.pattern;
    origins.pattern = "Project defaults";
  }
  if (d.agentSettings && Object.keys(d.agentSettings).length) {
    agentSettings.value = { ...agentSettings.value, ...structuredClone(d.agentSettings) };
    origins.models = "Project defaults";
  }
  composerOrigins.value = origins;
}

/** Opening a repository requires a deliberate destination when membership is ambiguous or absent. */
let repositoryPick = 0;
export async function pickRepo(path: string, project = composerProject.value) {
  const request = ++repositoryPick;
  try {
    const info = await api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(path)}`);
    if (request !== repositoryPick) return;
    if (!projectsStatus.value.available) {
      if (!await openComposer("", { repository: info.repo })) return;
      route.value = { view: "composer", project: "" }; return;
    }
    const p = projects.value.find(item => item.id === project);
    if (p?.repos.includes(info.repo)) {
      if (composerProject.value !== p.id && !await openComposer(p.id)) return;
      await chooseComposerRepository(info.repo);
      route.value = { view: "composer", project: p.id };
      return;
    }
    const matches = projects.value.filter(item => item.repos.includes(info.repo));
    if (!project && matches.length === 1) return void await openComposer(matches[0]!.id, { repository: info.repo, carryUnassigned: true });
    repositoryChoice.value = { repository: info.repo, project: p?.id };
  } catch (error) { if (request === repositoryPick) showError(repoProblem(path, error), 6000); }
}

/** The explicit destination of the saved composer draft; never inferred from a list filter. */
export const target = computed(() => {
  const r = repo.value;
  const destination = projectDestination(projects.value, composerProject.value, r);
  if (!projectsLoaded.value) destination.problem = "";
  else if (!projectsStatus.value.available && !composerProject.value) destination.problem = "";
  return { ...destination, adds: !!destination.project && !!r && !destination.project.repos.includes(r), creates: !destination.project && !!r };
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
  /** An explicit scope no longer exists after its list finished loading. */
  missing?: boolean;
}
type SidePin = { kind: "run"; id: string } | { kind: "project"; project?: string; repo: string };
const sidePin = signal<SidePin | null>(store.json<SidePin | null>("sidePin", null));

const runScope = (run: RunSummary, pinned = false): SideScope => ({ key: `run:${chatTaskId(run)}`, kind: "run", run, project: projectFor(run), repo: run.repo, pinned });
function projectScope(project: Project | undefined, repo: string, pinned = false): SideScope {
  const r = repo;
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
  if (r.view === "project" || r.view === "workspace" && r.project) {
    // A project's page: its repository you're working in, else the one its latest run used.
    const p = projects.value.find((x) => x.id === (r.view === "project" ? r.id : r.project));
    if (p) {
      const chosen = r.view === "project" ? r.repository : undefined;
      const worktree = chosen && [...runs.value.values()].some(run => projectFor(run)?.id === p.id && p.repos.includes(run.repo) && run.worktrees.some(tree => tree.path === chosen));
      return projectScope(p, chosen ? p.repos.includes(chosen) || worktree ? chosen : "" : lastRepo(p));
    }
    return waitingScope(`project:${r.view === "project" ? r.id : r.project}`, false);
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
  if (popped) {
    const found = scopeFromKey(popped);
    if (found) return found;
    const scope = waitingScope(popped, true);
    return { ...scope, missing: !scope.waiting };
  }
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
  const key = taskSideKey(`run:${runId}`);
  if (poppedScope.value && poppedScope.value !== key) return handOff({ type: HANDOFF, route: { view: "run", id: runId }, drafts: [], sideChat: { run: runId, chat } });
  setSideChat(`side:${chat}`, key);
  if (sideScope.value.key !== key) setPin(followed.value.key === key ? null : { kind: "run", id: runId });
  openSide("chat");
}

/** Open links in the Browser belonging to the run that supplied them. */
export function openBrowserPage(url: string, runId?: string, previewStartedAt?: number) {
  const key = runId ? taskSideKey(`run:${runId}`) : sideScope.value.key;
  const memo = sideMemory.value[key];
  const pages = memo?.pages ?? (memo?.url ? [{ id: "p0", url: memo.url }] : []);
  const existing = pages.find(page => { try { return new URL(page.url).href === new URL(url).href; } catch { return page.url === url; } });
  const id = existing?.id ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  rememberSide({ pages: existing ? pages : [...pages, { id, url }], page: id, tab: "browser", browserRequest:{id:`${Date.now()}-${Math.random()}`,url,...(previewStartedAt === undefined ? {} : {previewStartedAt})} }, key);
  if (runId && sideScope.value.key !== key) setPin(followed.value.key === key ? null : { kind: "run", id: runId });
  openSide("browser");
}

/** Cancel only the automatic navigation belonging to the preview being stopped. History stays intact. */
export function cancelPreviewBrowserPage(url: string, startedAt: number, runId: string) {
  const scope = taskSideKey(`run:${runId}`), request = sideMemory.value[scope]?.browserRequest;
  if (!request || request.previewStartedAt !== startedAt) return;
  try { if (new URL(request.url).href !== new URL(url).href) return; } catch { return; }
  rememberSide({browserRequest:{...request,cancelled:"stopped",manualUrl:undefined}},scope);
}

/** A manual browser action takes precedence over a queued automatic preview. */
export function supersedePreviewBrowserPage(scope: string, manualUrl?: string) {
  const request = sideMemory.value[scope]?.browserRequest;
  if (request?.previewStartedAt !== undefined) rememberSide({browserRequest:{...request,cancelled:"superseded",...(manualUrl ? {manualUrl} : {})}},scope);
}

/** What the panel remembers per scope, so going back to a run brings back its panel. */
export interface SideMemory {
  browserRequest?: {id:string;url:string;previewStartedAt?:number;cancelled?:"stopped"|"superseded";manualUrl?:string};
  browserHandled?: string;
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
  /** You closed the last terminal here: none opens by itself again until you open one. */
  shellsClosed?: boolean;
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
export function taskSideKey(key: string): string {
  const run = key.startsWith("run:") ? runs.value.get(key.slice(4)) : undefined;
  return run ? `run:${chatTaskId(run)}` : key;
}
/** Fold earlier per-tab memories into the task without losing already-open side chats. */
function sideMemoryFor(key: string): SideMemory {
  const memories = Object.entries(sideMemory.value).filter(([scope]) => taskSideKey(scope) === key).map(([, memory]) => memory).sort((a, b) => a.at - b.at);
  if (!memories.length) return { at: 0 };
  const merged = Object.assign({}, ...memories) as SideMemory;
  if (memories.some(memory => memory.chats !== undefined)) merged.chats = [...new Set(memories.flatMap(memory => memory.chats ?? []))].filter(id => !merged.closed?.includes(id));
  return merged;
}
export const sideMemo = computed<SideMemory>(() => sideMemoryFor(sideScope.value.key));
export function rememberSide(patch: Omit<Partial<SideMemory>, "at">, key = sideScope.value.key) {
  key = taskSideKey(key);
  const all = { ...sideMemory.value, [key]: { ...sideMemoryFor(key), ...patch, at: Date.now() } };
  const keys = Object.keys(all);
  if (keys.length > MAX_SIDE_MEMORIES) for (const k of keys.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, keys.length - MAX_SIDE_MEMORIES)) delete all[k];
  sideMemory.value = all;
  store.set("sideMemory", JSON.stringify(all));
}
// Another window (a popped-out panel) changed the memory: take it, so neither writes over the other.
window.addEventListener("storage", (e) => {
  if (e.key === workspaceKey("sideMemory") && e.newValue) {
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
const HANDOFF = workspaceId ? `codeflow:open:${workspaceId}` : "codeflow:open";
const READY = workspaceId ? `codeflow:ready:${workspaceId}` : "codeflow:ready";
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
      if (w && !w.closed && w.location.origin === location.origin && w.location.pathname === location.pathname) return w;
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
export const acceptanceCriteria = signal<string[]>(store.json<unknown>("draftAcceptance", []) instanceof Array ? store.json<unknown[]>("draftAcceptance", []).filter((v): v is string => typeof v === "string") : []);
export function setAcceptanceCriteria(criteria: string[]) {
  acceptanceCriteria.value = criteria;
  store.set("draftAcceptance", JSON.stringify(acceptanceCriteria.value));
}
/** Where a fresh draft's workflow, team and models come from before anything is applied to it. */
const browserOrigins = (): Record<string, string> => ({ pattern: store.get("pattern") ? "Browser preference" : "Application default", roles: store.get("roleSel") ? "Browser preferences" : "Workflow defaults", models: store.get("agentSettings") ? "Browser preferences" : "CLI defaults" });
export const composerOrigins = signal<Record<string, string>>(browserOrigins());
/**
 * Values a draft keeps only when they were chosen for it: typed in Run options, picked in a
 * permissions menu, or brought back by Edit & run again. composerOrigins says where each chosen one
 * came from and is saved with the draft. A field without an origin is derived again from Settings,
 * .codeflow/config.json and the repository whenever the draft opens, so a saved draft never replays
 * an old default as if you had chosen it (docs/configuration.md).
 */
const DRAFT_CHOICES = ["check", "setup", "trust", "limits"] as const;
type DraftChoice = (typeof DRAFT_CHOICES)[number];
/** The origin of what Edit & run again restores; it applies to that retry only. */
export const RERUN_ORIGIN = "Original run";
const chosen = (field: DraftChoice) => composerOrigins.value[field] !== undefined;
export function chooseForDraft(field: DraftChoice, origin: string) {
  composerOrigins.value = { ...composerOrigins.value, [field]: origin };
}
export function forgetChoices(fields: readonly DraftChoice[] = DRAFT_CHOICES) {
  if (!fields.some(chosen)) return;
  const origins = { ...composerOrigins.value };
  for (const field of fields) delete origins[field];
  composerOrigins.value = origins;
}
export const contextPaths = signal<Map<string, ContextItem>>(new Map());
export const attachments = signal<Attachment[]>([]);
export const contextError = signal("");
/** Settings > Run defaults: the workflow new drafts start with, unless their project remembers a team. */
export const defaultPattern = signal(store.get("pattern") ?? "solo");
/** The current draft's workflow. */
export const patternId = signal(defaultPattern.value);
export const pattern = computed(() => patterns.value.find((p) => p.id === patternId.value) ?? patterns.value[0]);
/** A role is filled by an agent, or "auto": code-flow picks one whose plan has room. */
export type { RoleValue } from "./roles.js";
export const roleSel = signal<Record<string, Record<string, RoleValue[]>>>(store.json("roleSel", {}));
export const optionValues = signal<Record<string, Record<string, number | boolean>>>({});
/** Settings > Agents & models: the saved provider models and efforts every fresh draft starts from. */
export const providerDefaults = signal<AgentSettings>(store.json("agentSettings", {}));
/**
 * The current draft's provider models: the provider defaults, or what a project's remembered team,
 * a template or a restored run chose for this draft. Never saved as the provider defaults.
 */
export const agentSettings = signal<AgentSettings>(structuredClone(providerDefaults.value));
export const baseRef = signal(store.get("baseRef") ?? "");
export const branchPrefix = signal("");
export const checkCmd = signal("");
export const checkHint = signal("");
/** What detecting the check had to skip or couldn't do (an invalid package.json), shown by "Done when". */
export const checkWarning = signal("");
export const setupCmd = signal("");
export type Limits = { maxMinutes: number; maxSteps: number; maxTokens?: number; maxCostUsd?: number };
/** Run limits saved in Settings → Run defaults; null until you save some, when the repository's .codeflow/config.json and then the app's apply. */
export const limitPreference = signal(store.json<Limits | null>("limits", null));
/** The draft's limits: what it chose, else your saved ones, else the repository's, else the app's. */
function safeLimits(saved: Limits): Limits {
  const value = { ...saved };
  for (const key of ["maxMinutes", "maxSteps", "maxTokens", "maxCostUsd"] as const) if (value[key] !== undefined && numberProblem(value[key], EXECUTION_LIMITS[key])) {
    if (key === "maxMinutes" || key === "maxSteps") value[key] = DEFAULT_EXECUTION_BUDGET[key]; else delete value[key];
  }
  return { ...DEFAULT_EXECUTION_BUDGET, ...value };
}
if (limitPreference.value) limitPreference.value = safeLimits(limitPreference.value);
export const limits = signal<Limits>(safeLimits(limitPreference.value ?? DEFAULT_EXECUTION_BUDGET));
export type Trust = "safe" | "standard" | "trusted" | "full";
const trustPreference = (): Trust | null => {
  const saved = store.get("trust");
  return saved && ["safe", "standard", "trusted", "full"].includes(saved) ? saved as Trust : null;
};
export const trust = signal<Trust>(trustPreference() ?? "standard");
export function setTrust(value: Trust) {
  trust.value = value;
  store.set("trust", value);
  chooseForDraft("trust", "This run (remembered)");
}
/** Permissions and limits the draft didn't choose: your browser's, else the repository's, else the app's. */
function deriveDefaults(config: Record<string, any>) {
  if (!chosen("trust")) trust.value = trustPreference() ?? config.trust ?? "standard";
  if (chosen("limits")) return;
  const configured = config.limits ?? {};
  limits.value = limitPreference.value ? { ...limitPreference.value } : {
    ...DEFAULT_EXECUTION_BUDGET,
    // Within what the limit fields accept.
    ...(configured.maxMinutes ? { maxMinutes: Math.min(EXECUTION_LIMITS.maxMinutes.max, configured.maxMinutes) } : {}),
    ...(configured.maxSteps ? { maxSteps: Math.min(EXECUTION_LIMITS.maxSteps.max, configured.maxSteps) } : {}),
  };
}
/** Per-role model/effort overrides, per pattern: { pattern: { role: { agent: { model, effort } } } }. */
export const roleModels = signal<Record<string, Record<string, AgentSettings>>>(store.json("roleModels", {}));
export function setRoleModel(patternId: string, roleId: string, agent: AgentId, patch: { model?: string; effort?: string; variants?: { model: string; effort?: string }[] }) {
  const forPattern = roleModels.value[patternId] ?? {};
  const forRole = forPattern[roleId] ?? {};
  const next = { ...(forRole[agent] ?? {}), ...patch };
  roleModels.value = { ...roleModels.value, [patternId]: { ...forPattern, [roleId]: { ...forRole, [agent]: next } } };
  // Remember only this choice: the rest of the draft may hold a project's team or a template's models.
  const saved = store.json<Record<string, Record<string, AgentSettings>>>("roleModels", {});
  store.set("roleModels", JSON.stringify({ ...saved, [patternId]: { ...saved[patternId], [roleId]: { ...saved[patternId]?.[roleId], [agent]: next } } }));
}
/** .codeflow/config.json of the selected repo, if it has one. */
interface RepoConfiguration { config: Record<string, any>; found: boolean; error?: string; /** The start branch it was read at; "" for your checkout. */ ref?: string }
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
  managedCompatible?: boolean;
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
/** Why the last health check failed ("" while it hasn't): shown instead of an endless "Checking…". */
export const healthError = signal("");
export const healthChecking = signal(false), providersRefreshing = signal(false);
let healthFlight: Promise<void> | undefined, providerRefreshFlight: Promise<void> | undefined;
export function loadHealth(): Promise<void> {
  if (healthFlight) return healthFlight;
  if (executionPaused.value) { health.value = null; gitHealth.value = null; healthError.value = ""; return Promise.resolve(); }
  healthChecking.value = true; healthError.value = "";
  const pending = (async () => {
    const [agents, git] = await Promise.allSettled([sharedGet<Health[]>("/api/doctor"), sharedGet<GitHealth>("/api/doctor/git")]);
    health.value = agents.status === "fulfilled" ? agents.value : null;
    healthError.value = agents.status === "rejected" ? (agents.reason as Error).message || "Health is unavailable" : "";
    gitHealth.value = git.status === "fulfilled" ? git.value : null;
  })();
  healthFlight = pending.finally(() => { healthFlight = undefined; healthChecking.value = false; });
  return healthFlight;
}
/** Finish an older health read before invalidating model evidence, then share the fresh discovery. */
export function refreshProviders(): Promise<void> {
  if (providerRefreshFlight) return providerRefreshFlight;
  providersRefreshing.value = true;
  const pending = (async () => { await healthFlight; await loadAgents(true); await Promise.all([loadModels(true), loadHealth()]); })();
  providerRefreshFlight = pending.catch(error => { healthError.value = (error as Error).message; }).finally(() => { providerRefreshFlight = undefined; providersRefreshing.value = false; });
  return providerRefreshFlight;
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
  selectedTeamTemplate.value = null;
  patternId.value = id;
  defaultPattern.value = id;
  store.set("pattern", id);
  composerOrigins.value = { ...composerOrigins.value, pattern: "This run (remembered)" };
}
export function setRoles(patternId: string, roleId: string, ids: RoleValue[]) {
  roleSel.value = { ...roleSel.value, [patternId]: { ...(roleSel.value[patternId] ?? {}), [roleId]: ids } };
  // Remember only this choice: the rest of the draft may hold a project's remembered team.
  const saved = store.json<Record<string, Record<string, RoleValue[]>>>("roleSel", {});
  store.set("roleSel", JSON.stringify({ ...saved, [patternId]: { ...saved[patternId], [roleId]: ids } }));
  composerOrigins.value = { ...composerOrigins.value, roles: "This run (remembered)" };
}
/** A model choice for this draft only, such as a template's; Settings keeps the provider defaults. */
export function setAgentSetting(id: AgentId, patch: { model?: string; effort?: string }) {
  agentSettings.value = { ...agentSettings.value, [id]: { ...(agentSettings.value[id] ?? {}), ...patch } };
  composerOrigins.value = { ...composerOrigins.value, models: "This run" };
}
/** Settings > Agents & models: save one provider's default, and use it in the current draft too. */
export function setProviderDefault(id: AgentId, patch: { model?: string; effort?: string }) {
  providerDefaults.value = { ...providerDefaults.value, [id]: { ...(providerDefaults.value[id] ?? {}), ...patch } };
  store.set("agentSettings", JSON.stringify(providerDefaults.value));
  agentSettings.value = { ...agentSettings.value, [id]: { ...(agentSettings.value[id] ?? {}), ...patch } };
  composerOrigins.value = { ...composerOrigins.value, models: "Browser preferences" };
}
let checkEdit = 0;
let setupEdit = 0;
/** Override only this draft, including an intentional blank, during repository discovery. */
export function setRunCheck(value: string, origin = "This run override") {
  checkEdit++;
  checkCmd.value = value;
  chooseForDraft("check", origin);
}
export function setRunSetup(value: string, origin = "This run override") {
  setupEdit++;
  setupCmd.value = value;
  chooseForDraft("setup", origin);
}
/** Remembered for the repository: a default from then on, like one from Settings → Projects. */
export function setCheck(value: string) {
  setRunCheck(value);
  if (repo.value) { store.set(`check:${repo.value}`, value); forgetChoices(["check"]); }
}
export function setSetup(value: string) {
  setRunSetup(value);
  if (repo.value) { store.set(`setup:${repo.value}`, value); forgetChoices(["setup"]); }
}
/** Settings → Run defaults: saved for new drafts, and applied to this one (on top of its own limits, if it chose some). */
export function setLimits(patch: Partial<Limits>) {
  limitPreference.value = { ...(limitPreference.value ?? DEFAULT_EXECUTION_BUDGET), ...patch };
  store.set("limits", JSON.stringify(limitPreference.value));
  limits.value = chosen("limits") ? { ...limits.value, ...patch } : { ...limitPreference.value };
}
/** Override only this draft's limits; your saved ones stay as they are. */
export function setRunLimits(patch: Partial<Limits>, origin = "This run override") {
  limits.value = { ...limits.value, ...patch };
  chooseForDraft("limits", origin);
}

/** Who fills each role: saved choice, else the pattern default — only installed agents. */
export function rolesFor(p: PatternInfo | undefined): Record<string, RoleValue[]> {
  if (!p) return {};
  const saved = roleSel.value[p.id] ?? {};
  const options = composerRunOptions.value;
  // Antigravity can't ask for approval: after an explicit Ask for approval, defaults go to Claude or Codex.
  // A draft keeps no container of its own while it matches the project's Docker default.
  const container = options.container ?? readProjectDefaults(repo.value).container;
  const approvals = options.toolApprovals === true && trust.value !== "safe" && !options.remoteWorker && !container.enabled;
  const eligibleDefaults = agents.value.filter((a) => {
    const diagnostic = health.value?.find(entry => entry.id === a.id);
    return a.available && supportsRunPermissions(a.id) && (a.id !== "agy" || !approvals && (options.antigravityExecution === "native" || diagnostic?.managedCompatible === true)) && diagnostic?.signedIn !== false && diagnostic?.compatible !== false;
  });
  const eligibleIds = new Set(eligibleDefaults.map(agent => agent.id));
  const firstAvailable = eligibleDefaults[0]?.id;
  const roles: Record<string, RoleValue[]> = {};
  for (const role of p.roles) {
    let ids = (saved[role.id] ?? role.default).filter((id) => id === "auto" || (saved[role.id] ? available(id) : eligibleIds.has(id)));
    if (p.id === "auto-team" && role.id === "coordinator" && !saved[role.id]) ids = ["auto"];
    if (!role.multiple) ids = ids.slice(0, 1);
    if (!ids.length && !role.optional && !saved[role.id] && firstAvailable) ids = [firstAvailable];
    roles[role.id] = ids;
  }
  // Judges, reviewers and synthesizers default to a vendor that didn't do the work they check.
  return independentRoles(p.id, roles, saved, eligibleDefaults.map((a) => a.id));
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
export function loadCheck(): Promise<void> {
  checkLoading = loadRepoCheck();
  return checkLoading;
}

/** The repository and start branch the configuration was last read for (see configRef). */
let configRead = { repo: "", ref: "" };

async function loadRepoCheck() {
  const r = repo.value;
  const ref = configRef.value;
  const request = ++configRequest;
  const selection = repoSelection;
  const checkVersion = checkEdit;
  const setupVersion = setupEdit;
  const current = () => request === configRequest && selection === repoSelection && repo.value === r;
  // A value chosen for this draft, or typed during the lookup, is never replaced by a default.
  const ownCheck = () => checkVersion !== checkEdit || chosen("check");
  const ownSetup = () => setupVersion !== setupEdit || chosen("setup");
  // Read again for the same repository and branch (a new run, back to the composer): the
  // commands stay usable meanwhile and change only if the file did.
  const again = !!r && configRead.repo === r && configRead.ref === ref;
  configRead = { repo: r, ref };
  if (!again) {
    configChecking.value = !!r;
    repoConfig.value = null;
    checkWarning.value = "";
    if (!ownSetup()) setupCmd.value = r ? store.get(`setup:${r}`) ?? "" : "";
    if (!ownCheck()) {
      checkCmd.value = r ? store.get(`check:${r}`) ?? "" : "";
      checkHint.value = "";
    }
  }
  if (!r) {
    deriveDefaults({});
    return;
  }
  let result: RepoConfiguration | null = null;
  try {
    result = await api(`/api/repo-config?repo=${encodeURIComponent(r)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`);
  } catch {
    // Repository commands remain editable even when configuration cannot be read.
  }
  if (!current()) return;
  repoConfig.value = result && { ...result, ref };
  const config = repoConfig.value?.config ?? {};
  deriveDefaults(config);
  const saved = store.get(`check:${r}`), savedSetup = store.get(`setup:${r}`);
  if (!ownSetup() && (savedSetup !== null || config.setup || !again)) setupCmd.value = savedSetup ?? config.setup ?? "";
  // A detected setup (`uv sync`, `poetry install`) fills an empty setup you haven't edited.
  const detectSetup = !ownSetup() && savedSetup === null && !config.setup;
  if (saved !== null || config.check) {
    if (!ownCheck()) {
      checkCmd.value = saved ?? config.check!;
      checkHint.value = saved !== null ? "" : "From .codeflow/config.json.";
      checkWarning.value = "";
    }
    if (!detectSetup) {
      configChecking.value = false;
      return;
    }
  } else if (!ownCheck() && !again) {
    checkCmd.value = "";
  }
  try {
    const d = await api<{ command: string | null; source?: string; setup?: string; warning?: string }>(`/api/check?repo=${encodeURIComponent(r)}`);
    if (!current()) return;
    // A late result fills only fields nobody touched during the lookup: it must neither replace
    // what you typed meanwhile nor land in the input while you are typing into it.
    if (detectSetup && !ownSetup() && store.get(`setup:${r}`) === null) setupCmd.value = d.setup ?? "";
    if (ownCheck() || saved !== null || config.check || store.get(`check:${r}`) !== null) return;
    checkCmd.value = d.command ?? "";
    checkHint.value = d.command ? `Detected from ${d.source}${d.setup ? `; each worktree is set up with “${d.setup}” (Settings)` : ""}.` : "No test command found in this repo.";
    checkWarning.value = d.warning ? `Detection: ${d.warning}.` : "";
  } catch (err) {
    if (!current()) return;
    // Detection only suggests a command: say why there's none, and the field stays yours to fill.
    // As a first read would have left them: what is no longer configured isn't kept.
    if (!ownCheck() && saved === null && !config.check) {
      checkHint.value = "Couldn't detect a test command.";
      checkWarning.value = `Couldn't detect a test command: ${(err as Error).message}`;
      if (again) checkCmd.value = "";
    }
    if (again && detectSetup && !ownSetup()) setupCmd.value = "";
  } finally {
    if (current()) configChecking.value = false;
  }
}

let modelsRequest = 0;
export async function loadModels(force = false) {
  const request = ++modelsRequest;
  if (executionPaused.value) { catalogs.value = {}; return; } // refused under a filesystem restriction
  try {
    const result = await sharedGet<Record<string, CatalogOrError>>(force ? "/api/models?refresh=1" : "/api/models");
    if (request === modelsRequest) catalogs.value = result;
  } catch {
    if (request === modelsRequest) catalogs.value = {};
  }
}

// ---------------------------------------------------------------- runs
const deletedRunIds = signal(new Set<string>());
const deletedRunProjects = new Map<string, string>();
const deletingLocally = new Set<string>();
export const deletedRunNotice = signal<{ id: string; elsewhere: boolean } | null>(null);
export const replaceRouteHistory = signal(false);
export const isRunDeleted = (id: string) => deletedRunIds.value.has(id);
export function beginRunDeletion(id: string) { deletingLocally.add(id); return () => deletingLocally.delete(id); }
export function forgetRun(id: string, local = false, elsewhere = true, projectHint?: string) {
  const fresh = !deletedRunIds.value.has(id);
  const removed = runs.value.get(id);
  // The project inventory may already have lost this project before its run deletion arrives.
  const project = removed?.project || projectHint || (removed && projectFor(removed)?.id);
  if (project) deletedRunProjects.set(id, project);
  deletedRunIds.value = new Set([...deletedRunIds.value, id]);
  const next = new Map(runs.value); next.delete(id); runs.value = next;
  if (fresh && historyTotal.value !== null && (!historyRequestQuery() || removed && matchesFilter(removed))) historyTotal.value = Math.max(0, historyTotal.value - 1);
  if ((route.value.view === "run" || route.value.view === "review") && route.value.id === id) {
    if (!local && !deletingLocally.has(id)) deletedRunNotice.value = { id, elsewhere };
    batch(() => {
      replaceRouteHistory.value = true;
      if (project && (projectDraftDiscarded(project) || completeProjectInventory && !projects.value.some(item => item.id === project))) { deletedRunNotice.value = null; route.value = { view: "projects" }; }
      else route.value = { view: "composer" };
    });
  }
}
export function upsertRun(run: RunSummary) {
  if (run.deleted) { forgetRun(run.id, false, true, run.project); return; }
  if (deletedRunIds.value.has(run.id)) return;
  const next = new Map(runs.value);
  next.set(run.id, run);
  runs.value = next;
}

export const projectCounts = signal<Record<string, ProjectHistoryCounts> | null>(null);
export const projectCountsError = signal("");
let countsRequest = 0;
export async function refreshProjectCounts() {
  const request = ++countsRequest;
  try {
    const next = await api<Record<string, ProjectHistoryCounts>>("/api/projects/counts");
    if (request === countsRequest) { projectCounts.value = next; projectCountsError.value = ""; }
    return next;
  } catch (error) {
    if (request === countsRequest) { projectCounts.value = null; projectCountsError.value = (error as Error).message; }
    throw error;
  }
}
/** Mounted once by the sidebar; coalesce live updates and refresh quiet history periodically. */
export function watchProjectCounts() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => { clearTimeout(timer); timer = undefined; void refreshProjectCounts().catch(() => {}); };
  const stop = effect(() => { runs.value; projects.value; if (!timer) timer = setTimeout(refresh, 250); });
  const poll = setInterval(refresh, 15_000);
  refresh();
  return () => { stop(); clearTimeout(timer); clearInterval(poll); countsRequest++; };
}

/**
 * Where the event stream is: the server start it belongs to (its epoch), the newest event it
 * brought, and per run the event its snapshot came with. A snapshot older than the one shown
 * (a list fetched while the stream moved on) never replaces a newer one.
 */
const feed = { epoch: "", seq: 0, runSeq: new Map<string, number>() };
interface RunPage { runs: RunSummary[]; related?: RunSummary[]; total: number; nextCursor?: string }
export const historyTotal = signal<number | null>(null);
export const attentionTotal = signal<number | null>(null);
export const attentionTruncated = signal(false);
export const historyNextCursor = signal<string | null>(null);
export const historyLoading = signal(false);
export const historyLoadingMore = signal(false);
export const historyError = signal("");
let historyQuery = "";
let historyFailed: "refresh" | "older" | null = null;
const historyMatches = new Set<string>();
/** A cursor belongs to the entire filter, including the selected repository. */
export function historyRequestQuery() {
  const f = runFilter.value, query = new URLSearchParams();
  if (f.q.trim()) query.set("q", f.q.trim());
  if (f.status !== "all") query.set("status", f.status);
  if (f.pattern) query.set("pattern", f.pattern);
  if (f.agent) query.set("agent", f.agent);
  if (f.repo) query.set("repo", f.repo);
  return query.toString();
}
let historyGeneration = 0;
let historyPages = 0;
let historyRefresh = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function prepareHistoryQuery(query: string) {
  if (query === historyQuery) return;
  historyQuery = query;
  historyMatches.clear();
  historyGeneration++;
  historyPages = 0;
  historyTotal.value = null;
  historyNextCursor.value = null;
  historyLoadingMore.value = false;
  historyError.value = "";
  historyFailed = null;
}
export const connection = signal<{ state: "connecting" | "connected" | "reconnecting" | "offline"; since: number; lastReceived?: number; detail?: string }>({ state: "connecting", since: Date.now() });
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
  for (const run of list) if (!deletedRunIds.value.has(run.id)) next.set(run.id, fresher(run.id) && before.has(run.id) ? before.get(run.id)! : run);
  for (const [id, run] of before) if (!next.has(id) && fresher(id)) next.set(id, run);
  runs.value = next;
  runsLoaded.value = true;
  for (const run of next.values()) { const prior = before.get(run.id); if (prior) noticeChange(prior, run); }
}

/** Restore all tabs/side chats when opening a deep link outside the first history page. */
export async function loadAgentChats(id: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { epoch, seq } = feed;
    const family = await api<RunSummary[]>(`/api/runs/${encodeURIComponent(id)}/chats`);
    if (feed.epoch !== epoch) continue; // Initial stream connection or a server restart: use its new sequence.
    applyRunList(family, key => (feed.runSeq.get(key) ?? 0) > seq, true);
    return;
  }
  throw new Error("The connection changed while loading chats. Reopen the task to retry.");
}
export const lastAgentTabs = signal<Record<string, string>>(store.json("lastAgentTabs", {}));
/** Closing a tab only changes this browser's view; the task and its work keep running. */
const closedAgentTabs = signal<Record<string, string[]>>(store.json("closedAgentTabs", {}));
export const agentTabClosed = (run: RunSummary) => closedAgentTabs.value[chatTaskId(run)]?.includes(run.id) ?? false;
export function setAgentTabClosed(run: RunSummary, closed: boolean) {
  if (run.pattern !== "solo" || run.chatLink?.kind === "side" || agentTabClosed(run) === closed) return;
  const task = chatTaskId(run);
  const ids = new Set(closedAgentTabs.value[task]);
  if (closed) ids.add(run.id); else ids.delete(run.id);
  const next = { ...closedAgentTabs.value }; delete next[task];
  if (ids.size) next[task] = [...ids];
  closedAgentTabs.value = Object.fromEntries(Object.entries(next).slice(-200));
  store.set("closedAgentTabs", JSON.stringify(closedAgentTabs.value));
}
export function rememberAgentTab(run: RunSummary) {
  if (run.pattern !== "solo" || run.chatLink?.kind === "side") return;
  setAgentTabClosed(run, false); // Following a direct link or sidebar entry reopens the conversation.
  const task = chatTaskId(run);
  if (lastAgentTabs.value[task] === run.id) return;
  const next = { ...lastAgentTabs.value }; delete next[task]; next[task] = run.id;
  const entries = Object.entries(next).slice(-200);
  lastAgentTabs.value = Object.fromEntries(entries);
  store.set("lastAgentTabs", JSON.stringify(lastAgentTabs.value));
}

export async function refreshRuns() {
  const { epoch, seq } = feed;
  const query = historyRequestQuery();
  prepareHistoryQuery(query);
  const generation = historyGeneration;
  const request = ++historyRefresh;
  historyLoading.value = true;
  try {
    const page = await api<RunPage | RunSummary[]>(`/api/runs?limit=100${query ? `&${query}` : ""}`);
    // The server restarted while this was on its way: the stream's own list is newer.
    if (epoch && feed.epoch !== epoch || generation !== historyGeneration || query !== historyRequestQuery() || request !== historyRefresh) return;
    const list = Array.isArray(page) ? page : page.runs;
    for (const run of list) historyMatches.add(run.id);
    applyRunList([...list, ...(Array.isArray(page) ? [] : page.related ?? [])], (id) => (feed.runSeq.get(id) ?? 0) > seq, true);
    historyTotal.value = Array.isArray(page) ? page.length : page.total;
    if (historyPages <= 1 && historyFailed !== "older") historyNextCursor.value = Array.isArray(page) ? null : page.nextCursor ?? null;
    historyPages = Math.max(1, historyPages);
    if (historyFailed !== "older") { historyError.value = ""; historyFailed = null; }
  } catch (error) {
    if (generation === historyGeneration && request === historyRefresh && historyFailed !== "older") { historyError.value = (error as Error).message; historyFailed = "refresh"; }
  } finally {
    if (generation === historyGeneration && request === historyRefresh) historyLoading.value = false;
  }
}

export async function loadOlderRuns() {
  const query = historyRequestQuery();
  prepareHistoryQuery(query);
  const cursor = historyNextCursor.value;
  if (!cursor || historyLoadingMore.value || historyLoading.value) return;
  const generation = historyGeneration;
  const { epoch, seq } = feed;
  historyLoadingMore.value = true;
  historyError.value = "";
  try {
    const page = await api<RunPage>(`/api/runs?limit=100&cursor=${encodeURIComponent(cursor)}${query ? `&${query}` : ""}`);
    if (generation !== historyGeneration || query !== historyRequestQuery() || epoch && feed.epoch !== epoch) return;
    for (const run of page.runs) historyMatches.add(run.id);
    applyRunList([...page.runs, ...page.related ?? []], (id) => (feed.runSeq.get(id) ?? 0) > seq, true);
    historyNextCursor.value = page.nextCursor ?? null;
    historyTotal.value = page.total;
    historyPages++; historyFailed = null;
  } catch (error) {
    if (generation === historyGeneration) { historyError.value = (error as Error).message; historyFailed = "older"; }
  } finally { if (generation === historyGeneration) historyLoadingMore.value = false; }
}

export const retryHistory = () => historyFailed === "older" && historyNextCursor.value ? loadOlderRuns() : refreshRuns();

export const waitingCount = computed(() => projectCounts.value?.[ALL]?.attentionTasks ?? groupChatTasks([...runs.value.values()]).filter(task => task.chats.some(needsYou)).length);

// ---------------------------------------------------------------- finding runs
export interface RunFilter {
  q: string;
  /** all | attention (needs you) | running | passed | failing (check fails, failed, stopped) | flagged (tests changed) */
  status: "all" | "attention" | "running" | "passed" | "failing" | "flagged";
  pattern: string;
  agent: string;
  /** An explicit list filter, independent of the composer destination. */
  repo: string;
}
// Filters are remembered; the search text isn't.
const storedRunFilter = store.json<Partial<RunFilter> & { thisRepo?: boolean } | null>("runFilter", {});
const savedRunFilter = storedRunFilter && typeof storedRunFilter === "object" ? storedRunFilter : {};
export const runFilter = signal<RunFilter>({ status: savedRunFilter.status ?? "all", pattern: savedRunFilter.pattern ?? "", agent: savedRunFilter.agent ?? "", repo: savedRunFilter.repo ?? (savedRunFilter.thisRepo ? store.get("repo") ?? "" : ""), q: "" });
export function setRunFilter(patch: Partial<RunFilter>) {
  runFilter.value = { ...runFilter.value, ...patch };
  const { q: _q, ...kept } = runFilter.value;
  store.set("runFilter", JSON.stringify(kept));
  prepareHistoryQuery(historyRequestQuery());
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refreshRuns(), 250);
}
export const filterActive = computed(() => {
  const f = runFilter.value;
  return !!(f.q.trim() || f.status !== "all" || f.pattern || f.agent || f.repo);
});
export function matchesFilter(r: RunSummary, f = runFilter.value): boolean {
  if (!matchesHistoryFilter(r, { ...f, repo: f.repo || undefined })) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  if (r.cold && f === runFilter.value && historyQuery === historyRequestQuery() && historyMatches.has(r.id)) return true;
  const hay = [r.task, r.id, r.repo, r.pattern, r.branchPrefix, r.source ? `#${r.source.number} ${r.source.title}` : "", r.trigger?.name ?? "", r.group?.label ?? "", r.externalSource?.title ?? ""].join("\n").toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/**
 * How the sidebar lists runs: under their projects or by status, whether archived runs show,
 * and which project groups you folded. Remembered, like the filters.
 */
export interface RailView {
  group: "project" | "status";
  archived: boolean;
  collapsed: string[];
  expanded?: string[];
}
export const railView = signal<RailView>({ group: "project", archived: false, collapsed: [], ...store.json<Partial<RailView>>("railView", {}) });
export function setRailView(patch: Partial<RailView>) {
  railView.value = { ...railView.value, ...patch };
  store.set("railView", JSON.stringify(railView.value));
}

const fetchedFor = new Set<string>();

type FeedMessage =
  | { type: "hello"; epoch: string; seq: number; runs?: RunSummary[]; resumed?: boolean; nextCursor?: string; total?: number; attentionTotal?: number; attentionTruncated?: boolean; attentionNextCursor?: string }
  | { type: "error"; status: number; message: string }
  | { type: "run"; seq: number; run: RunSummary };

export function watchAllRuns(notify: (run: RunSummary) => void) {
  onFinished = notify;
  const stopState = onStreamState((status) => {
    connectionState(status.state);
    connection.value = { ...connection.value, detail: status.detail };
    if (status.lastReceived !== undefined) connection.value = { ...connection.value, lastReceived: status.lastReceived };
  });
  const stopRuns = subscribe(
    "runs",
    (data: FeedMessage) => {
      if (data?.type === "error") { historyError.value = data.message; return; }
      if (!data || (data.type !== "hello" && data.type !== "run") || !Number.isSafeInteger(data.seq) || (data.type === "hello" && typeof data.epoch !== "string") || (data.type === "run" && !data.run?.id)) return;
      if (data.type === "hello") {
        if (typeof data.attentionTotal === "number") attentionTotal.value = data.attentionTotal;
        if (typeof data.attentionTruncated === "boolean") attentionTruncated.value = data.attentionTruncated;
        // Another server start numbers its events afresh: what we kept from the last one says nothing.
        const restarted = !!feed.epoch && data.epoch !== feed.epoch;
        if (data.epoch !== feed.epoch) feed.runSeq.clear();
        feed.epoch = data.epoch;
        if (restarted) { feed.seq = data.seq; historyGeneration++; historyPages = 0; historyNextCursor.value = null; historyLoading.value = false; historyLoadingMore.value = false; }
        if (data.runs) {
          // The whole list, in step with the stream: every run in it is as new as this event.
          for (const run of data.runs) feed.runSeq.set(run.id, data.seq);
          applyRunList(data.runs, () => false, !restarted);
          if (!historyRequestQuery()) {
            if (typeof data.total === "number") historyTotal.value = data.total;
            if (historyPages <= 1) historyNextCursor.value = data.nextCursor ?? null;
            historyPages = Math.max(1, historyPages);
          } else if (restarted) void refreshRuns();
        }
        // Resumed, the snapshots it missed follow, and move it on.
        if (data.runs) feed.seq = data.seq;
        return;
      }
      const { run, seq } = data;
      if (seq <= (feed.runSeq.get(run.id) ?? 0)) return; // older than what's shown
      feed.runSeq.set(run.id, seq);
      feed.seq = Math.max(feed.seq, seq);
      const before = runs.value.get(run.id);
      upsertRun(run);
      if (run.deleted) return;
      // A project made elsewhere (an automation's first run in a repo, another tab): fetch it once.
      if (run.project && !projects.value.some((p) => p.id === run.project) && !fetchedFor.has(run.project)) {
        fetchedFor.add(run.project);
        void loadProjects();
      }
      noticeChange(before, run);
    },
    // Back after a drop: only what the stream missed, when the server still has it.
    () => (feed.epoch ? `${feed.epoch}:${feed.seq}` : undefined),
  );
  return () => { stopRuns(); stopState(); };
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

export const sourceTemplatePicker = signal<Template | null>(null);

export function applyTemplate(t: Template, pick?: SourcePick, values: Record<string, string> = {}) {
  const filled = fillTemplate({ ...t, criteria: [] }, values).task;
  externalSource.value = null;
  setPattern(t.pattern);
  const fill = (text: string) => (pick ? text.replace(/\{number\}/g, String(pick.number)).replace(/\{title\}/g, `${pick.kind} #${pick.number}`) : text);
  setTask(fill(filled));
  setAcceptanceCriteria([]);
  source.value = pick ? { ...pick, ciLogs: !!t.ciLogs } : null;
}

/** External issues choose an issue workflow, never a prior PR-review template. */
export function applyExternalIssue(value: import("../src/integrations.js").ExternalSource) {
  batch(() => {
    const template = templates.value.find(template => template.id === "fix-issue");
    if (template) applyTemplate(template);
    else { setPattern("solo"); setAcceptanceCriteria([]); source.value = null; }
    setTask("Address the selected issue. Add appropriate checks and explain the result.");
    externalSource.value = value;
  });
}

export const markSeen = (id: string) => post(`/api/runs/${id}/seen`).catch(() => {});

// ---------------------------------------------------------------- start branch and its configuration
/**
 * Where the draft's .codeflow/config.json comes from: the start branch you chose, or your checkout.
 * A run from an issue, a PR or an imported source, and a retry, use the checkout's, as the server does.
 */
export const configRef = computed(() => source.value || externalSource.value || rerunDraft.value ? "" : baseRef.value);
// Choosing another start branch brings its defaults; what the draft chose stays (loadRepoCheck).
effect(() => {
  const ref = configRef.value;
  untracked(() => { if (repo.value && repo.value === configRead.repo && ref !== configRead.ref) void loadCheck(); });
});

/** Why the draft's start branch changed by itself, until you choose one or open another draft. */
export const baseNotice = signal("");
/** "" (the current branch) or one of the repository's branches; not a commit a retry was pinned to. */
export const knownBase = (ref: string | null | undefined): ref is string => ref === "" || !!ref && !!repoInfo.value?.branches.some((branch) => branch.name === ref);
/** A saved start branch that is gone (deleted since) gives way to the current branch. A commit Edit & run again pinned stays. */
function dropMissingBase() {
  const ref = baseRef.value, info = repoInfo.value, retry = rerunDraft.value;
  if (!info || knownBase(ref) || retry?.repo === info.repo && (retry.baseRef ?? ref) === ref) return;
  baseRef.value = "";
  baseNotice.value = `Branch “${ref}” no longer exists, so this draft starts from the current branch.`;
}
/** Remember the start branch for new drafts; never a pinned commit. */
export function rememberBase() {
  if (knownBase(baseRef.value)) store.set("baseRef", baseRef.value);
}

// ---------------------------------------------------------------- project drafts
function composerSnapshot() {
  return {
    contextBudget: contextBudget.value, contextBudgetOrigin: contextBudgetOrigin.value, intent: intentDraft.value, journey: journeyDraft.value,
    version: 1 as const, repository: requestedRepository.value, task: task.value, acceptance: acceptanceCriteria.value,
    paths: [...contextPaths.value.entries()], attachments: attachments.value, pattern: patternId.value,
    roles: roleSel.value, models: roleModels.value, settings: agentSettings.value, options: optionValues.value,
    base: baseRef.value, branch: branchPrefix.value, check: checkCmd.value, setup: setupCmd.value,
    limits: limits.value, trust: trust.value, approvals: approvalChoices.value, origins: composerOrigins.value,
    selectedTemplate: selectedTeamTemplate.value,
    source: source.value, externalSource: externalSource.value, runOptions: composerRunOptions.value, rerun: rerunDraft.value,
  };
}
type ComposerSnapshot = ReturnType<typeof composerSnapshot>;
const draftStore = new ProjectDraftStore<ComposerSnapshot>(workspaceKey("project-draft-v1:"), globalThis.localStorage, snapshot => {
  if (!snapshot || snapshot.version !== 1) throw new Error("This draft uses an unsupported format");
  if (typeof snapshot.task !== "string" || !Array.isArray(snapshot.paths) || snapshot.paths.some(entry => !Array.isArray(entry) || entry.length !== 2) || !Array.isArray(snapshot.attachments) || !Array.isArray(snapshot.acceptance)) throw new Error("This draft contains unreadable fields");
});
const discardedProjectDrafts = new Set<string>();
const projectDraftDiscarded = (id: string) => !!id && (discardedProjectDrafts.has(id) || store.get(`deletedProjectDraft:${id}`) === "1");
async function readComposerDraft(id: string) {
  if (projectDraftDiscarded(id)) return undefined;
  try { return await draftStore.read(id); }
  catch (error) { unreadableDrafts.value = { ...unreadableDrafts.value, [id]: (error as Error).message }; throw error; }
}
/** Read an overview without replacing the composer's active draft. */
export async function savedDraftTask(id: string): Promise<string> {
  if (id === composerProject.value) return draftUnavailable.value ? "" : task.value;
  return (await readComposerDraft(id))?.task ?? "";
}
let composerSwitch = 0;
let composerWork: Promise<boolean> = Promise.resolve(true);
let draftWatching = false;

/** Successful project deletion also owns its draft; never carry that text into another project. */
export function discardProjectDraft(id: string): Promise<void> {
  if (!id) return Promise.resolve();
  discardedProjectDrafts.add(id);
  store.set(`deletedProjectDraft:${id}`, "1");
  store.remove(`projectRepo:${id}`);
  if (store.get("lastComposerProject") === id) store.remove("lastComposerProject");
  const removal = draftStore.remove(id);
  const work = composerWork.then(async () => {
    const unreadable = { ...unreadableDrafts.value }; delete unreadable[id]; unreadableDrafts.value = unreadable;
    if (draftsReady.value && composerProject.value === id) {
      if (!await switchComposer("", { stay: true }, composerSwitch)) {
        composerLoading.value = true;
        try { await setRepo(""); batch(() => { resetComposer(); composerProject.value = ""; store.set("composerProject", ""); }); }
        finally { composerLoading.value = false; }
      }
      store.remove("draftTask"); store.remove("draftAcceptance");
    }
    const r = route.value;
    const deletedChat = deletedRunNotice.value && deletedRunProjects.get(deletedRunNotice.value.id) === id;
    if (deletedChat) deletedRunNotice.value = null;
    if (deletedChat || r.view === "project" && r.id === id || (r.view === "composer" || r.view === "workspace") && r.project === id || (r.view === "run" || r.view === "review") && runs.value.get(r.id)?.project === id) route.value = { view: "projects" };
    try { await removal; }
    catch { throw new Error("The project was deleted, but its saved draft could not be cleared. Reload to retry."); }
    draftError.value = unsavedDraftWarning();
  });
  composerWork = work.then(() => true, () => false);
  return work;
}

window.addEventListener("storage", event => {
  const prefix = workspaceKey("deletedProjectDraft:");
  if (event.key?.startsWith(prefix) && event.newValue === "1") void discardProjectDraft(event.key.slice(prefix.length)).catch(() => { draftError.value = "The project was deleted, but its saved draft could not be cleared. Reload to retry."; });
});

function unsavedDraftWarning() {
  const names = draftStore.unsavedKeys.map(id => projects.value.find(project => project.id === id)?.name ?? (id || "Unassigned draft"));
  return names.length ? `Not saved: ${names.join(", ")}. Keep this tab open, return to the draft and retry saving.` : "";
}

/**
 * The task of a project's draft when replacing it would lose work: text, files, criteria or context
 * you added. An untouched Edit & run again draft holds nothing its run can't bring back.
 */
export async function unsentDraft(project: string): Promise<{ task: string } | null> {
  const snapshot = project === composerProject.value ? composerSnapshot() : await readComposerDraft(project).catch(() => undefined);
  if (!snapshot) return null;
  const retry = snapshot.rerun;
  const task = snapshot.task?.trim() ?? "", files = snapshot.attachments?.length || snapshot.acceptance?.length;
  // A retry can be restored from its run only while the selected context still matches too.
  // Legacy retry drafts have no baseline; retaining their context is safer than discarding it.
  const paths = (items: { path: string; type: string }[]) => JSON.stringify(items.map(item => [item.path, item.type]).sort(([a], [b]) => a!.localeCompare(b!)));
  const sameContext = retry && paths((snapshot.paths ?? []).map(([, item]) => item)) === paths(retry.contextPaths ?? []);
  if (retry && snapshot.task === retry.task && !files && sameContext) return null;
  return task || files || !retry && (snapshot.paths?.length || snapshot.source || snapshot.externalSource) ? { task } : null;
}

export async function saveComposerDraft() {
  if (!draftsReady.value || composerLoading.value || draftUnavailable.value || projectDraftDiscarded(composerProject.value)) return;
  try {
    await draftStore.write(composerProject.value, composerSnapshot());
    draftError.value = unsavedDraftWarning();
  } catch { draftError.value = "This draft is kept in this tab, but could not be saved. Keep the tab open and retry saving."; }
}

/**
 * Put a saved draft back. Its check, setup, permissions and limits come back only when they were
 * chosen for it; the others keep what was just derived from the repository and your settings.
 */
function restoreComposer(snapshot: ComposerSnapshot) {
  const origins = { ...snapshot.origins };
  // Drafts saved before choices were recorded: only an Edit & run again draft's values were chosen.
  if (snapshot.rerun && !DRAFT_CHOICES.some((field) => field in origins)) for (const field of DRAFT_CHOICES) origins[field] = RERUN_ORIGIN;
  batch(() => {
    contextBudget.value = snapshot.contextBudget; contextBudgetOrigin.value = snapshot.contextBudgetOrigin ?? "Application default";
    intentDraft.value = snapshot.intent; journeyDraft.value = snapshot.journey;
    task.value = snapshot.task; acceptanceCriteria.value = snapshot.acceptance;
    contextPaths.value = new Map(snapshot.paths); attachments.value = snapshot.attachments;
    patternId.value = snapshot.pattern; roleSel.value = snapshot.roles; roleModels.value = snapshot.models;
    agentSettings.value = snapshot.settings; optionValues.value = snapshot.options;
    baseRef.value = snapshot.base; branchPrefix.value = snapshot.branch;
    // Counted as edits, so a lookup still on its way doesn't replace them.
    if (origins.check !== undefined) { checkEdit++; checkCmd.value = snapshot.check; }
    if (origins.setup !== undefined) { setupEdit++; setupCmd.value = snapshot.setup; }
    if (origins.limits !== undefined) limits.value = snapshot.limits;
    if (origins.trust !== undefined) trust.value = snapshot.trust;
    approvalChoices.value = snapshot.approvals;
    composerOrigins.value = origins; source.value = snapshot.source; externalSource.value = snapshot.externalSource;
    selectedTeamTemplate.value = snapshot.selectedTemplate ?? null;
    composerRunOptions.value = snapshot.runOptions ?? {};
    rerunDraft.value = snapshot.rerun ?? null;
  });
}

function resetComposer(project?: Project) {
  intentDraft.value = undefined; journeyDraft.value = undefined; contextBudget.value = undefined; contextBudgetOrigin.value = "Application default";
  task.value = ""; acceptanceCriteria.value = []; attachments.value = []; contextPaths.value = new Map();
  source.value = null; externalSource.value = null; branchPrefix.value = ""; baseRef.value = "";
  roleSel.value = store.json("roleSel", {}); roleModels.value = store.json("roleModels", {});
  patternId.value = defaultPattern.value; agentSettings.value = structuredClone(providerDefaults.value);
  optionValues.value = {};
  approvalChoices.value = store.json("approvePlanByPattern", {}); selectedTeamTemplate.value = null; composerRunOptions.value = {}; rerunDraft.value = null;
  composerOrigins.value = browserOrigins();
  if (project?.defaults) applyDefaults(project.defaults);
}

/** Switch only the draft destination. Viewing a project or filtering lists never calls this. */
export function openComposer(id?: string, options: { repository?: string; carryUnassigned?: boolean; stay?: boolean } = {}): Promise<boolean> {
  const r = route.value;
  const destination = id ?? (r.view === "project" ? r.id : r.view === "workspace" && r.project ? r.project : composerProject.value);
  const remembered = store.get("lastComposerProject");
  const fallback = id === undefined && !destination && !task.value.trim() && !attachments.value.length ? projects.value.find(project => project.id === remembered)?.id ?? legacyDraftProject(projects.value, "", repo.value) ?? "" : "";
  const next = projectDraftDiscarded(destination) ? "" : destination || fallback;
  const request = ++composerSwitch;
  // Complete an in-flight restore before taking another snapshot. Only the most
  // recent queued selection runs, and older requests cannot rewrite navigation.
  const work = composerWork.then(() => request === composerSwitch ? switchComposer(next, options, request) : false);
  composerWork = work.catch(() => false);
  return work;
}

async function switchComposer(next: string, options: { repository?: string; carryUnassigned?: boolean; stay?: boolean }, request: number): Promise<boolean> {
  if (!draftsReady.value) return false;
  const project = projects.value.find(item => item.id === next);
  if (next === composerProject.value && !options.repository) {
    if (!options.stay) route.value = { view: "composer", project: next };
    return true;
  }
  const before = composerSnapshot();
  const carried = (!composerProject.value || target.value.unavailable) && options.carryUnassigned ? before : undefined;
  const saving = saveComposerDraft();
  composerLoading.value = true;
  await saving;
  try {
    const stored = await readComposerDraft(next);
    if (stored && stored.version !== 1) throw new Error("This draft uses an unsupported format. It has been retained.");
    const saved = stored ?? carried;
    const repository = options.repository ?? (saved?.repository || (project ? lastRepo(project) : ""));
    // Retry metadata belongs to the saved project draft, even when two projects share a repository.
    rerunDraft.value = null;
    baseNotice.value = "";
    await setRepo(repository);
    if (projectDraftDiscarded(next)) return false;
    const detectedCheck = checkCmd.value, detectedSetup = setupCmd.value, detectedTrust = trust.value;
    batch(() => {
      if (saved) restoreComposer(saved);
      else {
        resetComposer(project);
      }
      if (saved && repository !== saved.repository) {
        contextPaths.value = new Map(); source.value = null; externalSource.value = null; baseRef.value = ""; journeyDraft.value = undefined;
        checkCmd.value = detectedCheck; setupCmd.value = detectedSetup; trust.value = detectedTrust; selectedTeamTemplate.value = null; composerRunOptions.value = {}; rerunDraft.value = null;
        forgetChoices(["check", "setup", "trust"]);
      }
      dropMissingBase();
      composerProject.value = next;
      store.set("composerProject", next);
      if (project) store.set("lastComposerProject", next);
    });
    if (project && project.repos.includes(repository)) store.set(`projectRepo:${next}`, repository);
    if (!options.stay && request === composerSwitch) route.value = { view: "composer", project: next };
    return true;
  } catch (error) {
    draftError.value = `Could not open the draft: ${(error as Error).message}`;
    if (request === composerSwitch) route.value = { view: "composer", project: composerProject.value };
    return false;
  } finally { composerLoading.value = false; }
}

export function chooseComposerRepository(repository: string): Promise<boolean> {
  if (repository === repo.value && !composerLoading.value) return Promise.resolve(true);
  if (projectsStatus.value.available && !projects.value.find(item => item.id === composerProject.value)?.repos.includes(repository)) return Promise.resolve(false);
  return openComposer(composerProject.value, { repository, stay: true });
}

export async function initializeProjectDrafts() {
  if (draftWatching) return;
  composerLoading.value = true;
  try {
    let id = store.get("composerProject") ?? "";
    if (store.get("projectDraftVersion") !== "1") {
      const legacy = composerSnapshot();
      legacy.repository = repoInfo.value?.repo ?? requestedRepository.value;
      id = legacyDraftProject(projects.value, store.get("project") ?? "", legacy.repository);
      await draftStore.write("legacy-backup", legacy);
      await draftStore.write(id, legacy);
      store.set("composerProject", id);
      store.set("projectDraftVersion", "1");
    }
    // A healthy inventory confirms an older saved destination was deleted. Storage recovery
    // or a failed request is not evidence of deletion, so those drafts remain protected.
    if (id && (projectDraftDiscarded(id) || completeProjectInventory && !projects.value.some(project => project.id === id))) {
      discardedProjectDrafts.add(id); store.set(`deletedProjectDraft:${id}`, "1");
      await draftStore.remove(id); store.remove(`projectRepo:${id}`);
      const r = route.value;
      if (r.view === "project" && r.id === id || r.view === "composer" && r.project === id) route.value = { view: "projects" };
      id = ""; store.set("composerProject", "");
      store.remove("repo"); store.remove("draftTask"); store.remove("draftAcceptance");
      await setRepo("", false);
      batch(() => resetComposer());
    }
    const saved = await readComposerDraft(id);
    if (saved && saved.version !== 1) throw new Error("Saved draft format is unavailable.");
    composerProject.value = id;
    const repository = saved?.repository ?? store.get("repo") ?? "";
    if ((repoInfo.value?.repo ?? "") !== repository) await setRepo(repository, false);
    if (saved) restoreComposer(saved);
    if (projects.value.some(project => project.id === id)) store.set("lastComposerProject", id);
    dropMissingBase();
    draftsReady.value = true;
    draftWatching = true;
    const r = route.value;
    // Explicit project routes already restore through openComposer's serialized queue.
    // A second restore here can overwrite typing or options after the first one appears.
    if (!id && r.view === "composer" && r.project === undefined && !task.value.trim() && !attachments.value.length && completeProjectInventory) {
      const preferred = projects.value.find(project => project.id === store.get("lastComposerProject"))?.id
        || legacyDraftProject(projects.value, "", repository)
        || (projects.value.length === 1 ? projects.value[0]!.id : "");
      if (preferred) await switchComposer(preferred, { stay: true }, composerSwitch);
    }
  } catch (error) {
    draftError.value = `Could not restore this draft: ${(error as Error).message}`;
    // One unreadable key must not disable healthy project drafts. Its bytes stay protected.
    draftsReady.value = true; draftWatching = true;
  } finally { composerLoading.value = false; }
  if (!draftWatching) return;
  effect(() => {
    if (composerLoading.value || draftUnavailable.value || projectDraftDiscarded(composerProject.value)) return;
    const snapshot = composerSnapshot(), id = composerProject.value;
    // Start persistence in the input turn: a debounce can lose an attachment or edit
    // when the next action reloads or leaves the page.
    void draftStore.write(id, snapshot).then(() => { draftError.value = unsavedDraftWarning(); }, () => { draftError.value = unsavedDraftWarning(); });
  });
  window.addEventListener("pagehide", () => { void saveComposerDraft(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) void saveComposerDraft(); });
}
