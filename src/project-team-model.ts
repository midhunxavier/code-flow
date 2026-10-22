import { sensitiveContextPath } from "./context-inspection.js";
import { redactText } from "./privacy.js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AgentId, AgentSettings } from "./adapters/types.js";
import type { Trust } from "./repo-config.js";
import { validateAgentSettings } from "./adapters/index.js";
import { validateSchedule, type Schedule } from "./automation.js";
import { validateVerificationProfile, type VerificationProfile } from "./verification.js";
import { providerEligibility } from "./provider-eligibility.js";

export const projectTeamsEnabled = () => process.env.CODEFLOW_PROJECT_TEAMS_ENABLED === "true";
export const WEEK = 7 * 24 * 60 * 60_000;
export const PT_LIMITS = { bytes: 16 * 1024 * 1024, cycles: 100, opportunities: 200, decisions: 2000, operations: 2000, open: 12, pending: 2 };
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export function closed(v: unknown, keys: string[], label: string): Record<string, any> {
  if (!object(v) || Object.keys(v).some((key) => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
  return v;
}
export function text(v: unknown, max: number, label: string): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0")) throw new Error(`Invalid ${label}`);
  return v.trim();
}
function integer(v: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) throw new Error(`Invalid ${label}: use ${min}–${max}`);
  return Number(v);
}
function strings(v: unknown, max: number, label: string): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${label}`);
  return [...new Set(v.map((s) => text(s, 1000, label)))];
}
export const safePath = (p: string) => p === "*" || p.length <= 500 && !p.startsWith("-") && !p.includes("\\") && !p.includes(":") && !/[\x00-\x1f]/.test(p) && !p.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part.includes("*"));
export const containsPath = (scope: string, path: string) => scope === "*" || path === scope || path.startsWith(`${scope}/`);
export const CATEGORIES = ["bug", "usability", "performance", "tests", "docs", "experiment"] as const;
export type Category = typeof CATEGORIES[number];
export function missionSchedule(value: unknown): Schedule {
  const schedule = validateSchedule(value);
  if (!schedule) throw new Error("Choose a schedule");
  if ("at" in schedule && !schedule.timezone) throw new Error("Choose an explicit schedule time zone");
  return schedule;
}
/** Operational timing does not change the authority or validity of an implementation. */
export function missionPolicy(mission: ProjectTeamMission) {
  const { schedule: _schedule, ...policy } = mission;
  return policy;
}
export interface AgentTeamConfiguration {
  coordinator: AgentId; pool: AgentId[]; agentSettings: AgentSettings;
  roleSettings?: Record<string, AgentSettings>;
}
export interface AgentTeamSnapshot { id: string; revision: number; name: string; configuration: AgentTeamConfiguration }
export function teamConfiguration(value: AgentTeamConfiguration): AgentTeamConfiguration {
  return { coordinator: value.coordinator, pool: value.pool, agentSettings: value.agentSettings, ...(value.roleSettings && Object.keys(value.roleSettings).length ? { roleSettings: value.roleSettings } : {}) };
}
export function validateTeamConfiguration(value: unknown): AgentTeamConfiguration {
  const r = closed(value, ["coordinator", "pool", "agentSettings", "roleSettings"], "agent team configuration");
  const coordinator = text(r.coordinator, 100, "coordinator") as AgentId, pool = strings(r.pool, 8, "provider pool") as AgentId[];
  if (!pool.length) throw new Error("Select a worker and reviewer provider pool");
  for (const id of [coordinator, ...pool]) { const reason = providerEligibility(id, { trust: "standard", unattended: true, projectTeam: true }); if (reason) throw new Error(reason); }
  const roleSettings: Record<string, AgentSettings> = {};
  for (const [role, settings] of Object.entries(closed(r.roleSettings ?? {}, ["coordinator", "pool"], "team role settings"))) {
    const valid = validateAgentSettings(settings);
    if (Object.keys(valid).some((id) => !(role === "coordinator" ? [coordinator] : pool).includes(id as AgentId))) throw new Error("Role settings must use the selected providers");
    if (Object.keys(valid).length) roleSettings[role] = valid;
  }
  return { coordinator, pool, agentSettings: validateAgentSettings(r.agentSettings ?? {}), ...(Object.keys(roleSettings).length ? { roleSettings } : {}) };
}
export function validateTeamSnapshot(value: unknown): AgentTeamSnapshot {
  const r = closed(value, ["id", "revision", "name", "configuration"], "agent team snapshot");
  if (!/^at-[a-f0-9]{24}$/.test(r.id) || !Number.isSafeInteger(r.revision) || r.revision < 1) throw new Error("Invalid agent team version");
  return { id: r.id, revision: r.revision, name: text(r.name, 80, "team name"), configuration: validateTeamConfiguration(r.configuration) };
}
export interface ProjectTeamMission extends AgentTeamConfiguration {
  mission: string; users: string; priorities: string[]; exclusions: string[]; baseBranch: string;
  mode: "propose" | "build-within-scope"; categories: Category[]; paths: string[]; excludedPaths: string[];
  trust: Exclude<Trust, "full">;
  check: string; setup: string; verification?: VerificationProfile;
  schedule: Schedule; maxFiles: number; maxLines: number; rescanDays: number;
  budget: { discoveryCalls: number; discoveryMinutes: number; buildCalls: number; buildMinutes: number; weeklyCalls: number; weeklyMinutes: number };
}
export function validateMission(value: unknown): ProjectTeamMission {
  const r = closed(value, ["mission", "users", "priorities", "exclusions", "baseBranch", "mode", "categories", "paths", "excludedPaths", "coordinator", "pool", "agentSettings", "roleSettings", "trust", "check", "setup", "verification", "schedule", "maxFiles", "maxLines", "rescanDays", "budget"], "project mission");
  const paths = strings(r.paths ?? ["*"], 32, "included paths"), excludedPaths = strings(r.excludedPaths ?? [".codeflow", ".github/workflows"], 32, "excluded paths");
  if (!paths.length || [...paths, ...excludedPaths].some((p) => !safePath(p))) throw new Error("Choose safe repository-relative paths");
  const coordinator = text(r.coordinator, 100, "coordinator") as AgentId, pool = strings(r.pool, 8, "provider pool") as AgentId[];
  if (!pool.length) throw new Error("Select a worker and reviewer provider pool");
  const trust = r.trust ?? "standard";
  if (!["safe", "standard", "trusted"].includes(trust)) throw new Error("Project teams cannot use Full access");
  for (const id of [coordinator, ...pool]) { const reason = providerEligibility(id, { trust, unattended: true, projectTeam: true }); if (reason) throw new Error(reason); }
  const mode = r.mode ?? "build-within-scope";
  if (!["propose", "build-within-scope"].includes(mode)) throw new Error("Choose proposals only or build within scope");
  const categories = strings(r.categories ?? ["bug", "usability", "performance", "tests", "docs"], 6, "categories") as Category[];
  if (!categories.length || categories.some((c) => !CATEGORIES.includes(c))) throw new Error("Choose supported improvement categories");
  const branch = text(r.baseBranch, 200, "base branch");
  if (branch === "HEAD" || branch.startsWith("-") || /[\s~^:?*\[\\]/.test(branch) || branch.includes("..") || branch.includes("@{")) throw new Error("Choose an explicit named base branch");
  const schedule = missionSchedule(r.schedule);
  const check = typeof r.check === "string" ? r.check.trim() : "", setup = typeof r.setup === "string" ? r.setup.trim() : "";
  if (check.length > 4000 || setup.length > 4000 || `${check}${setup}`.includes("\0")) throw new Error("Invalid verification commands");
  const verification = r.verification ? validateVerificationProfile(r.verification) : check ? validateVerificationProfile({ name: "Project team checks", checks: [{ id: "primary", kind: "custom", command: check, required: true }] }) : undefined;
  if (mode === "build-within-scope" && !verification?.checks.some((c) => c.required)) throw new Error("Automatic implementation requires a required verification check");
  const b = closed(r.budget ?? {}, ["discoveryCalls", "discoveryMinutes", "buildCalls", "buildMinutes", "weeklyCalls", "weeklyMinutes"], "budget");
  const budget = { discoveryCalls: integer(b.discoveryCalls ?? 8, 8, 40, "discovery calls"), discoveryMinutes: integer(b.discoveryMinutes ?? 15, 1, 60, "discovery minutes"), buildCalls: integer(b.buildCalls ?? 16, 4, 80, "build calls"), buildMinutes: integer(b.buildMinutes ?? 45, 1, 120, "build minutes"), weeklyCalls: integer(b.weeklyCalls ?? 48, 4, 500, "weekly calls"), weeklyMinutes: integer(b.weeklyMinutes ?? 120, 1, 1440, "weekly minutes") };
  return { mission: text(r.mission, 6000, "mission"), users: text(r.users, 2000, "intended users"), priorities: strings(r.priorities ?? [], 12, "priorities"), exclusions: strings(r.exclusions ?? [], 24, "exclusions"), baseBranch: branch, mode, categories, paths, excludedPaths, ...validateTeamConfiguration({ coordinator, pool, agentSettings: r.agentSettings, roleSettings: r.roleSettings }), trust, check, setup, verification, schedule, maxFiles: integer(r.maxFiles ?? 8, 1, 100, "changed files"), maxLines: integer(r.maxLines ?? 400, 1, 10000, "changed lines"), rescanDays: integer(r.rescanDays ?? 28, 1, 90, "rescan days"), budget };
}
export interface OpportunityCandidate {
  key: string; title: string; category: Category; problem: string; users: string; proposal: string; benefit: string;
  evidence: { path: string; quote: string }[]; paths: string[]; acceptance: string[];
  kind: "observed" | "hypothesis"; risk: "low" | "medium" | "high"; alignment: number; impact: number; confidence: number; effort: number; rationale: string;
}
export interface DiscoveryReport { version: 1; candidates: OpportunityCandidate[]; summary: string }
const stringSchema = { type: "string" };
const stringsSchema = { type: "array", items: stringSchema };
const obj = <T extends Record<string, object>>(properties: T) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
export const DISCOVERY_REPORT_SCHEMA = obj({ version: { type: "integer", enum: [1] }, summary: stringSchema, candidates: { type: "array", items: obj({ key: stringSchema, title: stringSchema, category: { type: "string", enum: [...CATEGORIES] }, problem: stringSchema, users: stringSchema, proposal: stringSchema, benefit: stringSchema, evidence: { type: "array", items: obj({ path: stringSchema, quote: stringSchema }) }, paths: stringsSchema, acceptance: stringsSchema, kind: { type: "string", enum: ["observed", "hypothesis"] }, risk: { type: "string", enum: ["low", "medium", "high"] }, alignment: { type: "integer" }, impact: { type: "integer" }, confidence: { type: "integer" }, effort: { type: "integer" }, rationale: stringSchema }) } });
export function validateReport(value: unknown): DiscoveryReport {
  if (redactText(JSON.stringify(value)) !== JSON.stringify(value)) throw new Error("Discovery report contains sensitive text; return evidence without credentials");
  const r = closed(value, ["version", "summary", "candidates"], "discovery report");
  if (r.version !== 1 || !Array.isArray(r.candidates) || r.candidates.length > 3) throw new Error("A discovery report contains at most three opportunities");
  const candidates = r.candidates.map((value: unknown) => validateCandidate(value));
  if (new Set(candidates.map((c: OpportunityCandidate) => c.key)).size !== candidates.length) throw new Error("Duplicate problem keys in discovery report");
  return { version: 1, candidates, summary: text(r.summary, 4000, "discovery summary") };
}
function validateCandidate(value: unknown, ownerAssigned = false): OpportunityCandidate {
  const c = closed(value, Object.keys(DISCOVERY_REPORT_SCHEMA.properties.candidates.items.properties), "opportunity");
  if (!CATEGORIES.includes(c.category) || !["observed", "hypothesis"].includes(c.kind) || !["low", "medium", "high"].includes(c.risk)) throw new Error("Invalid opportunity category or evidence classification");
  if (!Array.isArray(c.evidence) || (!ownerAssigned && !c.evidence.length) || c.evidence.length > 8) throw new Error("Provide one to eight code evidence references");
  const evidence = c.evidence.map((v: unknown) => { const e = closed(v, ["path", "quote"], "evidence"); const path = text(e.path, 500, "evidence path"); if (!safePath(path) || path === "*" || sensitiveContextPath(path)) throw new Error("Invalid evidence path"); return { path, quote: text(e.quote, 2000, "evidence quote") }; });
  const paths = strings(c.paths, ownerAssigned ? 32 : 16, "opportunity paths"), acceptance = strings(c.acceptance, 12, "acceptance criteria");
  if (!paths.length || paths.some((p) => !safePath(p)) || !acceptance.length) throw new Error("Opportunities need paths and acceptance criteria");
  return { key: text(c.key, 150, "problem key").toLowerCase(), title: text(c.title, 180, "title"), category: c.category, problem: text(c.problem, 3000, "problem"), users: text(c.users, 1000, "users"), proposal: text(c.proposal, 3000, "proposal"), benefit: text(c.benefit, 1500, "benefit"), evidence, paths, acceptance, kind: c.kind, risk: c.risk, alignment: integer(c.alignment, 0, 3, "alignment"), impact: integer(c.impact, 0, 3, "impact"), confidence: integer(c.confidence, 0, 3, "confidence"), effort: integer(c.effort, 1, 3, "effort"), rationale: text(c.rationale, 1500, "rationale") };
}
export interface ProjectTeamRun {
  teamId: string; cycleId: string; missionRevision: number; phase: "discovery" | "implementation"; claimId: string; attempt: number;
  opportunityId?: string; opportunityRevision?: number; scope: Pick<ProjectTeamMission, "paths" | "excludedPaths" | "maxFiles" | "maxLines">;
  verificationHash: string; inputHash: string; sourceDigest: string;
  definition?: AgentTeamSnapshot;
}
export interface DiscoveryReceipt { report: DiscoveryReport; digest: string; head: string; reviewerStep: string; approved: boolean; sourceDigest: string }
export type OpportunityStatus = "proposed" | "selected" | "implementing" | "ready" | "accepted" | "shipped" | "deferred" | "rejected" | "blocked" | "expired";
export interface ProjectOpportunity extends OpportunityCandidate { id: string; revision: number; cycleId: string; baseCommit: string; status: OpportunityStatus; createdAt: number; evidenceVerified: boolean; origin?: "owner"; reason?: string; deferUntil?: number; result?: { runId: string; branch: string; head: string; reportHash: string }; }
export type CycleStatus = "requested" | "discovering" | "selecting" | "building" | "completed" | "no-op" | "skipped" | "blocked" | "failed" | "cancelled" | "unknown";
export interface ProjectTeamUsageReceipt { version: 1; calls: number; durationMs: number; endedAt: number; recordedAt: number; digest: string }
export interface ProjectTeamLaunch { claimId: string; phase: ProjectTeamRun["phase"]; attempt: number; inputHash: string; calls: number; minutes: number; at: number; state: "claimed" | "running" | "settled" | "unknown"; runId?: string; usedCalls?: number; usage?: ProjectTeamUsageReceipt; }
export interface ProjectTeamCycle { id: string; operationId: string; missionRevision: number; mission: ProjectTeamMission; definition?: AgentTeamSnapshot; baseCommit: string; sourceDigest: string; fingerprint: string; at: number; endedAt?: number; status: CycleStatus; reason?: string; summary?: string; launches: ProjectTeamLaunch[]; opportunityId?: string; selection?: { policy: 1; selected?: string; reasons: { id: string; reason: string }[] }; report?: DiscoveryReceipt; context: string; }
export interface ProjectTeamDecision { id: string; opportunityId: string; revision: number; action: string; note: string; at: number; actor: "owner"; head?: string }
export interface ProjectTeam {
  version: 1; id: string; revision: number; projectId: string; repo: string; name: string; status: "draft" | "active" | "paused" | "archived"; triggerId?: string;
  repositoryId?: string;
  definition?: AgentTeamSnapshot;
  /** Legacy missions retain their original schedule in their immutable history. */
  schedule?: Schedule; scheduleEnabled?: boolean;
  missionRevision: number; mission: ProjectTeamMission; missions: { revision: number; value: ProjectTeamMission }[];
  createdAt: number; updatedAt: number; cycles: ProjectTeamCycle[]; opportunities: ProjectOpportunity[]; decisions: ProjectTeamDecision[];
  operations: { id: string; hash: string; at: number }[]; error?: string;
}
export const ACTIVE_CYCLES: CycleStatus[] = ["requested", "discovering", "selecting", "building", "unknown"];
export { allowance } from "./project-team-budget.js";
export function pathPermitted(scope: ProjectTeamRun["scope"], path: string) { return safePath(path) && !sensitiveContextPath(path) && scope.paths.some((p) => containsPath(p, path)) && !scope.excludedPaths.some((p) => containsPath(p, path)); }
export function candidateProblem(c: ProjectOpportunity, mission: ProjectTeamMission): string | undefined {
  if (c.origin !== "owner" && !c.evidenceVerified) return "Evidence could not be verified at the pinned commit";
  if (!mission.categories.includes(c.category)) return "Outside allowed categories";
  if (c.risk !== "low" || c.confidence < 2 || c.alignment < 2) return "Needs an owner decision about risk, evidence or mission alignment";
  if (c.kind === "hypothesis" && c.category !== "experiment") return "Product benefit needs evidence before automatic implementation";
  if (c.paths.some((p) => !pathPermitted(mission, p))) return "Outside allowed paths";
  if (!mission.verification?.checks.some((c) => c.required)) return "Configure a required verification check";
}
export const score = (c: OpportunityCandidate) => c.alignment * 4 + c.impact * 3 + c.confidence * 2 - c.effort * 2;
export function validateTeamDocument(v: unknown): ProjectTeam {
  if (!object(v) || v.version !== 1 || !/^pt-[a-f0-9]{24}$/.test(v.id) || !isAbsolute(v.repo) || !Number.isSafeInteger(v.revision) || v.revision < 1 || !["draft", "active", "paused", "archived"].includes(v.status)) throw new Error("Invalid standing team document");
  validateMission(v.mission);
  for (const key of ["missions", "cycles", "opportunities", "decisions", "operations"]) if (!Array.isArray(v[key])) throw new Error(`Invalid team ${key}`);
  if (v.cycles.length > PT_LIMITS.cycles || v.opportunities.length > PT_LIMITS.opportunities || v.decisions.length > PT_LIMITS.decisions || v.operations.length > PT_LIMITS.operations) throw new Error("Standing team history is full; archive this team and retain its decisions before creating another");
  const validTime = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const commit = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
  const unique = (items: any[], field: string) => new Set(items.map((item) => item[field])).size === items.length;
  if (v.repositoryId !== undefined && !validHash(v.repositoryId)) throw new Error("Invalid repository identity");
  if (v.schedule !== undefined) missionSchedule(v.schedule);
  if (v.scheduleEnabled !== undefined && typeof v.scheduleEnabled !== "boolean") throw new Error("Invalid scheduling setting");
  if (v.definition && digest(validateTeamSnapshot(v.definition).configuration) !== digest(teamConfiguration(v.mission))) throw new Error("Assignment differs from its pinned team configuration");
  if (typeof v.projectId !== "string" || !v.projectId || typeof v.name !== "string" || !v.name || !validTime(v.createdAt) || !validTime(v.updatedAt) || !Number.isSafeInteger(v.missionRevision) || v.missionRevision < 1 || !unique(v.missions, "revision") || !unique(v.cycles, "id") || !unique(v.opportunities, "id") || !unique(v.operations, "id")) throw new Error("Invalid standing team identity or history");
  for (const m of v.missions) { if (!object(m) || !Number.isSafeInteger(m.revision) || m.revision < 1) throw new Error("Invalid mission revision"); validateMission(m.value); }
  if (!v.missions.some((m: any) => m.revision === v.missionRevision && digest(m.value) === digest(v.mission))) throw new Error("Current mission differs from its revision history");
  for (const c of v.cycles) {
    if (!object(c) || !/^pc-[a-f0-9]{24}$/.test(c.id) || !commit(c.baseCommit) || !validHash(c.sourceDigest) || !validHash(c.fingerprint) || !validTime(c.at) || c.endedAt !== undefined && !validTime(c.endedAt) || typeof c.context !== "string" || c.context.length > 200_000 || !Array.isArray(c.launches) || c.launches.length > 2 || !unique(c.launches, "claimId") || !unique(c.launches, "phase") || ![...ACTIVE_CYCLES, "completed", "no-op", "skipped", "blocked", "failed", "cancelled"].includes(c.status)) throw new Error("Invalid cycle accounting");
    if (!v.missions.some((m: any) => m.revision === c.missionRevision && digest(m.value) === digest(c.mission))) throw new Error("Cycle mission is not an immutable saved revision");
    if (c.definition && digest(validateTeamSnapshot(c.definition).configuration) !== digest(teamConfiguration(c.mission))) throw new Error("Cycle differs from its pinned team configuration");
    for (const l of c.launches) if (!object(l) || !/^claim-[a-f0-9]{24}$/.test(l.claimId) || !["discovery", "implementation"].includes(l.phase) || !Number.isSafeInteger(l.attempt) || l.attempt < 1 || l.attempt > 2 || !validHash(l.inputHash) || !Number.isSafeInteger(l.calls) || l.calls < 4 || l.calls > 80 || !Number.isSafeInteger(l.minutes) || l.minutes < 1 || l.minutes > 120 || !validTime(l.at) || !["claimed", "running", "settled", "unknown"].includes(l.state) || l.usedCalls !== undefined && (!Number.isSafeInteger(l.usedCalls) || l.usedCalls < 0 || l.usedCalls > l.calls) || l.runId !== undefined && (typeof l.runId !== "string" || !/^[\w.-]{1,120}$/.test(l.runId)) || ["running", "settled"].includes(l.state) && !l.runId) throw new Error("Invalid launch reservation or usage");
    for (const l of c.launches) if (l.usage) {
      const u = closed(l.usage, ["version", "calls", "durationMs", "endedAt", "recordedAt", "digest"], "usage receipt");
      if (u.version !== 1 || !l.runId || !Number.isSafeInteger(u.calls) || u.calls < 0 || u.calls > l.calls || !validTime(u.durationMs) || u.durationMs > l.minutes * 60_000 || !validTime(u.endedAt) || u.endedAt < l.at || !validTime(u.recordedAt) || !validHash(u.digest)) throw new Error("Invalid terminal usage receipt");
    }
    if (c.report) { validateReport(c.report.report); if (digest(c.report.report) !== c.report.digest || !commit(c.report.head)) throw new Error("Invalid report receipt"); }
  }
  for (const o of v.opportunities) {
    if (!object(o) || !/^po-[a-f0-9]{24}$/.test(o.id) || !Number.isSafeInteger(o.revision) || o.revision < 1 || !commit(o.baseCommit) || !validTime(o.createdAt) || typeof o.evidenceVerified !== "boolean" || !v.cycles.some((c: any) => c.id === o.cycleId) || !["proposed", "selected", "implementing", "ready", "accepted", "shipped", "deferred", "rejected", "blocked", "expired"].includes(o.status)) throw new Error("Invalid opportunity history");
    if (o.origin !== undefined && o.origin !== "owner") throw new Error("Invalid task origin");
    const candidate = Object.fromEntries(Object.keys(DISCOVERY_REPORT_SCHEMA.properties.candidates.items.properties).map((k) => [k, o[k]]));
    if (o.origin === "owner") validateCandidate(candidate, true);
    else validateReport({ version: 1, summary: "stored", candidates: [candidate] });
    if (o.result && (!commit(o.result.head) || !validHash(o.result.reportHash) || typeof o.result.runId !== "string" || typeof o.result.branch !== "string")) throw new Error("Invalid result identity");
    if (["ready", "accepted", "shipped"].includes(o.status) && !o.result) throw new Error("Result evidence is missing");
    if (o.status === "deferred" && !validTime(o.deferUntil)) throw new Error("Invalid defer date");
  }
  for (const d of v.decisions) if (!object(d) || typeof d.id !== "string" || typeof d.note !== "string" || d.note.length > 4000 || d.actor !== "owner" || !["approve", "reject", "defer", "build", "revise"].includes(d.action) || !Number.isSafeInteger(d.revision) || !validTime(d.at) || !v.opportunities.some((o: any) => o.id === d.opportunityId)) throw new Error("Invalid owner decision history");
  for (const o of v.operations) if (!object(o) || typeof o.id !== "string" || !o.id || o.id.length > 150 || !validHash(o.hash) || !validTime(o.at)) throw new Error("Invalid operation history");
  return v as ProjectTeam;
}

/** Restoring retains evidence and reservations, but never restarts unattended work. */
export function disableRestoredProjectTeam(value: unknown): ProjectTeam {
  const team = structuredClone(validateTeamDocument(value));
  if (team.status !== "archived") team.status = "paused";
  team.revision++; team.updatedAt = Date.now();
  for (const opportunity of team.opportunities) if (["ready", "accepted", "selected", "implementing"].includes(opportunity.status)) { opportunity.status = "blocked"; opportunity.reason = "Restored result requires a new verified run before approval"; opportunity.revision++; }
  team.error = "Restored from backup. Inspect repository membership, launch receipts and budgets before activating.";
  for (const cycle of team.cycles) if (ACTIVE_CYCLES.includes(cycle.status)) { cycle.status = "cancelled"; cycle.endedAt = Date.now(); cycle.reason = "Cancelled during restore; unresolved launch reservations retained"; }
  return team;
}
