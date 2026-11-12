import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CODEFLOW_HOME } from "../config.js";
import { CliTeamError, PROVIDERS, shapeProblem, type Provider } from "./model.js";
import { composeRecipe, MODES, type Member } from "./recipes.js";
import { formatStatus } from "./presentation.js";

/**
 * The small tool surface hosts see by default. Every tool here is composed in the host-side bridge
 * from the owner's existing operations, so the run engine, approval and receipts are unchanged and
 * an older running owner keeps working.
 */
export type Call = (name: string, args: unknown) => Promise<any>;
const str = { type: "string", minLength: 1, maxLength: 200 };
const command = { type: "string", minLength: 1, maxLength: 2000 };
const tool = (name: string, description: string, properties: object, required: string[], readOnly = false, destructive = false) => ({ name: `codeflow_${name}`, description, inputSchema: { type: "object", additionalProperties: false, properties, required }, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false } });
export const SIMPLE_TOOLS = [
  tool("run", "Prepare a Code Flow task for the user to approve. Give the task and a mode; Code Flow picks the team. review: another agent reviews the current changes, read-only (the usual second opinion). plan: draft, independent review, revised plan, read-only. implement: write in a separate worktree, run the check, independent review, at most one repair pass; needs check. Leave team empty unless the user named a provider or model. Nothing runs until the user approves through codeflow_start_run.", {
    operationId: str, task: { type: "string", minLength: 1, maxLength: 12000 }, mode: { enum: [...MODES] },
    team: { type: "array", maxItems: 2, description: "Only what the user asked for, in role order: reviewers; or drafter then reviewer; or writer then reviewer.", items: { type: "object", additionalProperties: false, required: ["provider"], properties: { provider: { enum: [...PROVIDERS] }, model: { type: "string", minLength: 1, maxLength: 160 }, effort: { type: "string", minLength: 1, maxLength: 20 } } } },
    check: { ...command, description: "implement only: the command that proves the change, for example the project's test command." },
    setup: { ...command, description: "implement only: a command to run first, for example installing dependencies." },
    source: { enum: ["head", "working_changes"], description: "Default: working_changes for a review, head otherwise." },
    untracked: { type: "array", maxItems: 100, items: str, description: "Untracked files to include with working_changes." },
    continueFrom: { ...str, description: "Run ID to build on, for example to implement a finished plan." },
    notes: { type: "string", maxLength: 8000 },
  }, ["operationId", "task", "mode"]),
  tool("start_run", "Ask the user to approve the prepared task and start it. The user answers in a form in this session, in Code Flow or in a terminal; never supply approval yourself. Returns at once: the task then runs in the background.", { operationId: str, proposalId: str, expectedRevision: { type: "integer", minimum: 1 }, proposalHash: str }, ["operationId", "proposalId", "expectedRevision", "proposalHash"]),
  tool("status", "With runId: where the task stands, and when it has finished the path of its result file to read. waitSeconds waits for it to finish or need the user. Without runId: recent tasks in this repository.", { runId: str, waitSeconds: { type: "integer", minimum: 0, maximum: 25 }, unfinishedOnly: { type: "boolean" } }, [], true),
  tool("steer_run", "Answer a task's question (questionId and one of its options as message), add guidance inside the approved scope (message), or pause, resume or cancel it (action). Cannot widen scope, permissions or limits.", { operationId: str, runId: str, message: { type: "string", minLength: 1, maxLength: 8000 }, questionId: str, action: { enum: ["pause", "resume", "cancel"] } }, ["operationId", "runId"], false, true),
  tool("apply", "Bring a finished implementation into the user's checkout. Without previewHash: a dry run that changes nothing and returns a summary, a previewHash and the path of a diff file to read. With previewHash: asks the user to confirm, then stages exactly that diff. Never commits or pushes.", { runId: str, previewHash: str, operationId: str }, ["runId"], false, true),
  tool("providers", "Which provider CLIs are installed and whether Code Flow is connected. With providerId: that provider's models and efforts, to check a name the user gave.", { providerId: { enum: [...PROVIDERS] }, antigravity: { enum: ["isolated", "unrestricted"] }, refresh: { type: "boolean" } }, [], true),
];
const SIMPLE_ONLY = new Set(["codeflow_run", "codeflow_status", "codeflow_apply", "codeflow_providers"]);
/** Names shared with the advanced surface keep their original meaning unless the call uses the simple form. */
export const isSimpleCall = (name: string, args: any) => SIMPLE_ONLY.has(name) || name === "codeflow_steer_run" && args?.action !== undefined;
const spec = (name: string) => SIMPLE_TOOLS.find(t => t.name === name)!;
const invalid = (message: string): never => { throw new CliTeamError("validation_failed", message); };

export const RESULTS_DIR = join(resolve(CODEFLOW_HOME), "cli-teams-results");
const safeId = (runId: string) => /^[A-Za-z0-9._-]{1,200}$/.test(runId) ? runId : invalid("Unexpected run ID");
async function atomic(file: string, body: string) {
  await mkdir(RESULTS_DIR, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, body, { mode: 0o600 }); await rename(temp, file); } finally { await rm(temp, { force: true }); }
}

/** Which tools a host is shown: the small default set, or everything including the advanced graph and host-participation tools. */
export type Surface = "simple" | "all";
const SURFACE_FILE = join(resolve(CODEFLOW_HOME), "cli-teams-surface.json");
export async function toolSurface(env: NodeJS.ProcessEnv = process.env): Promise<Surface> {
  if (env.CODEFLOW_TOOLS === "all" || env.CODEFLOW_TOOLS === "simple") return env.CODEFLOW_TOOLS;
  try { return JSON.parse(await readFile(SURFACE_FILE, "utf8")).surface === "all" ? "all" : "simple"; } catch { return "simple"; }
}
export async function setToolSurface(surface: Surface) {
  await mkdir(resolve(CODEFLOW_HOME), { recursive: true });
  const temp = `${SURFACE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify({ surface })}\n`, { mode: 0o600 }); await rename(temp, SURFACE_FILE); } finally { await rm(temp, { force: true }); }
}
/** The tools advertised for a surface. Advanced tools stay callable either way, so an older skill keeps working. */
export function advertisedTools(surface: Surface, advanced: { name: string }[]) {
  if (surface === "simple") return SIMPLE_TOOLS;
  const names = new Set(advanced.map(t => t.name));
  return [...SIMPLE_TOOLS.filter(t => !names.has(t.name)), ...advanced];
}

/** Compose a recipe from the installed providers and create the proposal. Approval still happens in start_run. */
export async function proposeRecipe(call: Call, args: any, host?: Provider) {
  const found = await call("codeflow_list_providers", {});
  const installed: Provider[] = (found.providers ?? []).filter((p: any) => p.installed).map((p: any) => p.id);
  const agy = (found.providers ?? []).find((p: any) => p.id === "agy");
  const recipe = composeRecipe({ mode: args.mode, team: args.team as Member[] | undefined, host, installed, preferred: found.preferredProvider, agyAvailable: agy?.antigravity?.isolated?.available !== false, check: args.check, setup: args.setup, source: args.source });
  const context = { ...(args.untracked?.length ? { untracked: args.untracked } : {}), ...(args.notes ? { notes: args.notes } : {}), ...(args.continueFrom ? { reuseRunId: args.continueFrom } : {}) };
  const proposal = await call("codeflow_propose_run", { operationId: args.operationId, task: args.task, candidate: recipe.candidate, ...(Object.keys(context).length ? { context } : {}) });
  return { ...proposal, recipe: { mode: args.mode, roles: recipe.roles, notes: recipe.notes } };
}

const SUCCESS = new Set(["plan_ready", "agreed_plan", "verified_changes", "review_complete"]);
export type RunState = "working" | "needs_you" | "paused" | "finished" | "stopped" | "cancelled";
export function runState(run: any): RunState {
  const phase = run.progress?.phase;
  if (run.runtimeStatus === "running") return phase === "waiting_user" || phase === "waiting_host" ? "needs_you" : phase === "paused" || phase === "pausing" ? "paused" : "working";
  return phase === "cancelled" ? "cancelled" : phase === "completed" && SUCCESS.has(run.outcome) ? "finished" : "stopped";
}

/** Write the finished result to a file the host reads with its own file tool, instead of paging an artifact. */
export async function saveResultFile(call: Call, run: any): Promise<{ path: string; excerpt: string } | undefined> {
  const ref = run.result;
  if (!ref || run.runtimeStatus === "running") return undefined;
  const file = join(RESULTS_DIR, `${safeId(run.runId)}.md`), marker = `Artifact ${ref.id} · SHA-256 ${ref.sha256}`;
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing?.includes(marker)) return { path: file, excerpt: excerpt(existing) };
  let body = "", cursor: number | undefined = 0;
  do {
    const page: { body: string; nextCursor?: number } = await call("codeflow_get_artifact", { runId: run.runId, artifactId: ref.id, sha256: ref.sha256, cursor, maxBytes: 24000 });
    body += page.body; cursor = page.nextCursor;
  } while (cursor !== undefined);
  const text = `${body.trimEnd()}\n\n---\n\n${formatStatus({ ...run, workspace: undefined })}\n\n${marker}\n`;
  await atomic(file, text);
  return { path: file, excerpt: excerpt(text) };
}
const excerpt = (text: string) => { const body = text.split("\n\n---\n\n")[0]!; return body.length > 1500 ? `${body.slice(0, 1500).trimEnd()}…` : body; };

/** Status in the terms a host needs: what state, what to read, what to do next. Optionally waits for a change that matters. */
export async function runStatus(call: Call, args: { runId: string; waitSeconds?: number }) {
  const deadline = Date.now() + (args.waitSeconds ?? 0) * 1000;
  let run = await call("codeflow_get_run", { runId: args.runId });
  let cursor: { progressCursor?: string; artifactCursor: number } = { artifactCursor: run.artifactCount ?? 0 };
  for (let i = 0; i < 400 && runState(run) === "working" && Date.now() < deadline; i++) {
    const began = Date.now();
    run = await call("codeflow_get_run", { runId: args.runId, follow: true, waitMs: Math.max(0, Math.min(20000, deadline - began)), ...cursor });
    if (run.follow?.next) cursor = { progressCursor: run.follow.next.progressCursor, artifactCursor: run.follow.next.artifactCursor };
    // A reply with nothing to wait for must not turn into a tight loop.
    if (Date.now() - began < 200) await new Promise(done => setTimeout(done, 250));
  }
  const state = runState(run), result = await saveResultFile(call, run);
  const source = run.evidence?.source, handoff = run.handoff ?? {};
  const delivery = run.outcome === "verified_changes" && handoff.branch ? {
    branch: handoff.branch, worktree: handoff.worktree,
    check: handoff.check ? `${handoff.check.passed ? "passed" : "failed"}: ${handoff.check.command}` : undefined, reviews: handoff.reviewCount ?? 0,
    review: source?.base ? `git diff ${source.base}...${handoff.branch}` : undefined,
    // A merge brings the task's commits. It is only offered when the task started from a commit, not from uncommitted work.
    ...(source?.source === "head" && !source.unborn ? { merge: `git merge ${handoff.branch}` } : {}),
  } : undefined;
  const next = state === "working" ? `Still working. Keep helping the user; check again with codeflow_status {"runId":"${run.runId}","waitSeconds":25}, or run \`codeflow wait ${run.runId}\` as a background shell command.`
    : state === "needs_you" ? run.questions?.length ? `Ask the user the question, then send their choice with codeflow_steer_run {"runId":"${run.runId}","questionId":"${run.questions[0].id}","message":"<one of the options>"}.` : "This task waits for a step from a connected CLI session. That is part of the advanced flow; cancel it or see the Code Flow guide."
    : state === "paused" ? `Paused. Resume with codeflow_steer_run {"runId":"${run.runId}","action":"resume"}.`
    : state === "cancelled" ? "Cancelled. Completed work is preserved."
    : state === "finished" ? `Read ${result?.path ?? "the result"} and present it to the user in this turn.${delivery ? ` The changes are on branch ${delivery.branch}, not in the user's checkout. When the user wants them, call codeflow_apply {"runId":"${run.runId}"} for a dry run${delivery.merge ? `, or they can run \`${delivery.merge}\`` : ""}.` : ""} Say which checks ran; a finished task is not otherwise verified.`
    : `Stopped before completing. Read ${result?.path ?? "the status"} for the partial result and the reason, tell the user, and to continue call codeflow_run with continueFrom "${run.runId}".`;
  return {
    runId: run.runId, task: run.task, state, outcome: run.outcome, message: run.detail || run.error || run.progress?.message,
    active: run.progress?.active ?? [], questions: run.questions ?? [],
    ...(result ? { resultFile: result.path, summary: result.excerpt } : {}), ...(delivery ? { delivery } : {}),
    usage: run.usage ? {
      calls: run.usage.managedInvocations, callLimit: run.limits?.maxInvocations, minutes: Number(((run.usage.accountedExecutionMs ?? 0) / 60000).toFixed(1)), minuteLimit: run.limits?.maxMinutes,
      participants: (run.evidence?.participants ?? []).map((p: any) => ({ id: p.id, provider: p.provider, model: p.resolved?.model, effort: p.resolved?.effort, calls: (p.assignments ?? []).reduce((n: number, a: any) => n + (a.invocations ?? 0), 0) })),
    } : undefined,
    ...(run.workspace ? { workspace: run.workspace } : {}), next,
  };
}

/** A dry run of the handoff: the whole diff goes to a file; nothing in the checkout changes. */
export async function previewApply(call: Call, runId: string, nativeForm: boolean) {
  let cursor: number | undefined = 0, first: any, diff = "";
  do {
    const page: any = await call("codeflow_preview_handoff", { runId, cursor, maxBytes: 24000, ...(first ? { previewHash: first.previewHash } : {}) });
    first ??= page; diff += page.diff; cursor = page.nextCursor;
  } while (cursor !== undefined);
  const file = join(RESULTS_DIR, `${safeId(runId)}.diff`);
  if (diff) await atomic(file, diff);
  return {
    runId, ready: first.ready, reason: first.reason, summary: first.summary, branch: first.branch, previewHash: first.previewHash, ...(diff ? { diffFile: file } : {}),
    next: !first.ready ? `${first.reason} Nothing was changed.`
      : nativeForm ? `Nothing was changed. Read ${file} and show the user the summary. When they ask to apply, call codeflow_apply {"runId":"${runId}","previewHash":"${first.previewHash}"}; the user confirms in a form.`
      : `Nothing was changed. Read ${file} and show the user the summary. To apply, the user runs \`codeflow apply ${runId}\` in their own terminal.`,
  };
}

/** The simple tools, composed from the owner's operations. `call` is the bridge's approval-aware call. */
export async function simpleCall(call: Call, name: string, args: any, context: { host?: Provider; nativeForm: boolean }): Promise<any> {
  const issue = shapeProblem(spec(name).inputSchema, args);
  if (issue) invalid(issue);
  if (name === "codeflow_run") return proposeRecipe(call, args, context.host);
  if (name === "codeflow_status") {
    if (args.runId) return runStatus(call, args);
    const listed = await call("codeflow_list_runs", { limit: 20, ...(args.unfinishedOnly ? { unfinishedOnly: true } : {}) });
    return { runs: listed.runs, total: listed.total, next: listed.runs.length ? "Call codeflow_status with a runId for details and the result file." : "No Code Flow tasks in this repository yet. Start one with codeflow_run." };
  }
  if (name === "codeflow_steer_run") {
    if (args.message !== undefined || args.questionId !== undefined) invalid("Send either an action, or a message; not both in one call");
    return call("codeflow_control_run", { operationId: args.operationId, runId: args.runId, action: args.action });
  }
  if (name === "codeflow_apply") {
    if (!args.previewHash) return previewApply(call, args.runId, context.nativeForm);
    return call("codeflow_apply_handoff", { operationId: args.operationId ?? `apply-${args.previewHash}`, runId: args.runId, previewHash: args.previewHash });
  }
  if (name === "codeflow_providers") {
    if (!args.providerId) return call("codeflow_list_providers", args.refresh ? { refresh: true } : {});
    const models: any[] = []; let cursor: number | undefined = 0, page: any;
    do {
      page = await call("codeflow_list_models", { providerId: args.providerId, limit: 50, cursor, ...(args.antigravity ? { antigravity: args.antigravity } : {}), ...(args.refresh && cursor === 0 ? { refresh: true } : {}) });
      models.push(...page.models); cursor = page.nextCursor;
    } while (cursor !== undefined && models.length < 300);
    return { providerId: args.providerId, defaultModel: page.defaultModel, models };
  }
  throw new CliTeamError("unknown_tool", "Unknown Code Flow tool");
}

const roleLine = (r: any) => `${r.role}: ${r.provider}${r.model ? ` · ${r.model}` : ""}${r.effort ? ` · ${r.effort}` : ""}`;
export function formatStatusResult(d: any): string {
  if (d.runs) return [d.runs.length ? d.runs.map((r: any) => `${r.task} · ${r.outcome ?? r.status}\nRun: ${r.runId}`).join("\n\n") : "", d.next].filter(Boolean).join("\n\n");
  const labels: Record<RunState, string> = { working: "Working", needs_you: "Needs the user", paused: "Paused", finished: "Finished", stopped: "Stopped", cancelled: "Cancelled" };
  return [
    `${labels[d.state as RunState]}${d.outcome ? ` · ${String(d.outcome).replaceAll("_", " ")}` : ""} · run ${d.runId}`,
    d.task, d.message,
    ...d.active.map((s: any) => `Working: ${s.participant ? `${s.participant} · ` : ""}${s.title}`),
    ...d.questions.map((q: any) => `Question ${q.id}: ${q.question}\nOptions: ${q.options.join(" · ")}`),
    d.resultFile ? `Result file: ${d.resultFile}` : undefined,
    d.delivery ? [`Branch: ${d.delivery.branch}`, d.delivery.check ? `Check ${d.delivery.check}` : "No recorded check", `Independent reviews: ${d.delivery.reviews}`, d.delivery.review ? `Inspect: ${d.delivery.review}` : undefined].filter(Boolean).join("\n") : undefined,
    d.usage ? `Used ${d.usage.calls}/${d.usage.callLimit} agent calls, ${d.usage.minutes}/${d.usage.minuteLimit} minutes${d.usage.participants.length ? ` (${d.usage.participants.map((p: any) => `${p.id}: ${p.provider}${p.model ? ` ${p.model}` : ""}, ${p.calls} call${p.calls === 1 ? "" : "s"}`).join("; ")})` : ""}. Host usage is not observed.` : undefined,
    d.workspace?.url ? `Open in Code Flow: ${d.workspace.url}` : undefined,
    `Next: ${d.next}`,
  ].filter(Boolean).join("\n");
}
/** Text for the simple tools. Results from shared names (start, steer, control, apply with a hash) use the common formatter. */
export function formatSimple(name: string, d: any): string | undefined {
  if (name === "codeflow_run") return [
    d.workspace?.url ? `Open in Code Flow: ${d.workspace.url}` : undefined,
    d.summary,
    d.recipe.roles.length ? `Chosen team: ${d.recipe.roles.map(roleLine).join("; ")}` : undefined,
    ...d.recipe.notes.map((n: string) => `Note: ${n}`),
    `Proposal: ${d.proposalId} · revision: ${d.revision} · hash: ${d.proposalHash}`,
    `Next: ${d.nextAction}`,
  ].filter(Boolean).join("\n");
  if (name === "codeflow_status") return formatStatusResult(d);
  if (name === "codeflow_apply" && d.next) return [d.summary, d.previewHash ? `Preview hash: ${d.previewHash}` : undefined, d.diffFile ? `Diff file: ${d.diffFile}` : undefined, `Next: ${d.next}`].filter(Boolean).join("\n");
  if (name === "codeflow_providers" && d.models) return d.models.map((m: any) => `${m.id}${m.aliases?.length ? ` (${m.aliases.join(", ")})` : ""}${m.efforts?.length ? ` · efforts: ${m.efforts.join(", ")}` : ""}${m.id === d.defaultModel ? " · default" : ""}`).join("\n") || "No models reported. Sign in to that CLI, then try again with refresh.";
  return undefined;
}
