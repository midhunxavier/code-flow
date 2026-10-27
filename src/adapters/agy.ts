import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AGY_NATIVE_LIMITATION } from "../run-permissions.js";
import { join } from "node:path";
import { agyCredentialFailure, inspectAgyAuthLog } from "./agy-auth.js";
import type { AgentAdapter, AgentEvent, ErrorKind, ModelCatalog, RunOptions, RunResult } from "./types.js";
import { classifyError, cliErrorLine, resetFromText } from "./errors.js";
import { captureOutput, commandExists, describeFailure, processErrorKind, startJsonlProcess, stringify, truncate, unknownEvents } from "./process.js";
import { STEP_TIMEOUT_MS } from "../config.js";
import { childEnv } from "../env.js";
import { agyIsolationProblem, agyManagedOptionsProblem, inspectAgyIsolationRuntime, prepareAgyIsolation, discoverIsolatedAgyModels, AGY_FILE_ONLY_LIMITATION, AGY_SHARED_TOOLS_LIMITATION, AGY_VERIFIED_CLI_VERSIONS } from "./agy-isolation.js";
import { TEAM_TOOLS } from "../team-tools.js";
import { AGENT_TOOLS } from "../agent-tools.js";
import { prepareAgyNativeTools } from "./agy-tools.js";

/**
 * Google Antigravity CLI via `agy -p --output-format stream-json`.
 * Since 2026-06-18 this, not Gemini CLI, is the CLI that serves Google AI Pro/Ultra plans.
 * Uses the cached login from an interactive `agy` session.
 *
 * Managed execution uses a fresh, protected macOS executor and existing Keychain
 * authentication by default. Explicit agy-native-v1 run authority instead uses the normal
 * host profile without sandboxing. Task browser/computer tools use a short-lived HTTP MCP
 * capability in a private profile; no global MCP settings are edited. Both modes use portable turns.
 * Legacy execution behaviour (only when no managed run policy is supplied):
 *  - Headless mode cannot answer approval prompts. A denied tool does not let the agent
 *    carry on: the turn ends with an empty response. So by default every run uses
 *    --dangerously-skip-permissions together with --sandbox. This is NOT a verified workspace
 *    boundary: shared permission grants can widen it or permit unsandboxed commands.
 *    Read-only steps are checked by the engine, which reverts
 *    anything a read step changes. Set CODEFLOW_AGY_SKIP_PERMISSIONS=0 to rely on
 *    permissions.allow in ~/.gemini/antigravity-cli/settings.json instead.
 *    Full access (write steps only) drops --sandbox, so writes aren't confined either.
 *  - Older versions printed nothing when stdout is a pipe; that surfaces as a clear error.
 *  - There is no --cwd flag, so the process is started inside the target directory.
 */

// agy's --sandbox blocks reads of ~/.gitconfig and ~/.config/git/ignore, which makes every
// git command the agent runs fail. Point git at empty global config inside the worktree.
function sandboxGitEnv(): NodeJS.ProcessEnv {
  return {
    ...childEnv(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
}

function skipPermissions(): boolean {
  return process.env.CODEFLOW_AGY_SKIP_PERMISSIONS !== "0";
}

/** Dependency injection applies only to the isolated executor; native execution requires its own receipt. */
export function createAgyAdapter(prepare: (opts: RunOptions) => Promise<Awaited<ReturnType<typeof prepareAgyIsolation>>> = async opts =>
  prepareAgyIsolation(opts.cwd, opts.mode, await inspectAgyIsolationRuntime(), opts.agentTools, !!opts.jsonSchema, opts.teamTools)): AgentAdapter {
return {
  id: "agy",
  displayName: "Antigravity CLI",
  binary: "agy",
  available: () => commandExists("agy"),
  managedAvailability: agyIsolationProblem,
  managedLimitations: [AGY_SHARED_TOOLS_LIMITATION],
  async discoverModels(context) {
    if (context?.agentContainer) throw new Error("Antigravity container discovery is unverified");
    if (context?.isolatedAgy) return discoverIsolatedAgyModels();
    const catalog = await discoverNativeAgyModels();
    return { ...catalog, efforts: [], models: catalog.models.map(model => ({ ...model, efforts: undefined })), discovery: { source: "agy models", confidence: "reported", verifiedAt: Date.now() } };
  },

  async catalog(): Promise<ModelCatalog> {
    // `agy models` prints "<slug>\t<display name>" per model after a "Fetching…" line.
    const out = await captureOutput("agy", ["models"], 45_000);
    const models = out
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 2 && cols[0]!.trim())
      .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
    return { models, efforts: ["low", "medium", "high", "xhigh", "max"], allowCustom: true };
  },

  async run(opts: RunOptions, onEvent: (e: AgentEvent) => void): Promise<RunResult> {
    const native = opts.permissions?.implementation === "agy-native-v1";
    const managed = !!opts.permissions;
    let nativeScratch: string | undefined;
    let nativeTools: Awaited<ReturnType<typeof prepareAgyNativeTools>> | undefined;
    let isolation: Awaited<ReturnType<typeof prepareAgyIsolation>> | undefined;
    if (opts.permissions) {
      const problem = native ? agyNativeOptionsProblem(opts) : agyManagedOptionsProblem(opts);
      if (problem) return { ok: false, finalText: "", errorKind: "cli_incompatible", error: problem };
      if (opts.resumeSessionId) return { ok: false, finalText: "", errorKind: "session_not_found", error: "Managed Antigravity requires a fresh turn with portable context" };
      try { if (!native) isolation = await prepare(opts); }
      catch { return { ok: false, finalText: "", errorKind: "cli_incompatible", error: `Could not establish the verified Antigravity isolation boundary. macOS, CLI ${AGY_VERIFIED_CLI_VERSIONS.join(" or ")} and an existing Keychain login/security cache are required. No permissive fallback was used.` }; }
    }
    try {
    if (native) { nativeScratch = await mkdtemp(join(tmpdir(), "codeflow-agy-native-")); if (opts.agentTools || opts.teamTools) nativeTools = await prepareAgyNativeTools(opts.agentTools, undefined, opts.teamTools); onEvent({ kind: "status", text: AGY_NATIVE_LIMITATION }); }
    if (isolation) onEvent({ kind: "status", text: `${opts.agentTools ? AGY_SHARED_TOOLS_LIMITATION : AGY_FILE_ONLY_LIMITATION} Executor: ${opts.permissions?.implementation}; supported CLI ${AGY_VERIFIED_CLI_VERSIONS.join(" or ")}.` });
    if (opts.agentContainer) onEvent({ kind: "status", text: `Antigravity runs in Docker image ${opts.agentContainer.image}. Team messages and memory are provided at turn boundaries.` });
    if (opts.teamTools) onEvent({ kind: "status", text: isolation || native ? "Scoped codeflow_team tools connect this member to the live team mailbox and memory." : "Live member tools are unavailable in legacy Antigravity execution; use structured turn-boundary messages." });
    // A NaN or missing timeout must not become "--print-timeout NaNm".
    const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : STEP_TIMEOUT_MS;
    // Prompt as one stream-json message on stdin (-p would need it as an argument).
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", `${Math.max(1, Math.ceil((opts.isPaused ? Math.max(timeoutMs, 24 * 60 * 60_000) : timeoutMs) / 60_000))}m`,
    ];
    const sandboxed = !native && (!!isolation || !(opts.mode === "write" && opts.trust === "full"));
    if (sandboxed) args.push("--sandbox");
    if (opts.resumeSessionId) args.push("--conversation", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    const nativeLog = isolation || nativeScratch ? join(isolation?.paths.scratch ?? nativeScratch!, "native-auth.log") : undefined;
    if (isolation) args.push("--agent", "codeflow-isolated", "--disable-slash-commands", "--log-file", nativeLog!);
    else {
      if (nativeLog) args.push("--log-file", nativeLog);
      if (native || skipPermissions()) args.push("--dangerously-skip-permissions");
    }

    // Only a conversation agy confirms in this turn: a resume that failed must not hand back its id.
    let sessionId: string | undefined;
    let finalText = "";
    let streamedText = "";
    let resultError: string | undefined;
    /** What agy's result status says went wrong, when it says. */
    let statusKind: ErrorKind | undefined;
    let sawResult = false;
    let policyDrift = false;
    let policyTool = "";
    let deniedFile = false;
    let managedDiagnostic = "";
    let structured: unknown;
    const openTools = new Set<string>();
    const unknown = unknownEvents("agy");
    const unknownSteps = new Set<string>();

    const proc = startJsonlProcess({
      agentContainer: opts.agentContainer ? { config: opts.agentContainer, mode: opts.mode } : undefined,
      command: isolation?.command ?? "agy",
      args: [...(isolation?.args ?? []), ...args],
      input: `${JSON.stringify({ event: "user", message: { content: (isolation ? `Execution capabilities: You have source-file tools inside the assigned workspace ${opts.cwd}. Code Flow has already prepared the Git worktree and manages commits, integration and checks. Do not inspect .git files/directories, follow worktree metadata links, or inspect the parent repository or paths outside this workspace. Git metadata and shell are unavailable. ${opts.agentTools ? "For browser/computer tasks, use codeflow_agent MCP tools for the same Browser panel and computer tools the user and other providers use. Local file tasks do not need browser snapshots or action-history queries. Inspect the current browser tab before a browser action. Prefer browser tools for websites; fresh screenshots ground computer actions. For computer_action clicks, use coordinateSpace=normalized and Gemini coordinates from 0 to 1000 on each axis (500,500 is the center); do not send normalized positions as pixels." : "Browser and MCP access are unavailable in this profile."} If an unavailable capability is essential, report that limitation without attempting a workaround.\n\n` : opts.agentTools ? "For browser/computer tasks, use codeflow_agent MCP tools for the Browser panel shared with the user and teammates and for native computer interaction. Local file tasks do not need browser snapshots or action-history queries. Inspect the current browser before a browser action; do not create a separate browser session. Use a fresh computer_screenshot before each computer_action. For clicks use coordinateSpace=normalized with Gemini 0–1000 coordinates (500,500 is the center).\n\n" : "") + opts.prompt } })}\n`,
      cwd: isolation?.paths.workspace ?? opts.cwd,
      // Without the sandbox the agent's commands use your git config, but never code-flow's own secrets.
      env: isolation?.env ?? (nativeTools ? childEnv({ HOME: nativeTools.home }) : sandboxed ? sandboxGitEnv() : childEnv()),
      signal: opts.signal,
      timeoutMs: timeoutMs + 30_000,
      idleTimeoutMs: opts.idleTimeoutMs,
      isPaused: opts.isPaused,
      onText: (line) => {
        // Native login/refresh diagnostics may contain URLs, tokens or account details.
        if (managed) managedDiagnostic = (managedDiagnostic + "\n" + line).slice(-64000);
        else onEvent({ kind: "status", text: line });
      },
      onJson: (msg) => {
        if (policyDrift) return;
        switch (msg.event) {
          case "init":
            if (msg.conversation_id && !managed) {
              sessionId = msg.conversation_id;
              onEvent({ kind: "session", sessionId: msg.conversation_id });
            }
            break;

          case "step_update": {
            const step = msg.step_update ?? {};
            if (isolation && step.step_type === "tool" && step.tool_name && !managedAgyToolAllowed(step.tool_name, opts.mode, !!opts.agentTools, step.tool_info?.parameters, !!opts.teamTools)) {
              // Defense against runtime drift, not a substitute for provider/OS enforcement:
              // the stream can report a call after it began. Never forward its payload.
              policyDrift = true;
              policyTool = /^[\w.-]{1,100}$/.test(step.tool_name) ? step.tool_name : "unrecognized tool";
              proc.kill();
              return;
            }
            if (step.text_delta) {
              streamedText += step.text_delta;
              if (!managed) onEvent({ kind: "text", text: step.text_delta });
            }
            if (!step.text_delta && step.step_type !== "tool" && step.step_type !== "agent_response") {
              // A step code-flow shows nothing of; counted once per step, not per update.
              const id = `${step.conversation_id ?? ""}:${step.step_index ?? step.step_type}`;
              if (!unknownSteps.has(id)) {
                unknownSteps.add(id);
                unknown.add(`${step.step_type ?? "(no type)"} step`);
              }
            }
            if (step.step_type === "tool" && step.tool_name) {
              const callId = `${step.conversation_id ?? ""}:${step.step_index ?? step.tool_name}`;
              if (step.state === "ACTIVE" && !openTools.has(callId)) {
                openTools.add(callId);
                onEvent({
                  kind: "tool_call",
                  callId,
                  name: step.tool_name,
                  input: truncate(stringify(step.tool_info?.parameters ?? ""), 2_000),
                });
              } else if (step.state === "DONE" || step.state === "ERROR") {
                if (!openTools.has(callId)) {
                  onEvent({
                    kind: "tool_call",
                    callId,
                    name: step.tool_name,
                    input: truncate(stringify(step.tool_info?.parameters ?? ""), 2_000),
                  });
                }
                openTools.delete(callId);
                const error = step.tool_info?.error?.message;
                if (isolation && typeof error === "string" && /permission check failed|user denied permission/i.test(error)) deniedFile = true;
                onEvent({
                  kind: "tool_result",
                  callId,
                  output: truncate(error ?? stringify(step.tool_info?.output ?? step.tool_info?.result ?? "done")),
                  isError: step.state === "ERROR",
                });
              }
            }
            break;
          }

          case "result": {
            sawResult = true;
            proc.resultSeen();
            const result = msg.result ?? {};
            finalText = result.response ?? streamedText;
            if (result.conversation_id && !managed) sessionId = result.conversation_id;
            if (result.structured_output !== undefined) structured = normalizeAgyStructured(result.structured_output, opts.jsonSchema);
            if (result.status && result.status !== "SUCCESS") {
              const detail = typeof result.error === "string" ? result.error : result.error?.message;
              resultError = detail ? `${detail} (agy status ${result.status})` : `agy finished with status ${result.status}`;
              statusKind = agyStatusKind(String(result.status), detail, !!opts.resumeSessionId);
            } else if (!finalText.trim() && result.denied_actions?.length) {
              const denied = result.denied_actions.map((d: any) => d.display_name ?? d.action).join(", ");
              resultError = isolation ? "Isolated Antigravity denied a tool. Assign this task to a worker with the required tools." : `agy stopped after headless mode denied: ${denied}. Allow it in permissions.allow or enable CODEFLOW_AGY_SKIP_PERMISSIONS.`;
            }
            onEvent({
              kind: "usage",
              inputTokens: result.usage?.input_tokens,
              outputTokens: result.usage?.output_tokens,
              cacheReadTokens: result.usage?.cached_input_tokens ?? result.usage?.cache_read_input_tokens,
            });
            break;
          }

          case "user": // the prompt, if agy echoes it
            break;

          default:
            unknown.add(msg.event ?? msg.type);
        }
      },
    });

    const outcome = await proc.outcome;
    const authObservation = nativeLog ? await inspectAgyAuthLog(nativeLog) : undefined;
    // The CLI may complete inference after failing to persist a refreshed token. Surface
    // this as auth failure before accepting its result, without saving native diagnostics.
    if (managed && (authObservation?.credentialFailure || authObservation?.interactiveAuthObserved || agyCredentialFailure(outcome.stderr + "\n" + managedDiagnostic))) {
      resultError = "Native authentication could not be maintained in the recorded execution mode";
      statusKind = "auth";
    }
    const drift = unknown.report();
    if (drift && !managed) onEvent({ kind: "status", text: drift });

    if (policyDrift) {
      const error = `Antigravity reported ${policyTool} outside its verified task policy. The worker was stopped; runtime compatibility must be reverified.`;
      onEvent({ kind: "error", message: error });
      return { ok: false, finalText: "", errorKind: "cli_incompatible", error };
    }

    // After a successful result, how the process ended (a hang on shutdown, a non-zero exit) doesn't matter.
    if (sawResult && !resultError && !outcome.aborted) {
      if (managed && finalText) onEvent({ kind: "text", text: finalText });
      return { ok: true, finalText, sessionId, structured };
    }

    const stopped = processErrorKind(outcome);
    if (!sawResult && outcome.exitCode === 0 && !stopped) {
      resultError =
        "agy exited without a result event. Some agy versions print nothing when stdout is a pipe; " +
        "update agy, and make sure you have logged in once with an interactive `agy` session.";
    }
    let error = resultError ?? describeFailure("agy", outcome);
    // agy's status first, then its own error text: its result's, or its own line on stderr, never
    // the rest of stderr (hooks and MCP servers print there too).
    const own = resultError ?? cliErrorLine(outcome.stderr + (managed ? "\n" + managedDiagnostic : ""));
    const authKind = managed ? managedAgyAuthKind(sawResult ? resultError ?? "" : outcome.stderr + "\n" + managedDiagnostic) ?? (statusKind === "auth" ? "auth" : undefined) : undefined;
    // A login prompt followed by a watchdog expiry must not trigger transient retries.
    // Explicit cancellation still wins over any earlier authentication diagnostic.
    const errorKind: ErrorKind = stopped === "cancelled" ? stopped : authKind ?? stopped ?? statusKind ?? classifyError(own);
    if (managed) error = native ? nativeAgyFailure(errorKind) : managedAgyFailure(errorKind);
    if (isolation && deniedFile && errorKind === "other") error = "Antigravity requested a file outside its permitted source-file scope. The turn stopped with its permissions intact. Code Flow handles Git metadata and checks; continue with source files in the assigned workspace or select another team provider.";
    const resetsAt = errorKind === "usage_limit" ? resetFromText(own) : undefined;
    onEvent({ kind: "error", message: error });
    return {
      ok: false,
      finalText: managed ? "" : finalText || streamedText,
      sessionId: errorKind === "session_not_found" ? undefined : sessionId,
      error,
      errorKind,
      ...(resetsAt && { resetsAt }),
    };
    } finally { await isolation?.cleanup(); await nativeTools?.cleanup(); if (nativeScratch) await rm(nativeScratch, { recursive: true, force: true }); }
  },
};
}
export const agyAdapter = createAgyAdapter();

/** CLI structured completion adds two presentation fields to the finish payload. */
export function normalizeAgyStructured(value: unknown, schema?: object): unknown {
  if (!schema || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value } as Record<string, unknown>;
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const name of ["toolAction", "toolSummary"]) if (!Object.hasOwn(properties, name)) delete result[name];
  return result;
}

export function managedAgyToolAllowed(name: string, mode: "read" | "write", sharedTools = false, parameters?: unknown, teamTools = false): boolean {
  // Resource discovery is read-only; the isolated profile contains only our server.
  if ((sharedTools || teamTools) && name === "list_resources") return true;
  if (sharedTools && AGENT_TOOLS.some(tool => name === `mcp_codeflow_agent_${tool.name}`)) return true;
  if (teamTools && TEAM_TOOLS.some(tool => name === `mcp_codeflow_team_${tool.name}`)) return true;
  if ((sharedTools || teamTools) && name === "call_mcp_tool") {
    const p = parameters as Record<string, unknown> | undefined;
    return sharedTools && p?.ServerName === "codeflow_agent" && AGENT_TOOLS.some(tool => tool.name === p.ToolName) || teamTools && p?.ServerName === "codeflow_team" && TEAM_TOOLS.some(tool => tool.name === p.ToolName);
  }
  // CLI 1.4.4 exposes manage_task for the fresh process's own tasks, but cannot create them.
  return ["view_file", "list_dir", "manage_task", "finish", ...(mode === "write" ? ["write_to_file", "replace_file_content"] : [])].includes(name);
}

export function managedAgyAuthKind(detail: string): "auth" | undefined {
  return /authentication (?:failed|timed out)|please (?:sign|log) in|invalid_grant|(?:refresh|access)[ _-]?token.{0,80}(?:expired|revoked|invalid|failed)|(?:failed|unable) to (?:retrieve|refresh).{0,40}token|(?:keyring|keychain).{0,80}(?:locked|denied|unavailable)|interaction (?:is )?not allowed/i.test(detail) || agyCredentialFailure(detail) || classifyError(detail) === "auth" ? "auth" : undefined;
}

function managedAgyFailure(kind: ErrorKind): string {
  if (kind === "auth") return "Antigravity could not use or refresh the existing native login. Check or unlock it in Antigravity's normal interactive session, then resume. Code Flow will start a fresh isolated turn; permissions were not widened.";
  if (kind === "usage_limit" || kind === "rate_limit") return `Isolated Antigravity reached a ${kind === "usage_limit" ? "usage" : "rate"} limit.`;
  return `Isolated Antigravity failed (${kind}). Native diagnostics were withheld because they can contain authentication data. Check the CLI in its normal interactive session before resuming; no permissive fallback was used.`;
}

/** Native diagnostics stay withheld; the advice follows the failure's kind, and the engine retries rate limits and outages itself. */
export function nativeAgyFailure(kind: ErrorKind): string {
  if (kind === "auth") return "Unrestricted Antigravity could not use the existing login. Check the login in its normal session, then resume. Code Flow never starts sign-in or changes credentials; native diagnostics are withheld.";
  if (kind === "rate_limit") return "Unrestricted Antigravity hit a rate limit (too many requests in a short time). If automatic retries have ended, wait before resuming.";
  if (kind === "usage_limit") return "Unrestricted Antigravity reached its plan's usage limit. Resume after it resets.";
  if (kind === "transient") return "The Antigravity service was temporarily unavailable. If automatic retries have ended, resume when the service recovers.";
  if (kind === "timeout") return "The unrestricted Antigravity turn ran out of time.";
  if (kind === "cancelled") return "The unrestricted Antigravity turn was stopped.";
  return `Unrestricted Antigravity failed (${kind}). Native diagnostics are withheld because they can contain authentication data; check the CLI in its normal session before resuming.`;
}

/**
 * agy's result status (gRPC-style codes, e.g. RESOURCE_EXHAUSTED) when it names a kind. Google
 * answers a per-minute 429 with RESOURCE_EXHAUSTED too, so that's a rate limit (retried) unless
 * its message says the plan's or the day's quota is used up: a usage limit stops the run and keeps
 * Auto away from agy until it resets.
 */
function agyStatusKind(status: string, detail: string | undefined, resuming: boolean): ErrorKind | undefined {
  if (/RESOURCE_EXHAUSTED|QUOTA/i.test(status)) {
    const text = detail ?? "";
    if (/\bper (?:minute|second|min\b)|\brate\b/i.test(text)) return "rate_limit";
    return /daily|per day|\bplan\b|usage limit|quota (?:exceeded|reached|exhausted)|exceeded (?:your|the) [\w -]{0,30}quota/i.test(text) ? "usage_limit" : "rate_limit";
  }
  if (/RATE/i.test(status)) return "rate_limit";
  if (/UNAUTHENTICATED|AUTH|LOGIN|SIGN_?IN/i.test(status)) return "auth";
  // Only the conversation can be missing when resuming (a missing model is a NOT_FOUND too).
  if (resuming && /NOT_FOUND/i.test(status)) return "session_not_found";
  if (/UNAVAILABLE|INTERNAL|OVERLOAD/i.test(status)) return "transient";
  if (/DEADLINE|TIMEOUT/i.test(status)) return "timeout";
  if (/CANCEL/i.test(status)) return "cancelled";
  return undefined;
}

/** The receipt must explicitly describe unrestricted execution; ordinary Full trust is insufficient. */
export function agyNativeOptionsProblem(opts: RunOptions): string | undefined {
  const p = opts.permissions;
  if (!p || p.provider !== "agy" || p.implementation !== "agy-native-v1" || p.isolation !== "none" || p.nativeDelegation !== true || p.commandNetwork !== "allowed" || p.externalTools !== "provider-configured" || p.trust !== "full" || opts.trust !== "full" || p.mode !== opts.mode || !["read", "write"].includes(p.mode) || !["managed", "none"].includes(p.delegation) || p.toolApprovals !== false || opts.interactiveApprovals || !Array.isArray(p.required) || p.required.length || !Number.isSafeInteger(p.policyRevision) || p.policyRevision < 1 || opts.agentContainer) return "Antigravity options do not match an explicit unrestricted permission receipt";
}

/** Existing native profile; no token export or sign-in command. Private refresh diagnostics
 * must be checked before recovery treats a successful model listing as login evidence. */
async function discoverNativeAgyModels(): Promise<ModelCatalog> {
  const scratch = await mkdtemp(join(tmpdir(), "codeflow-agy-models-"));
  try {
    const log = join(scratch, "native-auth.log");
    const output = await captureOutput("agy", ["--log-file", log, "models"], 45000);
    const auth = await inspectAgyAuthLog(log);
    if (auth.credentialFailure || auth.interactiveAuthObserved || agyCredentialFailure(output) || managedAgyAuthKind(output)) throw new Error("Native login unavailable");
    const models = output.split("\n").map(line => line.split("\t")).filter(cols => cols.length >= 2 && cols[0]!.trim()).map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
    if (!models.length) throw new Error("No models");
    return { models, efforts: [], allowCustom: false };
  } catch { throw new Error("Antigravity model discovery could not verify the existing native login"); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
