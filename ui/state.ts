import { computed, signal } from "@preact/signals";
import { api, post, store } from "./lib.js";
import type {
  AgentId,
  AgentInfo,
  AgentSettings,
  Attachment,
  CatalogOrError,
  ContextItem,
  PatternInfo,
  RepoInfo,
  RunSummary,
} from "./types.js";

// ---------------------------------------------------------------- app-wide
export const agents = signal<AgentInfo[]>([]);
export const patterns = signal<PatternInfo[]>([]);
export const catalogs = signal<Record<string, CatalogOrError>>({});
export const runs = signal<Map<string, RunSummary>>(new Map());

export type Route = { view: "composer" } | { view: "automations" } | { view: "run"; id: string } | { view: "review"; id: string; branch: string };
export const route = signal<Route>({ view: "composer" });
export const railOpen = signal(false);
export const pickerOpen = signal(false);
export const filesOpen = signal(store.get("filesOpen") ? store.get("filesOpen") === "1" : window.innerWidth > 1180);

export const available = (id: AgentId) => agents.value.find((a) => a.id === id)?.available ?? false;

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
    repoError.value = path ? `${path.split("/").pop()} isn't a git repository` : "";
  } finally {
    repoChecking.value = false;
  }
  if (repo.value !== previous) {
    contextPaths.value = new Map(); // paths are relative to the repo they came from
    void loadCheck();
  }
}
export const recentRepos = () => store.json<string[]>("recentRepos", []);

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
export type Trust = "safe" | "standard" | "trusted";
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
}
export const health = signal<Health[] | null>(null);
export const healthOpen = signal(false);
export async function loadHealth() {
  try {
    health.value = await api<Health[]>("/api/doctor");
  } catch {
    health.value = null;
  }
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
  if (saved !== null) {
    checkCmd.value = saved;
    checkHint.value = "";
    return;
  }
  if (config.check) {
    checkCmd.value = config.check;
    checkHint.value = "From .codeflow/config.json.";
    return;
  }
  checkCmd.value = "";
  try {
    const d = await api<{ command: string | null; source?: string }>(`/api/check?repo=${encodeURIComponent(r)}`);
    checkCmd.value = d.command ?? "";
    checkHint.value = d.command ? `Detected from ${d.source}.` : "No test command found in this repo.";
  } catch {
    checkHint.value = "";
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
/** A finished run whose result fails its check is a warning, not a success. */
export const runState = (r: { status: string; verdict?: string }) => (r.status === "done" && r.verdict === "failing" ? "failing" : r.status);

export function upsertRun(run: RunSummary) {
  const next = new Map(runs.value);
  next.set(run.id, run);
  runs.value = next;
}

export async function refreshRuns() {
  try {
    const list = await api<RunSummary[]>("/api/runs");
    runs.value = new Map(list.map((r) => [r.id, r]));
  } catch {
    // keep what we have; the event stream will catch up
  }
}

export const waitingCount = computed(() => [...runs.value.values()].filter(needsYou).length);

export function watchAllRuns(onFinished: (run: RunSummary) => void) {
  const source = new EventSource("/api/events");
  source.onmessage = (msg) => {
    const { run } = JSON.parse(msg.data) as { run: RunSummary };
    const before = runs.value.get(run.id);
    upsertRun(run);
    if (before?.status === "running" && run.status !== "running") onFinished(run);
    else if (run.awaiting && !before?.awaiting) onFinished(run); // paused for your decision
    else if (watchNeedingYou(run) && !watchNeedingYou(before)) onFinished(run); // a PR watch handed back to you
  };
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
}
export interface SourcePick {
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  ciLogs?: boolean;
}
export const templates = signal<Template[]>([]);
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
