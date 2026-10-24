import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, worktreeGit, type Checkout } from "./git.js";
import { validateAgentSettings } from "./adapters/index.js";
import type { AgentId, AgentSettings } from "./adapters/types.js";

/** User preferences belong to the task, not to an individual provider execution. */
export interface TaskTeamConfig {
  enabled: boolean;
  preset: "adaptive" | "build-review" | "investigate";
  coordinator: AgentId;
  providers: AgentId[];
  settings: AgentSettings;
  maxMembers: number;
  maxCalls: number;
  maxMinutes: number;
  approvePlan: boolean;
  template?: { id: string; version: number; inputs: Record<string, string> };
}
export interface TaskTeamTurn {
  key: string;
  executionId: string;
  baseline: string;
  result?: string;
  state: "working" | "stopping" | "applied" | "preserved";
  report?: string;
  priorExecutions?: string[];
  correctionIds?: string[];
  acceptingCorrections?: boolean;
  reconciliation?: TaskReconciliation;
  resolutionCheck?: { ok: boolean; command: string; output: string };
  retries?: number;
  resumeRequested?: boolean;
  reviewStale?: boolean;
  resolutionReview?: { executionId: string; checkpoint: string; approved?: boolean; issues?: import("./patterns/findings.js").ReviewIssue[]; error?: string };
  executionStatus?: "running" | "done" | "failed" | "cancelled" | "stopped" | "interrupted";
}
export interface TaskReconciliation { current: string; result: string; merged: string; conflicts: string[] }
export class TaskTeamConflict extends Error {
  constructor(readonly reconciliation: TaskReconciliation) { super("Your edits overlap the team's changes. Review the conflicting files; both versions are preserved."); }
}
const normalizedRequest = (request: string) => request.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/^(?:(?:please|can you|could you|would you)\s+)+/, "");

/** Explicit conversation controls take precedence over pending questions. File or
 * worker-specific instructions remain steering, not a global cancellation. */
export function taskTeamControl(request: string): "stop" | "pause" | undefined {
  const text = normalizedRequest(request);
  const match = /^(stop|cancel|pause|wait|hold on)(?:\s+(?:(?:the|this|all|current)\s+)?(?:team|task|run|work|execution|everything|working))?(?=\s*(?:[.!?]|$|(?:and|for now|please)\b))/.exec(text);
  return match ? /^(pause|wait|hold on)$/.test(match[1]!) ? "pause" : "stop" : undefined;
}
/** A pending question must not swallow an explicit correction or a question to the lead. */
export function taskTeamQuestionReply(request: string): boolean {
  const text = normalizedRequest(request);
  if (taskTeamControl(text)) return false;
  if (/^(?:what|why|how|explain|summari[sz]e|describe|tell me|status)\b/.test(text)) return false;
  if (/^(?:implement|build|add|remove|delete|refactor|fix|update|change|create|deploy|commit|push|run|test|keep|preserve|stop|avoid|leave|don't|do not)\b/.test(text)) return false;
  if (/(?:[;.!?]|\bbut|\bthen)\s*(?:please\s+)?(?:fix|update|change|stop|keep|preserve|use|switch)\b/.test(text)) return false;
  return true;
}
/** Fast, conservative routing for conversational requests. Unclear work still gets
 * the configured team; an explicit team request always wins. This is not an
 * authorization classifier: the normal provider/tool permissions still apply. */
export function taskTeamRoute(request: string, active = false): "direct" | "team" {
  const text = normalizedRequest(request);
  if (/\b(use|ask|start|run|delegate|bring in)\b.{0,32}\b(team|teammates|workers)\b/.test(text)) return "team";
  // Constraints remain steering even when introduced as a question. Explain/how-to
  // questions alone are conversational; mixed requests must retain their work clause.
  const work = "implement|build|add|remove|delete|refactor|fix|update|change|create|deploy|commit|push|run|test|upload|download|click|type|keep|preserve|stop|avoid|leave|don't|do not";
  const alsoWork = new RegExp(`(?:\\b(?:and|then|also|now|but|instead)\\b|[.;?!,]|\\n)\\s*(?:(?:can|could|would) you\\s+|please\\s+)?(?:${work}|use|switch|assign|delegate)\\b`).test(text);
  if (alsoWork || /^(?:keep|preserve|stop|avoid|leave|don't|do not)\b/.test(text) || /^what about (?:keeping|preserving|leaving|stopping|avoiding|changing|updating)\b/.test(text)) return "team";
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|great|got it)[.! ]*$/.test(text)) return "direct";
  if (/^(what\b|why\b|how (?:does|do|did|is|are|can|would)\b|explain\b|summari[sz]e\b|describe\b|tell me\b|status\b|any (?:update|progress))/.test(text) && text.length < 3000) return "direct";
  if (/^(?:is|are|was|were|does|should)\b/.test(text) && text.endsWith("?")) return "direct";
  // Explicitly small follow-ups stay with the lead. During active delegation the
  // same instruction must reach the workers rather than race them in the workspace.
  if (!active && /^(?:just|only) (?:rename|change|fix|update|remove)\b/.test(text) && text.length < 300 && !/\b(?:and|then|also)\b|[;\n]/.test(text)) return "direct";
  return "team";
}

export function validateTaskTeam(raw: unknown): TaskTeamConfig {
  const v = raw as TaskTeamConfig;
  if (!v || typeof v !== "object" || typeof v.enabled !== "boolean") throw new Error("Choose whether Team is enabled");
  const supported = (id: unknown): id is AgentId => ["claude", "codex", "agy"].includes(String(id));
  if (!supported(v.coordinator) || !Array.isArray(v.providers) || !v.providers.length || v.providers.length > 3 || !v.providers.every(supported) || new Set(v.providers).size !== v.providers.length) throw new Error("Choose a coordinator and at least one available team provider");
  if (!["adaptive", "build-review", "investigate"].includes(v.preset)) throw new Error("Choose a team template");
  for (const [name, min, max] of [["maxMembers", 3, 6], ["maxCalls", 4, 200], ["maxMinutes", 1, 720]] as const) if (!Number.isInteger(v[name]) || v[name] < min || v[name] > max) throw new Error(`${name} must be between ${min} and ${max}`);
  if (typeof v.approvePlan !== "boolean") throw new Error("Choose a plan approval preference");
  const settings = validateAgentSettings(v.settings ?? {});
  let template: TaskTeamConfig["template"];
  if (v.template) {
    const t = v.template;
    if (typeof t.id !== "string" || !Number.isInteger(t.version) || t.version < 1 || !t.inputs || typeof t.inputs !== "object" || Array.isArray(t.inputs) || Object.values(t.inputs).some(value => typeof value !== "string" || value.length > 100000)) throw new Error("Invalid saved team template");
    template = { id: t.id, version: t.version, inputs: { ...t.inputs } };
  }
  return { enabled: v.enabled, preset: v.preset, coordinator: v.coordinator, providers: [...v.providers], settings, maxMembers: v.maxMembers, maxCalls: v.maxCalls, maxMinutes: v.maxMinutes, approvePlan: v.approvePlan, ...(template ? { template } : {}) };
}

async function checked(at: Checkout, args: string[], extra = {}) {
  const r = await git(args, at, extra);
  if (r.code !== 0) throw new Error(r.stderr || "Could not prepare the team workspace");
  return r.stdout.trim();
}
/** Snapshot tracked + nonignored files using a private index. Never stages or commits the user's index. */
export async function taskCheckpoint(repo: string, path: string): Promise<string> {
  const at = await worktreeGit(repo, path), temp = await mkdtemp(join(tmpdir(), "codeflow-team-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    await checked(at, ["read-tree", "HEAD"], { env });
    // A literal excluded directory still raises Git's ignored-path error when a
    // provider fork has materialized handoff files. The glob skips its contents.
    await checked(at, ["add", "-A", "--", ".", ":(exclude)**/.codeflow-context/**"], { env });
    const tree = await checked(at, ["write-tree"], { env });
    const head = await checked(at, ["rev-parse", "HEAD"]);
    return await checked(at, ["-c", "user.name=code-flow", "-c", "user.email=code-flow@local.invalid", "commit-tree", tree, "-p", head, "-m", "Private team handoff checkpoint"]);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
/** Apply only the team's delta; leave the original branch and staged changes intact. Idempotent after restart. */
export async function applyTaskTeamResult(repo: string, path: string, baseline: string, result: string): Promise<{ reconciled: boolean }> {
  const at = await worktreeGit(repo, path);
  const current = await taskCheckpoint(repo, path);
  const tree = (ref: string) => checked(at, ["rev-parse", `${ref}^{tree}`]);
  const [before, after, now] = await Promise.all([tree(baseline), tree(result), tree(current)]);
  if (now === after || before === after) return { reconciled: false };
  let target = result;
  if (now !== before) {
    const merge = await prepareTaskReconciliation(repo, path, baseline, result, current);
    if (merge.conflicts.length) throw new TaskTeamConflict(merge);
    target = merge.merged;
  }
  await applySnapshot(at, current, target);
  return { reconciled: now !== before };
}
async function applySnapshot(at: Checkout, current: string, result: string) {
  const diff = await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", current, result, "--"], at);
  if (diff.code) throw new Error(diff.stderr);
  if (!diff.stdout) return;
  await checked(at, ["apply", "--check", "--whitespace=nowarn", "-"], { input: diff.stdout });
  await checked(at, ["apply", "--whitespace=nowarn", "-"], { input: diff.stdout });
}

export async function prepareTaskReconciliation(repo: string, path: string, baseline: string, result: string, current?: string): Promise<TaskReconciliation> {
  const at = await worktreeGit(repo, path);
  current ??= await taskCheckpoint(repo, path);
  // Synthetic siblings give Git 2.39 an explicit merge base without changing any ref.
  const sibling = async (ref: string) => checked(at, ["-c", "user.name=code-flow", "-c", "user.email=code-flow@local.invalid", "commit-tree", await checked(at, ["rev-parse", `${ref}^{tree}`]), "-p", baseline, "-m", "Private reconciliation snapshot"]);
  const merged = await git(["merge-tree", "--write-tree", "--name-only", "-z", await sibling(current), await sibling(result)], at);
  if (merged.code !== 0 && merged.code !== 1) throw new Error(merged.stderr || "Could not compare workspace changes");
  const fields = merged.stdout.split("\0"), tree = fields.shift()!;
  if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid reconciliation tree");
  const end = fields.indexOf("");
  const conflicts = merged.code === 1 ? fields.slice(0, end < 0 ? fields.length : end) : [];
  if (merged.code === 1 && !conflicts.length) throw new Error("Could not identify conflicting files");
  return { current, result, merged: tree, conflicts: [...new Set(conflicts)] };
}

export async function reconciliationFile(repo: string, path: string, ref: string, file: string) {
  const at = await worktreeGit(repo, path);
  const entry = await checked(at, ["ls-tree", "-z", ref, "--", file]);
  if (!entry) return { exists: false, text: "", mode: "" };
  const [mode, kind, object] = entry.split(/\s/);
  if (kind !== "blob" || !object) return { exists: true, binary: true, text: "", mode };
  const size = Number(await checked(at, ["cat-file", "-s", object]));
  if (size > 256 * 1024 || mode === "120000") return { exists: true, binary: true, text: "", mode };
  const value = await git(["cat-file", "blob", object], at);
  if (value.code) throw new Error("Could not read conflict version");
  return { exists: true, binary: value.stdout.includes("\0") || value.stdout.includes("\uFFFD"), text: value.stdout, mode };
}

export type ConflictChoice = { path: string; choice: "current" | "team" | "edited"; text?: string };
export async function resolveTaskReconciliation(repo: string, path: string, merge: TaskReconciliation, choices: ConflictChoice[]) {
  if (!Array.isArray(choices) || choices.length !== merge.conflicts.length || new Set(choices.map(choice => choice.path)).size !== choices.length || choices.some(choice => !merge.conflicts.includes(choice.path) || !["current", "team", "edited"].includes(choice.choice))) throw new Error("Choose a resolution for each conflicting file");
  const at = await worktreeGit(repo, path), current = await taskCheckpoint(repo, path);
  if (await checked(at, ["rev-parse", `${current}^{tree}`]) !== await checked(at, ["rev-parse", `${merge.current}^{tree}`])) throw new Error("Your workspace changed since this comparison. Refresh the comparison before applying.");
  const temp = await mkdtemp(join(tmpdir(), "codeflow-resolution-"));
  try {
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    await checked(at, ["read-tree", merge.merged], { env });
    for (const choice of choices) {
      if (choice.choice === "edited") {
        if (typeof choice.text !== "string" || Buffer.byteLength(choice.text) > 256 * 1024 || /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(choice.text)) throw new Error("Provide resolved text without conflict markers (up to 256 KB)");
        const versions = await Promise.all([merge.current, merge.result].map(ref => reconciliationFile(repo, path, ref, choice.path)));
        if (versions.some(version => version.binary)) throw new Error("Choose an existing version for binary or symbolic-link conflicts");
        const mode = versions.find(version => version.exists)?.mode || "100644";
        const object = await checked(at, ["hash-object", "-w", "--stdin"], { input: choice.text });
        await checked(at, ["update-index", "--add", "--cacheinfo", `${mode},${object},${choice.path}`], { env });
      } else {
        const ref = choice.choice === "current" ? merge.current : merge.result;
        const entry = await checked(at, ["ls-tree", "-z", ref, "--", choice.path]);
        if (!entry) await checked(at, ["update-index", "--force-remove", "--", choice.path], { env });
        else { const [mode, , object] = entry.split(/\s/); await checked(at, ["update-index", "--add", "--cacheinfo", `${mode},${object},${choice.path}`], { env }); }
      }
    }
    const tree = await checked(at, ["write-tree"], { env });
    await applySnapshot(at, current, tree);
    return tree;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
