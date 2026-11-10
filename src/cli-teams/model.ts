import { createHash } from "node:crypto";

export type Provider = "claude" | "codex" | "agy";
export const PROVIDERS = ["claude", "codex", "agy"] as const satisfies readonly Provider[];
export const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };
export const isProvider = (value: unknown): value is Provider => (PROVIDERS as readonly unknown[]).includes(value);
/** Managed Antigravity runs in Code Flow's sandbox unless the user explicitly asks for their normal, unrestricted agy setup. */
export type AntigravityMode = "isolated" | "unrestricted";
export interface Participant {
  id: string; provider: Provider; model?: string; effort?: string;
  binding?: "managed" | "current_session";
}
export interface TaskNode {
  id: string; type: "task"; operation: "propose" | "revise_proposal" | "synthesize" | "review_plan" | "implement" | "repair" | "review_code" | "verify" | "capture_snapshot";
  participant?: string; instructions: string; inputs?: string[];
}
export interface ParallelNode { id: string; type: "parallel"; tasks: TaskNode[] }
export interface JoinNode { id: string; type: "join"; inputs: string[] }
export interface GateNode { id: string; type: "gate"; policy: "agreement" | "verified"; target: string; reviews: string[]; verification?: string }
export interface LoopNode { id: string; type: "loop"; maxIterations: number; steps: Node[] }
export interface QuestionNode { id: string; type: "user_decision"; question: string; options: string[]; inputs?: string[]; continueOn?: string }
export interface FinishNode { id: string; type: "finish"; outcome: "plan_ready" | "agreed_plan" | "verified_changes" | "review_complete"; inputs: string[] }
export type Node = TaskNode | ParallelNode | JoinNode | GateNode | LoopNode | QuestionNode | FinishNode;
export interface Candidate {
  participants: Participant[]; steps: Node[]; completion: string[];
  scope: "plan" | "review" | "write";
  source?: "head" | "working_changes";
  check?: string; setup?: string;
  antigravity?: AntigravityMode;
  limits?: { maxInvocations?: number; maxMinutes?: number; concurrency?: number; maxAttempts?: number };
}
export interface Settings { model?: string; effort?: string }
export interface Preferences { providers?: Partial<Record<Provider, Settings>>; preferredProvider?: Provider }
export interface ResolvedParticipant extends Participant {
  requested: Settings;
  provenance: { model: string; effort: string };
  modelDefaultUnknown?: boolean; effortDefaultUnknown?: boolean;
}
export interface Definition extends Omit<Candidate, "participants" | "limits"> {
  participants: ResolvedParticipant[];
  limits: { maxInvocations: number; maxMinutes: number; concurrency: number; maxAttempts: number; attemptTimeoutMs: number };
}
export interface Artifact {
  id: string; sha256: string; kind: "plan" | "review" | "code_snapshot" | "verification" | "decision" | "collection" | "result";
  body: string; data: Record<string, unknown>; participant?: string;
}
export interface PendingAssignment {
  id: string; participant: string; operation: TaskNode["operation"]; instructions: string; inputs: Artifact[];
  attemptId: string; claimHash?: string; claimExpiresAt?: number; connection?: string; output?: { body: string; verdict?: "approve" | "changes_requested"; findings?: string[] };
}
export interface RuntimeState {
  leadReplyKind?: "answer" | "clarify" | "guidance" | "proposal";
  taskConversation?: { id: string; phase: "preparation" | "execution"; chatId?: string };
  waitingForSlot?: boolean;
  activity?: { path: string; nodeId: string; title: string; participant?: string; type: Node["type"]; status: "working" | "completed" | "changes_requested" | "interrupted" | "failed"; startedAt: number; endedAt?: number }[];
  version: 1; proposalId: string; proposalHash: string; definition: Definition;
  source: import("./snapshots.js").SourceSnapshot;
  hostConnection: string; artifacts: Record<string, Artifact>; pending: Record<string, PendingAssignment>;
  questions: Record<string, { question: string; options: string[]; answer?: string; inputs?: string[] }>;
  outcome?: "plan_ready" | "agreed_plan" | "verified_changes" | "review_complete" | "stopped_limit" | "blocked";
  detail?: string;
  managedInvocations?: number;
  recoveryTimeChargeMs?: number;
  recoveryRequired?: boolean;
  accountedExecutionMs?: number;
  nodeInvocations?: Record<string, number>;
}
export class CliTeamError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export function fail(code: string, message: string, details?: unknown): never { throw new CliTeamError(code, message, details); }
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
/** Strict validation is local to this API; legacy workflow schemas stay unchanged. */
export function shapeProblem(schema: any, value: any, path = "input"): string | undefined {
  if (schema.const !== undefined && value !== schema.const) return `${path}: expected ${schema.const}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: choose ${schema.enum.join(", ")}`;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path}: expected an object`;
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}: required`;
    for (const [key, entry] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key}: unknown field`;
      const sub = schema.properties?.[key]; if (sub) { const issue = shapeProblem(sub, entry, `${path}.${key}`); if (issue) return issue; }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 256)) return `${path}: invalid array length`;
    for (let i = 0; i < value.length; i++) { const issue = shapeProblem(schema.items, value[i], `${path}[${i}]`); if (issue) return issue; }
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 32768) || schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path}: invalid string`;
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${path}: invalid number`;
  } else if (schema.type === "boolean" && typeof value !== "boolean") return `${path}: expected boolean`;
}
const text = { type: "string", minLength: 1, maxLength: 12000 };
const id = { type: "string", pattern: "^(?!constructor$|prototype$)[a-z][a-z0-9-]{0,39}$" };
const refs = { type: "array", items: id, maxItems: 32 };
const settings = { type: "object", additionalProperties: false, properties: { model: { ...text, maxLength: 160 }, effort: { ...text, maxLength: 20 } } };
const taskProperties = { id, type: { const: "task" }, operation: { enum: ["propose", "revise_proposal", "synthesize", "review_plan", "implement", "repair", "review_code", "verify", "capture_snapshot"] }, participant: id, instructions: text, inputs: refs };
export const TASK_SCHEMA = { type: "object", additionalProperties: false, required: ["id", "type", "operation"], properties: taskProperties };
// Recursive node validation is explicit below so the same contracts work with the
// repository's small schema validator and MCP hosts that don't support recursive refs.
export const CANDIDATE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["participants", "steps", "completion", "scope"],
  properties: {
    participants: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "provider"], properties: { id, provider: { enum: [...PROVIDERS] }, ...settings.properties, binding: { enum: ["managed", "current_session"] } } } },
    steps: { type: "array", minItems: 1, maxItems: 64, items: { type: "object" } }, completion: { type: "array", minItems: 1, maxItems: 20, items: text }, scope: { enum: ["plan", "review", "write"] }, source: { enum: ["head", "working_changes"] }, check: { ...text, maxLength: 2000 }, setup: { ...text, maxLength: 2000 }, antigravity: { enum: ["isolated", "unrestricted"] },
    limits: { type: "object", additionalProperties: false, properties: { maxInvocations: { type: "integer", minimum: 1, maximum: 256 }, maxMinutes: { type: "number", minimum: 1, maximum: 720 }, concurrency: { type: "integer", minimum: 1, maximum: 4 }, maxAttempts: { type: "integer", minimum: 1, maximum: 3 } } },
  },
};
export const PREFERENCES_SCHEMA = { type: "object", additionalProperties: false, properties: { preferredProvider: { enum: [...PROVIDERS] }, providers: { type: "object", additionalProperties: false, properties: { claude: settings, codex: settings, agy: settings } } } };
export function validatePreferences(value: unknown): Preferences {
  const problem = shapeProblem(PREFERENCES_SCHEMA, value);
  if (problem) fail("validation_failed", `Invalid preferences: ${problem}`);
  return value as Preferences;
}
export function validateCandidate(value: unknown): Candidate {
  const problem = shapeProblem(CANDIDATE_SCHEMA, value);
  if (problem) fail("validation_failed", problem);
  const c = structuredClone(value) as Candidate;
  const ids = new Set<string>(), participants = new Map(c.participants.map(p => [p.id, p]));
  if (participants.size !== c.participants.length) fail("validation_failed", "Participant IDs must be unique");
  if (c.participants.filter(p => p.binding === "current_session").length > 1) fail("validation_failed", "One current conversation can represent only one participant; use managed workers for independent reviewers");
  if (c.antigravity === "unrestricted" && !c.participants.some(p => p.provider === "agy" && p.binding !== "current_session")) fail("validation_failed", "Unrestricted Antigravity applies only to managed agy participants; remove it or add one");
  const contracts = new Map<string, { kind: Artifact["kind"]; target?: string; participant?: string; policy?: string }>();
  let nodes = 0, expanded = 0, writes = new Set<string>(), finished = false;
  const visit = (steps: Node[], previous: Set<string>, multiplier: number, inLoop: boolean, parallel = false): Set<string> => {
    const known = new Set(previous);
    for (const n of steps) {
      if (!n || typeof n !== "object" || shapeProblem(id, n.id) || ids.has(n.id)) fail("validation_failed", "Node IDs must be unique, short lowercase identifiers");
      if (++nodes > 64 || (expanded += multiplier) > 256) fail("validation_failed", "Workflow exceeds 64 nodes or 256 expanded steps");
      ids.add(n.id);
      const requireRefs = (names: string[] | undefined) => {
        if (names !== undefined && (!Array.isArray(names) || names.length > 32 || names.some(v => !known.has(v)))) fail("validation_failed", `${n.id}: inputs must reference earlier nodes`);
      };
      let allowed: string[];
      if (n.type === "task") {
        const issue = shapeProblem(TASK_SCHEMA, n); if (issue) fail("validation_failed", `${n.id}: ${issue}`);
        allowed = Object.keys(taskProperties); requireRefs(n.inputs);
        const engine = ["verify", "capture_snapshot"].includes(n.operation);
        if (!n.instructions) {
          if (!engine) fail("validation_failed", `${n.id}: agent work requires instructions`);
          n.instructions = n.operation === "verify" ? "Run the configured checks" : "Capture the current code snapshot";
        }
        if (engine ? n.participant !== undefined : !participants.has(n.participant!)) fail("validation_failed", `${n.id}: choose a participant for agent work only`);
        if (["review_plan", "review_code"].includes(n.operation) && n.inputs?.length !== 1) fail("validation_failed", `${n.id}: reviews require exactly one target input`);
        if (n.operation.startsWith("review") && contracts.get(n.inputs![0]!)?.kind !== (n.operation === "review_plan" ? "plan" : "code_snapshot")) fail("validation_failed", `${n.id}: review input has the wrong artifact kind`);
        if (n.operation === "verify" && !c.check) fail("validation_failed", "Verification requires an explicit check command");
        if (parallel && n.operation === "verify") fail("validation_failed", "Verification commands must run serially, outside parallel readers");
        if (["implement", "repair"].includes(n.operation)) {
          if (c.scope !== "write" || parallel || participants.get(n.participant!)?.binding === "current_session") fail("validation_failed", "Implementation requires write scope and a serial managed writer");
          writes.add(n.participant!);
        }
        contracts.set(n.id, { kind: n.operation.startsWith("review") ? "review" : n.operation === "verify" ? "verification" : ["capture_snapshot", "implement", "repair"].includes(n.operation) ? "code_snapshot" : "plan", target: n.operation.startsWith("review") ? n.inputs![0] : undefined, participant: n.participant });
      } else if (n.type === "parallel") {
        allowed = ["id", "type", "tasks"];
        if (!Array.isArray(n.tasks) || n.tasks.length < 1 || n.tasks.length > 8 || n.tasks.some(t => t.type !== "task")) fail("validation_failed", "Parallel groups require 1–8 read-only tasks");
        for (const task of n.tasks) { const child = visit([task], known, multiplier, inLoop, true); for (const ref of child) if (!known.has(ref)) previous.add(ref); }
        for (const ref of previous) known.add(ref);
        contracts.set(n.id, { kind: "collection" });
      } else if (n.type === "join") { allowed = ["id", "type", "inputs"]; if (!Array.isArray(n.inputs) || !n.inputs.length) fail("validation_failed", "Joins need input references"); requireRefs(n.inputs); contracts.set(n.id, { kind: "collection" }); }
      else if (n.type === "gate") {
        allowed = ["id", "type", "policy", "target", "reviews", "verification"];
        if (!["agreement", "verified"].includes(n.policy) || !Array.isArray(n.reviews) || n.policy === "agreement" && !n.reviews.length || new Set(n.reviews).size !== n.reviews.length) fail("validation_failed", `${n.id}: gates need distinct review references and a supported policy; agreement requires reviewers`);
        requireRefs([n.target, ...n.reviews, ...(n.verification ? [n.verification] : [])]);
        if (n.policy === "verified" && !n.verification) fail("validation_failed", "Verified gates require verification evidence");
        const reviews = n.reviews.map(r => contracts.get(r));
        if (contracts.get(n.target)?.kind !== (n.policy === "agreement" ? "plan" : "code_snapshot") || reviews.some(r => r?.kind !== "review" || r.target !== n.target) || new Set(reviews.map(r => r?.participant)).size !== reviews.length || n.policy === "verified" && (contracts.get(n.verification!)?.kind !== "verification" || reviews.some(r => writes.has(r!.participant!)))) fail("validation_failed", `${n.id}: gate needs correctly typed exact-target reviews from distinct eligible participants`);
        contracts.set(n.id, { kind: "decision", target: n.target, policy: n.policy });
      } else if (n.type === "loop") {
        allowed = ["id", "type", "maxIterations", "steps"];
        if (inLoop || !Number.isInteger(n.maxIterations) || n.maxIterations < 1 || n.maxIterations > 5 || !Array.isArray(n.steps) || !n.steps.length || n.steps.at(-1)?.type !== "gate") fail("validation_failed", "Loops require 1–5 iterations, a final gate, and no nested loops");
        const inner = visit(n.steps, known, multiplier * n.maxIterations, true);
        for (const ref of inner) known.add(ref);
        contracts.set(n.id, contracts.get(n.steps.at(-1)!.id)!);
      } else if (n.type === "user_decision") {
        allowed = ["id", "type", "question", "options", "inputs", "continueOn"]; requireRefs(n.inputs);
        if (typeof n.question !== "string" || !n.question.trim() || n.question.length > 4000 || !Array.isArray(n.options) || n.options.length < 2 || n.options.length > 5 || n.options.some(o => typeof o !== "string" || !o.trim() || o.length > 300)) fail("validation_failed", "Decisions need a question and 2–5 options");
        if (n.continueOn !== undefined && !n.options.includes(n.continueOn)) fail("validation_failed", "A checkpoint's continueOn must be one of its displayed options");
        contracts.set(n.id, { kind: "decision" });
      } else if (n.type === "finish") {
        allowed = ["id", "type", "outcome", "inputs"]; requireRefs(n.inputs);
        if (inLoop || parallel || finished || n !== steps.at(-1) || !n.inputs?.length || !["plan_ready", "agreed_plan", "verified_changes", "review_complete"].includes(n.outcome)) fail("validation_failed", "Finish must be the single final node with explicit result inputs");
        if (n.outcome === "verified_changes" && c.scope !== "write" || ["agreed_plan", "plan_ready"].includes(n.outcome) && c.scope !== "plan" || n.outcome === "review_complete" && c.scope !== "review") fail("validation_failed", "Finish outcome must match the requested scope");
        const evidence = n.inputs.map(r => contracts.get(r));
        if (n.outcome === "plan_ready" ? !evidence.some(e => e?.kind === "plan") : n.outcome === "review_complete" ? !evidence.some(e => e?.kind === "review") : !evidence.some(e => e?.kind === "decision" && e.policy === (n.outcome === "agreed_plan" ? "agreement" : "verified") && n.inputs.includes(e.target!))) fail("validation_failed", `${n.id}: finish requires matching target and gate evidence`);
        contracts.set(n.id, { kind: "result" });
        finished = true;
      } else fail("validation_failed", "Unknown workflow node type");
      if (Object.keys(n).some(k => !allowed.includes(k))) fail("validation_failed", `${n.id}: unsupported node field`);
      known.add(n.id);
    }
    return known;
  };
  visit(c.steps, new Set(), 1, false);
  if (!finished || c.steps.at(-1)?.type !== "finish" || writes.size > 1) fail("validation_failed", "Workflow needs one final result and at most one implementation participant");
  if (c.scope !== "write" && (c.setup || c.check)) fail("validation_failed", "Plan/review-only runs must not execute setup or check commands");
  if (c.scope === "write" && !c.check) fail("validation_failed", "Implementation/verification requires an explicit completion check");
  const minimum = (steps: Node[]): number => steps.reduce((count, n) => count + (n.type === "task" ? n.participant && participants.get(n.participant)?.binding !== "current_session" ? 1 : 0 : n.type === "parallel" ? minimum(n.tasks) : n.type === "loop" ? minimum(n.steps) : 0), 0);
  if (c.limits?.maxInvocations !== undefined && c.limits.maxInvocations < minimum(c.steps)) fail("validation_failed", "Call ceiling cannot admit the minimum required work; reduce the team/process or choose a sufficient ceiling");
  return structuredClone(c);
}
export function validateWebCandidate(value: unknown): Candidate {
  const c = validateCandidate(value);
  if (c.participants.some(p => p.binding === "current_session")) fail("validation_failed", "Web tasks use managed participants; a browser is not an agent session");
  const visit = (steps: Node[]) => { for (const n of steps) { if (c.scope === "write" && n.type === "user_decision" && (!n.continueOn || !n.inputs?.length)) fail("validation_failed", "Write-scope human checkpoints require artifact inputs and an explicit continueOn option; other answers stop before editing"); if (n.type === "loop") visit(n.steps); if (n.type === "parallel") visit(n.tasks); } }; visit(c.steps); return c;
}
