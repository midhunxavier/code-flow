import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJsonlProcess, commandExists, describeFailure, processErrorKind, stringify, truncate } from "./process.js";
import type { AgentAdapter, AgentEvent, ErrorKind, ModelCatalog, RunOptions, RunResult } from "./types.js";
import type { AcpConnection, AcpProbe } from "./acp-types.js";

const object = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4000;
class AcpError extends Error {
  constructor(message: string, readonly kind: ErrorKind = "cli_incompatible", readonly code?: number) { super(message); }
}

/** ACP v1 over stdio. No host filesystem/terminal capabilities are advertised. */
class AcpClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private stopped?: Error;
  private lifetime = new AbortController();
  private cancelTimer?: NodeJS.Timeout;
  private approvalCount = 0;
  private permissionIds = new Set<string | number>();
  private permissionTasks = new Set<Promise<void>>();
  private toolDetails = new Map<string, Record<string, any>>();
  sessionId?: string;
  prompting = false;
  readonly proc;
  constructor(readonly connection: AcpConnection, readonly opts: RunOptions, readonly onUpdate: (update: any) => void) {
    this.proc = startJsonlProcess({
      command: connection.command, args: connection.args, cwd: opts.cwd, interactive: true,
      timeoutMs: opts.timeoutMs, idleTimeoutMs: opts.idleTimeoutMs, resultGraceMs: 1000,
      onJson: (message) => { try { this.receive(message); } catch (error) { this.fail(error as Error); this.proc.kill(); } },
      onText: () => { this.fail(new AcpError("The CLI wrote invalid ACP data to stdout. Configure its ACP subcommand; logs must go to stderr.")); this.proc.kill(); },
    });
    void this.proc.outcome.then((outcome) => {
      this.fail(new AcpError(describeFailure(connection.name, outcome), processErrorKind(outcome) ?? "other"));
    });
    opts.signal?.addEventListener("abort", this.cancel, { once: true });
    if (opts.signal?.aborted) this.cancel();
  }
  private fail(error: Error) {
    this.stopped ??= error;
    this.lifetime.abort();
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(this.stopped); }
    this.pending.clear();
  }
  private cancel = () => {
    if (this.sessionId) this.proc.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.fail(new AcpError("ACP turn was cancelled", "cancelled"));
    this.cancelTimer = setTimeout(() => this.proc.kill(), 1000);
    this.cancelTimer.unref();
  };
  request(method: string, params: object, timeoutMs = 20_000): Promise<any> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`ACP ${method} did not respond in time`, "timeout"));
      }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc.send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer); this.pending.delete(id); reject(new AcpError("ACP process closed its input", "other"));
      }
    });
  }
  private receive(message: any) {
    if (!object(message) || message.jsonrpc !== "2.0") throw new AcpError("The CLI did not return ACP JSON-RPC 2.0 messages");
    if (message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (object(message.error)) waiter.reject(new AcpError(truncate(String(message.error.message ?? "ACP request failed")), message.error.code === -32000 ? "auth" : message.error.code === -32002 ? "session_not_found" : [-32601, -32602].includes(message.error.code) ? "cli_incompatible" : "other", message.error.code));
      else if (object(message.result)) waiter.resolve(message.result);
      else waiter.reject(new AcpError("ACP response is missing its result"));
      return;
    }
    if (message.id !== undefined) {
      if (!(typeof message.id === "number" || typeof message.id === "string")) throw new AcpError("Invalid ACP request ID");
      if (message.method === "session/request_permission") {
        if (this.permissionIds.has(message.id) || this.permissionIds.size >= 16) throw new AcpError("Too many or duplicate ACP permission requests");
        this.permissionIds.add(message.id);
        const task = this.permission(message).finally(() => { this.permissionIds.delete(message.id); this.permissionTasks.delete(task); });
        this.permissionTasks.add(task);
      } else this.proc.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability is not supported" } });
    } else if (message.method === "session/update" && this.prompting && message.params?.sessionId === this.sessionId && object(message.params.update)) {
      const update = message.params.update;
      if (["tool_call", "tool_call_update"].includes(update.sessionUpdate) && string(update.toolCallId)) {
        if (!this.toolDetails.has(update.toolCallId) && this.toolDetails.size >= 2000) throw new AcpError("ACP turn exceeds the tool call limit");
        const previous = this.toolDetails.get(update.toolCallId) ?? {};
        this.toolDetails.set(update.toolCallId, {
          ...previous, toolCallId: update.toolCallId,
          ...(typeof update.kind === "string" ? { kind: update.kind } : {}),
          ...(typeof update.title === "string" ? { title: truncate(update.title, 1000) } : {}),
          ...(Array.isArray(update.locations) ? { locations: update.locations.slice(0, 50).filter((item: any) => string(item?.path)).map((item: any) => ({ path: item.path })) } : {}),
          ...(update.rawInput !== undefined ? { rawInput: { description: truncate(stringify(update.rawInput)), ...(typeof update.rawInput?.command === "string" ? { command: truncate(update.rawInput.command) } : {}) } } : {}),
        });
      }
      this.onUpdate(update);
    }
  }
  private async permission(message: any) {
    const params = message.params;
    const tool = object(params?.toolCall) ? { ...this.toolDetails.get(params.toolCall.toolCallId), ...params.toolCall } : undefined;
    let optionId: string | undefined;
    const options = Array.isArray(params?.options) ? params.options : [];
    const once = (kind: string) => options.find((option: any) => option?.kind === kind && string(option.optionId))?.optionId;
    const eligible = this.prompting && params?.sessionId === this.sessionId && object(tool) && string(tool.toolCallId);
    // ACP's tool kind is a display hint, not a security boundary. Headless requests are denied.
    // In read turns, never approve actions that could change files or run arbitrary commands.
    const canAsk = eligible && (this.opts.mode === "write" || ["read", "search", "think"].includes(tool.kind));
    const controller = new AbortController();
    let waiting = false;
    const abort = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    if (this.lifetime.signal.aborted) controller.abort();
    const timer = setTimeout(abort, 120_000); timer.unref();
    try {
      if (canAsk && once("allow_once") && this.opts.interactiveApprovals && this.opts.onApproval && !controller.signal.aborted) {
        waiting = true; this.approvalCount++; this.proc.pauseIdle(true);
        const paths = Array.isArray(tool.locations) ? tool.locations.slice(0, 50).map((location: any) => location?.path).filter(string) : [];
        const request = { id: `acp:${String(message.id)}`, kind: (["edit", "delete", "move"].includes(tool.kind) ? "file-change" : "command") as "file-change" | "command", paths, cwd: this.opts.cwd,
          command: typeof tool.rawInput?.command === "string" ? truncate(tool.rawInput.command) : truncate(stringify(tool.rawInput ?? tool.title ?? tool.kind)), reason: truncate(String(tool.title ?? "ACP tool request")) };
        const decision = await Promise.race([
          this.opts.onApproval(request, controller.signal),
          new Promise<"decline">((resolve) => { if (controller.signal.aborted) resolve("decline"); else controller.signal.addEventListener("abort", () => resolve("decline"), { once: true }); }),
        ]);
        if (decision === "approve" && !controller.signal.aborted) optionId = once("allow_once");
      }
    } catch { /* A failed approval never grants permission. */ }
    finally {
      clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); controller.abort();
      if (waiting) { this.approvalCount--; if (!this.approvalCount) this.proc.pauseIdle(false); }
      optionId ??= once("reject_once");
      this.proc.send({ jsonrpc: "2.0", id: message.id, result: { outcome: this.lifetime.signal.aborted || !optionId ? { outcome: "cancelled" } : { outcome: "selected", optionId } } });
    }
  }
  async initialize() {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "code-flow", version: "0.1.0" } });
    if (init.protocolVersion !== 1) throw new AcpError(`Unsupported ACP protocol version: ${String(init.protocolVersion)}; code-flow supports v1`);
    return init;
  }
  async session(init: any) {
    const params = { cwd: this.opts.cwd, mcpServers: [] };
    let session;
    if (this.opts.resumeSessionId) {
      if (init.agentCapabilities?.loadSession !== true) throw new AcpError("This ACP agent cannot load previous sessions", "session_not_found");
      // Replay notifications from session/load are deliberately ignored before prompting.
      session = await this.request("session/load", { ...params, sessionId: this.opts.resumeSessionId });
      this.sessionId = this.opts.resumeSessionId;
    } else {
      session = await this.request("session/new", params);
      if (!string(session.sessionId)) throw new AcpError("ACP session/new returned no valid session ID");
      this.sessionId = session.sessionId;
    }
    return session;
  }
  async close() {
    this.opts.signal?.removeEventListener("abort", this.cancel);
    clearTimeout(this.cancelTimer);
    this.lifetime.abort();
    // Permission replies must drain before stdin closes, including cancellation outcomes.
    await Promise.allSettled([...this.permissionTasks]);
    this.proc.resultSeen(); this.proc.endInput();
    await this.proc.outcome;
  }
}

function configOption(session: any, category: string) {
  return Array.isArray(session?.configOptions) ? session.configOptions.find((option: any) => option?.type === "select" && option.category === category && string(option.id)) : undefined;
}
function choices(option: any): { id: string; label: string }[] {
  const flat = Array.isArray(option?.options) ? option.options.flatMap((item: any) => Array.isArray(item?.options) ? item.options : [item]) : [];
  return flat.filter((item: any) => string(item?.value) && string(item?.name)).slice(0, 1000).map((item: any) => ({ id: item.value, label: item.name }));
}
export function acpCatalog(session: any): ModelCatalog {
  const model = configOption(session, "model"), effort = configOption(session, "thought_level");
  const models = model ? choices(model) : Array.isArray(session?.models?.availableModels) ? session.models.availableModels.filter((item: any) => string(item?.modelId) && string(item?.name)).slice(0, 1000).map((item: any) => ({ id: item.modelId, label: item.name })) : [];
  const defaultModel = model?.currentValue ?? session?.models?.currentModelId;
  return { models, efforts: choices(effort).map((item) => item.id), allowCustom: false,
    defaultModel: string(defaultModel) ? defaultModel : undefined, defaultEffort: string(effort?.currentValue) ? effort.currentValue : undefined };
}
export async function probeAcp(connection: AcpConnection): Promise<AcpProbe> {
  const cwd = await mkdtemp(join(tmpdir(), "codeflow-acp-probe-"));
  let client: AcpClient | undefined;
  try {
    client = new AcpClient(connection, { cwd, prompt: "", mode: "read", timeoutMs: 30_000 }, () => {});
    const init = await client.initialize(), session = await client.session(init);
    return { protocolVersion: 1, agent: string(init.agentInfo?.title) ? init.agentInfo.title : string(init.agentInfo?.name) ? init.agentInfo.name : connection.name,
      version: string(init.agentInfo?.version) ? init.agentInfo.version : undefined, sessionResume: init.agentCapabilities?.loadSession === true, catalog: acpCatalog(session) };
  } finally { await client?.close(); await rm(cwd, { recursive: true, force: true }); }
}

export function createAcpAdapter(connection: AcpConnection): AgentAdapter {
  const saved = structuredClone(connection);
  return { id: saved.id, displayName: saved.name, binary: saved.command,
    available: () => commandExists(saved.command), catalog: async () => (await probeAcp(saved)).catalog,
    run: (opts, event) => runAcp(saved, opts, event) };
}
export async function runAcp(connection: AcpConnection, opts: RunOptions, event: (event: AgentEvent) => void): Promise<RunResult> {
  if (opts.signal?.aborted) return { ok: false, finalText: "", error: "ACP turn was cancelled", errorKind: "cancelled" };
  if (opts.agentContainer || opts.trust !== "full") return { ok: false, finalText: "", error: "ACP connections require Full access on the current host; sandbox and container profiles are not supported", errorKind: "cli_incompatible" };
  let finalText = "", client: AcpClient | undefined;
  const calls = new Map<string, { name: string; input: string; output: string }>(), finished = new Set<string>();
  try {
    client = new AcpClient(connection, opts, (update) => {
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
        if (update.content?.type !== "text" || typeof update.content.text !== "string") return;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (finalText.length + update.content.text.length > 4 * 1024 * 1024) throw new AcpError("ACP answer exceeds the 4 MiB limit");
          finalText += update.content.text; event({ kind: "text", text: update.content.text });
        } else event({ kind: "thinking", text: update.content.text });
      } else if (["tool_call", "tool_call_update"].includes(update.sessionUpdate) && string(update.toolCallId)) {
        const previous = calls.get(update.toolCallId);
        if (!previous && calls.size >= 2000) throw new AcpError("ACP turn exceeds the tool call limit");
        const name = String(update.title ?? previous?.name ?? update.kind ?? "Tool");
        const input = update.rawInput !== undefined ? truncate(stringify(update.rawInput), 16_000) : previous?.input ?? "{}";
        if (!previous || previous.name !== name || previous.input !== input) {
          // OpenCode can announce a tool before its command/path is available.
          event({ kind: "tool_call", callId: update.toolCallId, name, input });
        }
        const text = Array.isArray(update.content) ? update.content.map((item: any) => item.type === "content" && item.content?.type === "text" ? item.content.text : item.type === "diff" ? `${item.path}\n${item.newText ?? ""}` : "").join("\n") : undefined;
        const output = truncate(text ?? (update.rawOutput !== undefined ? stringify(update.rawOutput) : previous?.output ?? ""), 32_000);
        calls.set(update.toolCallId, { name, input, output });
        if (["completed", "failed"].includes(update.status) && !finished.has(update.toolCallId)) {
          finished.add(update.toolCallId);
          event({ kind: "tool_result", callId: update.toolCallId, output, isError: update.status === "failed" });
        }
      }
      // usage_update.used is context occupancy, not billable turn usage. Never count it as tokens.
    });
    const init = await client.initialize();
    let session = await client.session(init);
    event({ kind: "session", sessionId: client.sessionId! });
    for (const [category, value] of [["model", opts.model], ["thought_level", opts.effort]] as const) {
      if (!value) continue;
      const option = configOption(session, category);
      if (option) {
        if (!choices(option).some((item) => item.id === value)) throw new AcpError(`ACP agent does not advertise ${category} ${value}`);
        session = { ...session, ...await client.request("session/set_config_option", { sessionId: client.sessionId, configId: option.id, value }) };
      } else if (category === "model" && acpCatalog(session).models.some((model) => model.id === value)) {
        await client.request("session/set_model", { sessionId: client.sessionId, modelId: value });
      } else throw new AcpError(`This ACP agent does not support selecting ${category}`);
    }
    const prompt = `${opts.mode === "read" ? "This is a read-only task. Do not edit files or run commands that change the repository.\n\n" : ""}${opts.prompt}${opts.jsonSchema ? `\n\nReturn your final answer as JSON matching this schema:\n${JSON.stringify(opts.jsonSchema)}` : ""}`;
    client.prompting = true;
    const result = await client.request("session/prompt", { sessionId: client.sessionId, prompt: [{ type: "text", text: prompt }] }, 0);
    client.prompting = false;
    if (opts.signal?.aborted || result.stopReason === "cancelled") throw new AcpError("ACP turn was cancelled", "cancelled");
    if (result.stopReason !== "end_turn") throw new AcpError(`ACP turn stopped: ${String(result.stopReason ?? "missing stop reason")}`, "other");
    return { ok: true, finalText, sessionId: client.sessionId };
  } catch (error) {
    const failure = error as Error;
    return { ok: false, finalText, sessionId: client?.sessionId, error: failure.message, errorKind: opts.signal?.aborted ? "cancelled" : error instanceof AcpError ? error.kind : "other" };
  } finally { await client?.close(); }
}
