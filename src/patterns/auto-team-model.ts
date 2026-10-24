import type { AgentId } from "../adapters/index.js";
import type { TeamInventory, TeamMember, TeamMessage, TeamPlan, TeamState, TeamTask } from "../teams.js";

/** A replacement gets its own provider's settings, never the failed model's.
 * Model-routing inventories may have empty role settings and no CLI default. */
export function replacementSettings(provider: TeamInventory["providers"][number], role: TeamMember["role"]) {
  const configured = provider.settingsByRole?.[role];
  const model = configured?.model || provider.model || provider.catalog?.defaultModel || provider.models?.[0]?.id || "";
  const effort = configured?.effort ?? (model === provider.model ? provider.effort : undefined) ?? "";
  return { model, effort };
}

const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: "string" };
const identifier = { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$", description: "Stable lowercase identifier, e.g. api, add-validation, goal; never T1 or R1" };
const strings = { type: "array", items: str };
const array = (items: object) => ({ type: "array", items });
const member = obj({ id: identifier, name: str, role: { type: "string", enum: ["coordinator", "worker", "reviewer"] }, provider: { type: "string", description: "Exact provider ID from the supplied eligible inventory and selected pool" }, model: str, effort: str, reason: str });
const legacyTask = obj({ id: identifier, title: str, instructions: str, owner: { type: "string", description: "An active worker member ID (or coordinator for investigation). Never the reviewer: code-flow schedules independent review automatically." }, kind: { type: "string", enum: ["implementation", "investigation"] }, dependsOn: strings, requirements: strings, acceptance: strings, paths: strings });
const task = obj({ ...legacyTask.properties, dependencyTypes: array(obj({ taskId: identifier, kind: { type: "string", enum: ["completion", "artifact", "knowledge"] } })) });
const subplans = array(obj({ id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,27}$" }, strategy: { type: "string", enum: ["investigate-implement", "implement-verify", "bounded-repair"] }, owner: str, requirements: strings, acceptance: strings, paths: strings, dependsOn: strings, instructions: str }));
/** Legacy schemas stay separate so saved wave decisions are still valid during replay. */
export const LEGACY_TEAM_PLAN_SCHEMA = obj({ requirements: array(obj({ id: identifier, description: str })), members: array(member), tasks: array(legacyTask), contracts: strings, rationale: str });
/** Every wire object is closed and every property required, as strict Codex output requires. */
export const TEAM_PLAN_SCHEMA = obj({ ...LEGACY_TEAM_PLAN_SCHEMA.properties, tasks: array(task), subplans });
export const TEMPLATE_TEAM_PLAN_SCHEMA = obj({ ...TEAM_PLAN_SCHEMA.properties, templateUses: array(obj({
  id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,11}$" }, templateId: identifier, version: { type: "integer", minimum: 1 },
  inputs: array(obj({ name: str, value: str })), assignments: array(obj({ role: str, memberId: identifier })),
  dependsOn: strings, requirements: strings, instructions: str,
})) });
const reply = obj({ requestId: str, body: str, evidence: strings });
export const TASK_OUTCOME_SCHEMA = obj({
  taskId: str, memberId: str, status: { type: "string", enum: ["submitted", "needs_info", "failed"], description: "submitted means the assigned artifact is ready for engine integration and verification; it does not claim final checks or review passed" }, checkpoint: str, handover: str,
  artifacts: strings, unresolvedRequirements: strings,
  questions: array(obj({ id: identifier, recipient: str, body: str, blocking: { type: "boolean" } })), replies: array(reply),
  findings: array(obj({ title: str, body: str, evidence: strings, paths: strings })),
});
/** Browser URLs are evidence references, never repository path ownership. */
export function normalizeTaskOutcomeEvidence(outcome: TaskOutcome): TaskOutcome {
  return { ...outcome, findings: outcome.findings.map(finding => {
    const urls = finding.paths.filter(path => /^https?:\/\//i.test(path));
    return urls.length ? { ...finding, paths: finding.paths.filter(path => !urls.includes(path)), evidence: [...new Set([...finding.evidence, ...urls])] } : finding;
  }) };
}

export function taskOutcomeSchema(requirementIds: string[]) {
  return obj({ ...TASK_OUTCOME_SCHEMA.properties, unresolvedRequirements: { type: "array", items: { type: "string", enum: requirementIds }, description: "Only known IDs of unfinished implementation requirements. Use [] on submission. Pending engine commits, checks, proof and independent review belong in handover text, not here." } });
}
export const TEAM_ANSWERS_SCHEMA = obj({ replies: array(reply), unresolved: strings });
export const LEGACY_TEAM_REVISION_SCHEMA = obj({
  reason: str, addTasks: array(legacyTask), reassignments: array(obj({ taskId: str, memberId: str })),
  retryTasks: strings, contracts: strings, answers: array(reply), addMembers: array(member), retireMembers: strings,
});

export const TEAM_REVISION_SCHEMA = obj({ ...LEGACY_TEAM_REVISION_SCHEMA.properties, addTasks: array(task), contractRequirements: strings });

export interface TaskOutcome {
  taskId: string; memberId: string; status: "submitted" | "needs_info" | "failed"; checkpoint: string; handover: string;
  artifacts: string[]; unresolvedRequirements: string[];
  questions: { id: string; recipient: string; body: string; blocking: boolean }[];
  replies: TeamReply[];
  findings: { title: string; body: string; evidence: string[]; paths: string[] }[];
}
export interface TeamReply { requestId: string; body: string; evidence: string[] }
export interface TeamRevision { contractRequirements?: string[]; reason: string; addTasks: TeamTask[]; reassignments: { taskId: string; memberId: string }[]; retryTasks: string[]; contracts: string[]; answers: TeamReply[]; addMembers: TeamMember[]; retireMembers: string[] }
export interface TeamPolicy { coordinator: AgentId; pool: AgentId[]; inventory: TeamInventory; maxMembers: number; maxTasks: number; differentProviderReview: boolean }

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const unique = (items: string[]) => new Set(items).size === items.length;
const nonempty = (value: string) => !!value.trim();

export function pathAllowed(path: string): boolean {
  return path === "*" || (!!path && path.length <= 500 && !/[\u0000-\u001f\u007f]/.test(path) && !path.startsWith("/") && !path.startsWith("-") && !path.includes("\\") && !path.split("/").some((p) => p === "." || p === ".." || p === ".git" || p === "") && !path.includes("*") && !/^[A-Za-z]:/.test(path));
}
export function ownsPath(paths: string[], file: string): boolean {
  return paths.some((p) => p === "*" || file === p || file.startsWith(`${p}/`));
}
export function overlaps(a: TeamTask, b: TeamTask): boolean {
  return a.kind === "implementation" && b.kind === "implementation" && a.paths.some((p) => b.paths.some((q) => p === "*" || q === "*" || p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)));
}

/** Schema handles types; this validates the permissions and graph before any dispatch. */
export function planProblem(plan: TeamPlan, policy: TeamPolicy, retainedMembers: ReadonlySet<string> = new Set()): string | undefined {
  if (!plan.requirements.length || !plan.tasks.length) return "include requirements and at least one task";
  if (plan.requirements.length > 48 || plan.contracts.length > 24 || plan.rationale.length > 4_000) return "requirements, contracts, and rationale must fit the bounded plan";
  const activeMembers = plan.members.filter((m) => m.status !== "retired");
  if (activeMembers.length > policy.maxMembers || activeMembers.length < 2) return `team size must be between 2 and ${policy.maxMembers}`;
  if (plan.tasks.length > policy.maxTasks) return `the plan exceeds ${policy.maxTasks} tasks`;
  for (const [kind, values] of [["member", plan.members], ["task", plan.tasks], ["requirement", plan.requirements]] as const) {
    if (!unique(values.map((v) => v.id)) || values.some((v) => !ID.test(v.id))) return `${kind} IDs must be unique short lowercase identifiers`;
  }
  if (plan.requirements.some((r) => !nonempty(r.description) || r.description.length > 4_000)) return "requirements need bounded descriptions";
  if (plan.contracts.some((c) => !nonempty(c) || c.length > 8_000)) return "contracts cannot be empty or exceed 8000 characters";
  const coordinator = activeMembers.filter((m) => m.role === "coordinator");
  const reviewers = activeMembers.filter((m) => m.role === "reviewer");
  if (coordinator.length !== 1 || reviewers.length !== 1) return "include exactly one coordinator and one independent reviewer";
  if (coordinator[0]!.id !== "coordinator") return "the coordinator member ID must be coordinator (preserving its planning session identity)";
  if (coordinator[0]!.provider !== policy.coordinator) return "the coordinator must preserve the user's selected provider";
  const available = policy.inventory.providers.filter((p) => p.available && !p.blockedReason && (policy.pool.includes(p.id) || p.id === policy.coordinator));
  for (const m of activeMembers) {
    if (m.id === "user") return "user is reserved for authenticated user replies";
    if (m.role !== "coordinator" && !policy.pool.includes(m.provider)) return `${m.id} chose a provider outside the user's worker/reviewer pool`;
    // A revision can retain an idle member whose login/quota became unavailable. This
    // does not admit it to new work; dispatch and revised assignments are checked separately.
    const provider = available.find((p) => p.id === m.provider) ?? (retainedMembers.has(m.id) ? policy.inventory.providers.find(p => p.id === m.provider) : undefined);
    if (!provider) return `${m.id} chose unavailable, exhausted, or unauthorized provider ${m.provider}`;
    if (!nonempty(m.name) || m.name.length > 120 || !nonempty(m.reason) || m.reason.length > 2_000) return "every member needs a bounded name and composition reason";
    const settings = provider.settingsByRole?.[m.role] ?? provider;
    const model = provider.models?.find((model) => model.id === (m.model || provider.catalog?.defaultModel) || model.aliases?.includes(m.model));
    if (provider.catalog && !model) return `${m.id} chose a model whose availability in this environment is unknown`;
    if (provider.catalog && m.effort && !model?.efforts?.includes(m.effort)) return `${m.id} chose an unsupported effort for this exact model`;
    if (m.role === "coordinator" && (m.model !== (settings.model ?? "") || m.effort !== (settings.effort ?? ""))) return "The coordinator model settings and effort must remain unchanged";
    const variants = m.role !== "coordinator" && "variants" in settings ? settings.variants : undefined;
    // A selected pool is an allowlist of model/effort pairs, not permission to use every catalog model.
    const choices = variants?.length ? [settings, ...variants] : [settings];
    const matching = choices.filter(choice => variants?.length
      ? m.model === (choice.model ?? "")
      : choice.model ? m.model === choice.model : !m.model || !!model);
    if (!matching.length) return `${m.id} must preserve supplied model settings or choose a supplied supported model (empty means default)`;
    const efforts = model?.efforts ?? provider.efforts ?? [];
    if (!matching.some(choice => choice.effort ? m.effort === choice.effort : !m.effort || efforts.includes(m.effort))) return `${m.id} must preserve supplied effort settings or choose a supplied supported effort (empty means default)`;
  }
  for (const t of plan.tasks) {
    const owner = plan.members.find((m) => m.id === t.owner);
    if (!owner || owner.role === "reviewer" || owner.status === "retired" && !["submitted", "completed"].includes(t.status ?? "")) return `${t.id} must be assigned to an active non-reviewer member. The runtime supplies final independent review and checks; remove redundant final-review tasks instead of reassigning them.`;
    if (t.kind === "implementation" && owner.role !== "worker") return `${t.id}: implementation belongs to a worker, keeping coordinator and reviewer read-only`;
    if (!nonempty(t.title) || t.title.length > 180 || !nonempty(t.instructions) || t.instructions.length > 16_000 || !t.acceptance.length || t.acceptance.length > 16 || t.acceptance.some((a) => !nonempty(a) || a.length > 2_000)) return `${t.id} needs bounded instructions and acceptance criteria`;
    if (!t.requirements.length || t.requirements.some((id) => !plan.requirements.some((r) => r.id === id))) return `${t.id} must cover existing requirements`;
    if (t.dependencyTypes && (Object.keys(t.dependencyTypes).some((id) => !t.dependsOn.includes(id)) || Object.values(t.dependencyTypes).some((kind) => !["completion", "artifact", "knowledge"].includes(kind)))) return `${t.id} has invalid typed dependencies`;
    if (!unique(t.dependsOn) || t.dependsOn.some((id) => id === t.id || !plan.tasks.some((other) => other.id === id))) return `${t.id} has an invalid dependency`;
    if (t.paths.some((p) => !pathAllowed(p)) || (t.kind === "implementation" && !t.paths.length)) return `${t.id} needs safe owned repository paths (directories, files, or *)`;
  }
  if (plan.requirements.some((r) => !plan.tasks.some((t) => t.requirements.includes(r.id)))) return "every requirement must have a task; requirements cannot silently disappear";
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (plan.tasks.find((t) => t.id === id)!.dependsOn.some(cycle)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  if (plan.tasks.some((t) => cycle(t.id))) return "task dependencies must be acyclic";
  const author = plan.members.find((m) => m.id === plan.tasks.find((t) => t.kind === "implementation")?.owner) ?? coordinator[0]!;
  if (reviewers[0]!.provider === author.provider && (policy.differentProviderReview || available.some((p) => policy.pool.includes(p.id) && p.id !== author.provider))) return "use a reviewer from another eligible provider (or disable strict provider independence when only one provider is available)";
  return undefined;
}

/** Deterministic wave: dependencies available, one assignment per member, compatible writers. */
export function readyTasks(tasks: TeamTask[], messages: TeamMessage[] = [], eligible: (task: TeamTask) => boolean = () => true, priorities: Record<string, number> = {}): TeamTask[] {
  const priority = (id: string) => Object.hasOwn(priorities, id) && Number.isFinite(priorities[id]) ? priorities[id]! : 0;
  const selected: TeamTask[] = [];
  for (const t of [...tasks].sort((a, b) => priority(b.id) - priority(a.id) || a.id.localeCompare(b.id))) {
    if (t.status !== "pending" || !eligible(t)) continue;
    // Exclude occupied members/paths before packing the ready set, otherwise an
    // ineligible candidate can hide later runnable work with the same owner.
    if (tasks.some((active) => active.status === "running" && (active.owner === t.owner || overlaps(t, active)))) continue;
    if (!t.dependsOn.every((id) => {
      const dependency = tasks.find((d) => d.id === id);
      if (!dependency) return false;
      const kind = t.dependencyTypes?.[id] ?? "completion";
      const finished = ["submitted", "completed"].includes(dependency.status ?? "") && !dependency.evidenceStale;
      if (kind === "artifact") return finished && !!dependency.head && !!dependency.artifacts?.length;
      if (kind === "knowledge" && dependency.evidenceStale) return false;
      if (kind === "knowledge") return finished && !!dependency.artifacts?.length || messages.some((m) => m.kind === "reply" && m.sender === dependency.owner && m.recipient === t.owner && m.taskId === t.id && m.evidence.length > 0 && m.status !== "open");
      return finished;
    })) continue;
    if (selected.some((other) => other.owner === t.owner || overlaps(t, other))) continue;
    selected.push(t);
  }
  return selected;
}

export function outcomeProblem(outcome: TaskOutcome, task: TeamTask, member: TeamMember, state: TeamState): string | undefined {
  if (outcome.taskId !== task.id || outcome.memberId !== member.id) return "taskId and memberId must match this assignment";
  if (!nonempty(outcome.checkpoint) || outcome.checkpoint.length > 12_000) return "include an observable checkpoint of at most 12000 characters";
  if (!nonempty(outcome.handover) || outcome.handover.length > 8_000) return "publish a shareable handover of at most 8000 characters, separate from your private checkpoint";
  if (outcome.questions.length > 8 || outcome.replies.length > 16 || outcome.findings.length > 6 || outcome.artifacts.length > 24) return "outcome exceeds the bounded message, artifact, or finding limit";
  if (outcome.findings.some((f) => !f.title.trim() || f.title.length > 200 || !f.body.trim() || f.body.length > 8_000 || !f.evidence.some(nonempty) || f.paths.some((p) => !pathAllowed(p) || p === "*"))) return "findings need bounded text, evidence, and safe repository paths";
  if (outcome.unresolvedRequirements.some((id) => !state.requirements.some((r) => r.id === id))) return "unresolved requirements must use known IDs";
  if (outcome.status === "submitted" && outcome.unresolvedRequirements.length) return "unresolved requirements cannot be submitted as completed work";
  if (!unique(outcome.questions.map((q) => q.id)) || outcome.questions.some((q) => !ID.test(q.id) || !nonempty(q.body) || q.body.length > 8_000)) return "questions need unique local IDs and bounded nonempty bodies";
  if (outcome.questions.some((q) => q.recipient !== "user" && (!state.members.some((m) => m.id === q.recipient) || q.recipient === member.id))) return "questions must address another known member or user";
  if (outcome.replies.some((r) => !validReply(r, member.id, state))) return "replies must answer questions addressed to this member, with evidence";
  if (outcome.status === "needs_info" && !outcome.questions.some((q) => q.blocking) && !state.messages.some((q) => q.kind === "question" && q.taskId === task.id && q.blocking && (q.status === "open" || q.sourceAttempt === task.attempts))) return "needs_info requires a blocking question";
  if (outcome.status === "submitted" && (outcome.questions.some((q) => q.blocking) || state.messages.some((q) => q.kind === "question" && q.taskId === task.id && q.blocking && q.status === "open"))) return "a blocking question cannot accompany submitted work";
  if (outcome.status === "submitted" && task.kind === "investigation" && !outcome.artifacts.some(nonempty)) return "investigations need evidence-bearing artifacts";
  return undefined;
}

export function validReply(reply: TeamReply, sender: string, state: TeamState, coordinator = false): boolean {
  const question = state.messages.find((m) => m.id === reply.requestId && m.kind === "question" && (m.status === "open" || state.messages.some((r) => r.kind === "reply" && r.requestId === m.id && r.sender === sender && r.body === reply.body)));
  return !!question && question.recipient !== "user" && (coordinator || question.recipient === sender) && !!reply.body.trim() && reply.body.length <= 8_000 && reply.evidence.length <= 16 && reply.evidence.some(nonempty);
}

/** Revisions add bounded work and assignments; they cannot rewrite the approved requirement set. */
export function revisionProblem(revision: TeamRevision, state: TeamState, policy: TeamPolicy): string | undefined {
  const existing = new Set(state.tasks.map((t) => t.id));
  if (revision.addTasks.some((t) => existing.has(t.id))) return "new tasks must have new IDs";
  if (!unique(revision.reassignments.map((r) => r.taskId)) || !unique(revision.retryTasks)) return "each task may be revised only once per patch";
  if (!unique(revision.retireMembers)) return "retire each member only once";
  if (revision.addMembers.some((m) => m.role !== "worker" || state.members.some((old) => old.id === m.id))) return "new members need fresh IDs and must be workers; coordinator and reviewer are pinned";
  if (state.members.length + revision.addMembers.length > policy.maxTasks + 2) return "member history exceeds the bounded replacement limit";
  for (const id of revision.retireMembers) {
    const member = state.members.find((m) => m.id === id);
    if (!member || member.role !== "worker" || member.status === "working" || member.status === "retired") return "only idle worker members can be retired";
    if (state.tasks.some((t) => t.owner === id && !["submitted", "completed"].includes(t.status ?? "") && !revision.reassignments.some((r) => r.taskId === t.id && r.memberId !== id))) return "retiring a member requires handing off its unfinished assignments";
    if (state.scheduler !== "event" && state.messages.some((m) => m.kind === "question" && m.status === "open" && m.recipient === id)) return "answer outstanding requests before retiring their recipient";
  }
  for (const r of revision.reassignments) {
    const target = state.tasks.find((t) => t.id === r.taskId);
    if (!target || ["submitted", "completed", "running"].includes(target.status ?? "")) return "only unfinished idle tasks can be reassigned";
  }
  for (const id of revision.retryTasks) if (!state.tasks.some((t) => t.id === id && t.status === "failed" && (t.attempts ?? 0) - (t.allocationStartAttempt ?? 0) <= state.maxRepairs)) return "only failed tasks within the repair limit can be retried";
  if (revision.answers.some((r) => !validReply(r, "", state, true))) return "coordinator answers need an open non-user request and evidence";
  if (revision.contractRequirements?.some((id) => !state.requirements.some((r) => r.id === id))) return "contract changes may only invalidate known requirements";
  if (revision.contracts.some((c) => !nonempty(c))) return "contracts cannot be empty";
  const plan = { ...state, contracts: [...state.contracts, ...revision.contracts.filter((contract) => !state.contracts.includes(contract))], members: state.members.map((m) => revision.retireMembers.includes(m.id) ? { ...m, status: "retired" as const } : m).concat(revision.addMembers), tasks: state.tasks.map((t) => ({ ...t, owner: revision.reassignments.find((r) => r.taskId === t.id)?.memberId ?? t.owner })).concat(revision.addTasks) };
  const admittedOwners = new Set([
    ...revision.addTasks.map(t => t.owner),
    ...revision.reassignments.map(r => r.memberId),
    ...revision.retryTasks.map(id => plan.tasks.find(t => t.id === id)!.owner),
  ]);
  for (const id of admittedOwners) {
    const member = plan.members.find(m => m.id === id);
    const provider = member && policy.inventory.providers.find(p => p.id === member.provider);
    if (!provider?.available || provider.blockedReason) return `${id} cannot receive new or retried work while its provider is unavailable`;
  }
  return planProblem(plan, policy, new Set(state.members.map(m => m.id)));
}
