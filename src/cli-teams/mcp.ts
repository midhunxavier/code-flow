import { CLI_TOOLS, HOST_TOOLS } from "./tools.js";
import { guideText, startupInstructions, type GuideSection } from "./guide.js";
import { shapeProblem } from "./model.js";
import { CliTeamError } from "./model.js";
import { connectRuntime } from "./client.js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CLI_MESSAGE_BYTES } from "./limits.js";
import { realpath } from "node:fs/promises";
import { repoRoot } from "../git.js";
import { formatToolResult } from "./presentation.js";
import { hasProjectInstall, installUser } from "./install.js";
import { advertisedTools, formatSimple, isSimpleCall, runState, simpleCall, toolSurface, type Call } from "./simple.js";
import { hostProvider } from "./recipes.js";
import { recordMetric } from "./metrics.js";
import type { Provider } from "./model.js";

/** This release's version, so hosts and `claude mcp` show which Code Flow answers. */
const VERSION = (() => { try { return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version); } catch { return "0.0.0"; } })();

/**
 * With no explicit --project-root, the connection works on the Git repository the CLI was started in.
 * Registered once per user, it also starts outside repositories; there it explains instead of failing to start.
 */
export async function serveMcp(projectRoot: string, explicit = true) {
  const found = await repoRoot(projectRoot).then(root => realpath(root)).catch(error => { if (explicit) throw error; return undefined; });
  if (!found) return serveOutsideRepository(projectRoot);
  projectRoot = found;
  const surface = await toolSurface(), session = randomBytes(8).toString("hex");
  let host: Provider | undefined, hostName: string | undefined, hostVersion: string | undefined;
  const client = await connectRuntime(projectRoot, true, "mcp");
  const heartbeat = setInterval(() => { void client.heartbeat().catch(() => undefined); }, 10000).unref();
  const prompts = new Map<string, { parent: string | number; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const cancelPrompts = (message: string, parent?: string | number) => {
    for (const [id, pending] of prompts) if (parent === undefined || pending.parent === parent) {
      prompts.delete(id); clearTimeout(pending.timer);
      pending.reject(new CliTeamError("acceptance_cancelled", message));
    }
  };
  const stop = () => { cancelPrompts("Host disconnected; no approval was recorded"); void client.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let initialized = false, nativeForm = false, inflight = 0;
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const approveInHost = async (parent: string | number, args: any, handoff = false) => {
    const preview = await client.privileged(handoff ? "/handoff-preview" : "/preview", { projectRoot, runId: args.runId, proposalId: args.proposalId, revision: args.expectedRevision });
    if ((handoff ? preview.previewHash : preview.hash) !== (handoff ? args.previewHash : args.proposalHash)) throw new CliTeamError("acceptance_stale", "The preview changed; inspect it again before confirming.");
    // The user may approve here or read the full plan in the browser and press Start there.
    // Both approve the same proposal revision, so exactly one run starts either way.
    const link: { url?: string; ticket?: string } = handoff ? {} : await client.privileged("/approval-link", { projectRoot, proposalId: args.proposalId, revision: args.expectedRevision }).catch(() => ({}));
    let watcher: ReturnType<typeof setInterval> | undefined;
    const result = await new Promise<any>((resolve, reject) => {
      const id = `codeflow-approval-${randomBytes(16).toString("hex")}`;
      const settle = (value: any) => { if (!prompts.has(id)) return; const pending = prompts.get(id)!; prompts.delete(id); clearTimeout(pending.timer); pending.resolve(value); };
      const timer = setTimeout(() => { prompts.delete(id); reject(new CliTeamError("acceptance_cancelled", handoff ? "This confirmation timed out; this request did not apply the changes. Review the task before requesting apply again." : `This confirmation timed out without starting work. Check the shared task; if it has not started, request a fresh approval link or run \`codeflow open ${args.proposalId}\` in a terminal.`)); }, 5 * 60_000);
      prompts.set(id, { parent, resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method: "elicitation/create", params: {
        mode: "form", message: handoff ? `Apply these task changes to your checkout?\n\n${preview.summary}\n\nAccept stages the changes (no commit or push). Decline changes nothing.` : [
          // Claude Code shows about three lines before "+N more lines": lead with the decision.
          preview.headline ?? "Start this Code Flow task?",
          link.url ? "Accept starts it here. Or open the approval link, sign in if needed, and press Start:" : "Accept starts it. Decline starts nothing.",
          // The approval link never signs anyone in; an owner session is required.
          link.url ?? `Details: run \`codeflow open ${args.proposalId}\` in a terminal`,
          "", preview.card ?? preview.preview,
          "", "Decline starts nothing.",
        ].join("\n"),
        // Accept is the approval: the answer comes from the host's own form, never from the model.
        // The field is pre-ticked for hosts that need one; unticking it declines.
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: handoff ? "Apply these changes" : "Start this task", default: true } } },
      } });
      if (link.url) watcher = setInterval(() => {
        void client.privileged("/approval-state", { projectRoot, proposalId: args.proposalId, revision: args.expectedRevision }).then((state: any) => {
          if (!state.accepted || !prompts.has(id)) return;
          // Started in the browser: close this dialog and continue with the same run.
          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Started in Code Flow" } });
          settle({ action: "accept", elsewhere: true });
        }).catch(() => undefined);
      }, 1500);
    }).finally(() => {
      if (watcher) clearInterval(watcher);
      if (link.ticket) void client.privileged("/approval-revoke", { projectRoot, ticket: link.ticket }).catch(() => undefined);
    });
    if (result?.elsewhere) return;
    if (result?.action !== "accept" || result.content?.approve === false) throw new CliTeamError(result?.action === "cancel" ? "acceptance_cancelled" : "acceptance_declined", handoff ? "Application was not approved; the checkout was not changed by this request." : "This confirmation did not approve or start work. Check the shared task if it was started elsewhere; otherwise revise it or request start again when ready.");
    // The reply is a server-request response from the native host, never a tool argument
    // supplied by the model. The owner rechecks the exact revision/hash atomically.
    await client.privileged(handoff ? "/handoff-confirm" : "/confirm", { projectRoot, runId: args.runId, previewHash: args.previewHash, proposalId: args.proposalId, revision: args.expectedRevision, hash: preview.hash });
  };
  const request = async (m: any) => {
    const validId = (v: unknown) => typeof v === "string" || typeof v === "number" && Number.isFinite(v);
    if (!m || Array.isArray(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string" || m.id !== undefined && !validId(m.id)) { rpcError(null, -32600, "Invalid request"); return; }
    if (m.id === undefined) return;
    if (inflight >= 4) { rpcError(m.id, -32000, "At most four concurrent requests"); return; }
    inflight++;
    try {
      let result: unknown;
      if (m.method === "initialize") {
        if (initialized) { rpcError(m.id, -32600, "Already initialized"); return; }
        initialized = true;
        const elicitation = m.params?.capabilities?.elicitation;
        nativeForm = !!elicitation && typeof elicitation === "object" && !Array.isArray(elicitation) && (Object.hasOwn(elicitation, "form") || Object.keys(elicitation).length === 0);
        const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
        const info = m.params?.clientInfo;
        if (typeof info?.name === "string") hostName = info.name.slice(0, 80);
        if (typeof info?.version === "string") hostVersion = info.version.slice(0, 40);
        host = hostProvider(hostName ?? "");
        result = { protocolVersion: versions.includes(m.params?.protocolVersion) ? m.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "code-flow", version: VERSION }, instructions: await startupInstructions(projectRoot, nativeForm, surface) };
      } else if (m.method === "ping") result = {};
      else if (!initialized) { rpcError(m.id, -32000, "Initialize first"); return; }
      else if (m.method === "tools/list") result = { tools: advertisedTools(surface, [...CLI_TOOLS, ...HOST_TOOLS]) };
      else if (m.method === "tools/call") {
        let value: any, error = false, text: string | undefined;
        const name = m.params?.name, args = m.params?.arguments ?? {}, began = Date.now();
        // One advanced operation, with native approval where it applies and the host-side additions to its result.
        const advanced: Call = async (name, args: any = {}) => {
          let data: any;
          const hostTool = HOST_TOOLS.find(t => t.name === name);
          if (hostTool) {
            const issue = shapeProblem(hostTool.inputSchema, args);
            if (issue) throw new CliTeamError("validation_failed", issue);
            data = { section: args.section, guide: await guideText(args.section as GuideSection) };
          } else try { data = await client.call(name, args); }
          catch (e) {
            if (!["codeflow_start_run", "codeflow_apply_handoff"].includes(name) || !nativeForm || !(e instanceof CliTeamError) || e.code !== "acceptance_required") throw e;
            await approveInHost(m.id, args, name === "codeflow_apply_handoff"); data = await client.call(name, args);
          }
          if (name === "codeflow_propose_run") data = { ...data, approvalMethod: nativeForm ? "native_form" : data.workspace ? "browser" : "terminal", ...(nativeForm ? { nextAction: "Paste the proposal card above into your reply word for word, with the Open in Code Flow link, before any other tool call. The approval form shows only its first lines, so your reply is where the user reads the plan. Then call codeflow_start_run with its ID, revision and hash; Code Flow asks the user to accept inside this session." } : data.workspace ? { nextAction: "Call codeflow_open_task now so the approach opens in the user's browser already signed in; the plain workspace.url works only in a browser that is already signed in to Code Flow, and no username or password is needed. The user reviews and starts it there. Then call codeflow_start_run with the same proposal revision and hash to recover the existing run. Terminal approval remains available." } : {}) };
          // The task runs under the owner, not this call: the host may wait in the background or ask for status.
          if (name === "codeflow_start_run") data = { ...data, follow: { runId: data.runId, follow: true }, ...(surface === "simple" ? { background: { wait: `codeflow wait ${data.runId}`, status: { runId: data.runId, waitSeconds: 25 } } } : {}) };
          if (name === "codeflow_list_providers") {
            // Inspect host-side files here, not in the owner (which may be a bundled remote host).
            let configuration: { state: string; message: string; pendingFiles?: string[] };
            try {
              const setup = await installUser(data.providers.filter((p: any) => p.installed).map((p: any) => p.id), true), legacy = await hasProjectInstall(projectRoot);
              configuration = { state: setup.changes.length || legacy ? "update_available" : "current", pendingFiles: setup.changes.map(e => e.path), message: legacy ? "This repository still has the old in-repository Code Flow setup. Run codeflow init once to move it to your user settings, then reconnect Code Flow in the host." : setup.changes.length ? "Your Code Flow setup differs from this runtime. Run codeflow init, then reconnect Code Flow in the host to load the updated tools and skill." : "Your user setup matches this runtime." };
            } catch (e) { configuration = { state: "needs_attention", message: `Configuration check: ${e instanceof Error ? e.message : "unavailable"}. Existing configuration was preserved.` }; }
            const compatible = CLI_TOOLS.every(t => data.connection?.tools?.includes(t.name));
            data = { ...data, connection: { ...data.connection, compatible, configuration,
              ...(!compatible ? { message: "The owner does not advertise this integration's current tools. Let active work settle, restart Code Flow with this version, then reconnect the host." } : {}) }, approvalMethod: nativeForm ? "native_form" : "terminal" };
          }
          if (name === "codeflow_preview_handoff") data = { ...data, approvalMethod: nativeForm ? "native_form" : "terminal", nextAction: nativeForm ? "Read all diff pages, then call codeflow_apply_handoff with the exact previewHash to show native confirmation." : `Review and apply in your interactive terminal: codeflow apply ${data.runId}` };
          return data;
        };
        try {
          let data: any;
          if (isSimpleCall(name, args)) {
            data = await simpleCall(advanced, name, args, { host, nativeForm });
            if (name === "codeflow_run" && !nativeForm) {
              // No form in this host: open the proposal for the user instead of asking the model to call another tool.
              const opened = data.workspace ? await client.call("codeflow_open_task", { id: data.proposalId }).then(r => r.opened === true, () => false) : false;
              data = { ...data, nextAction: `Show the card to the user. ${data.workspace ? `${opened ? "It is open in their browser" : `They can open ${data.workspace.url} in a browser signed in to Code Flow`} to review and press Start, or they` : "They"} can run \`codeflow approve ${data.proposalId} --revision ${data.revision}\` in their own terminal. After they approve, call codeflow_start_run with this proposal ID, revision and hash.` };
            }
            text = formatSimple(name, data);
          } else data = await advanced(name, args);
          value = { protocolVersion: 1, ok: true, data };
        }
        catch (e) { error = true; value = { protocolVersion: 1, ok: false, error: { code: e instanceof CliTeamError ? e.code : "runtime_unavailable", message: e instanceof Error ? e.message : "CLI request failed", details: e instanceof CliTeamError ? e.details : undefined } }; }
        // Shared names report through the common formatter under the operation that actually ran.
        const ran = name === "codeflow_steer_run" && args?.action !== undefined ? "codeflow_control_run" : name === "codeflow_apply" ? "codeflow_apply_handoff" : name === "codeflow_providers" ? "codeflow_list_providers" : name;
        void recordMetric({ at: began, session, host: hostName, hostVersion, tool: String(name).slice(0, 60), ok: !error, ...(error ? { code: value.error.code } : {}), ms: Date.now() - began,
          proposalId: value.data?.proposalId ?? (typeof args?.proposalId === "string" ? args.proposalId : undefined), runId: value.data?.runId ?? (typeof args?.runId === "string" ? args.runId : undefined),
          state: value.data?.state ?? (value.data?.runtimeStatus ? runState(value.data) : undefined) });
        result = { content: [{ type: "text", text: text ?? formatToolResult(ran, value) }], structuredContent: value, isError: error };
      } else { rpcError(m.id, -32601, "Method not found"); return; }
      send({ jsonrpc: "2.0", id: m.id, result });
    } finally { inflight--; }
  };
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      let end: number;
      while ((end = buffered.indexOf(10)) >= 0) {
        const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        if (line.length > CLI_MESSAGE_BYTES) {
          // Valid complete envelopes retain their request ID even when over the wire limit.
          let id: unknown = null; try { const m = JSON.parse(line.toString()); if (typeof m.id === "string" || typeof m.id === "number") id = m.id; } catch {}
          rpcError(id, -32600, "Request exceeds 8 MiB; reduce attachments or proposal size"); continue;
        }
        if (!line.toString().trim()) continue;
        let message: unknown; try { message = JSON.parse(line.toString()); } catch { rpcError(null, -32700, "Parse error"); continue; }
        const m = message as any;
        if (m?.jsonrpc === "2.0" && m.method === undefined && m.id !== undefined) {
          const pending = prompts.get(m.id);
          if (pending) {
            prompts.delete(m.id); clearTimeout(pending.timer);
            if (m.error) pending.reject(new CliTeamError("acceptance_required", "The host could not display native confirmation. Check the shared task before requesting start again. Open the proposal in Code Flow to review and start it, use codeflow approve in an interactive terminal, or reconnect a host with form elicitation support."));
            else pending.resolve(m.result);
          }
          continue;
        }
        if (m?.jsonrpc === "2.0" && m.method === "notifications/cancelled") { if (typeof m.params?.requestId === "string" || typeof m.params?.requestId === "number") cancelPrompts("Start request cancelled; no approval was recorded", m.params.requestId); continue; }
        void request(message).catch(e => rpcError(m?.id ?? null, -32603, e instanceof Error ? e.message : "MCP request failed"));
      }
      if (buffered.length > CLI_MESSAGE_BYTES) {
        // An unbounded/incomplete frame cannot be safely parsed for an ID. Close the
        // transport so the host rejects pending calls instead of waiting for a timeout.
        rpcError(null, -32600, "Request exceeds 8 MiB; reconnect and send a smaller request"); stop(); return;
      }
    }
    cancelPrompts("Host disconnected; no approval was recorded");
    while (inflight) await new Promise(resolve => setTimeout(resolve, 25));
  } finally { clearInterval(heartbeat); process.off("SIGINT", stop); process.off("SIGTERM", stop); await client.close(); }
}

async function serveOutsideRepository(folder: string) {
  const message = `Code Flow works on a Git repository, and this session started in ${folder}, which is not inside one. Ask the user to start claude, codex or agy from their project folder (or run git init there), then reconnect Code Flow from /mcp.`;
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const { createInterface } = await import("node:readline");
  for await (const line of createInterface({ input: process.stdin })) {
    let m: any; try { m = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    if (m?.id === undefined || m.method === undefined) continue;
    const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: versions.includes(m.params?.protocolVersion) ? m.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "code-flow", version: VERSION }, instructions: message } });
    else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: advertisedTools(await toolSurface(), [...CLI_TOOLS, ...HOST_TOOLS]) } });
    else if (m.method === "tools/call") {
      const value = { protocolVersion: 1, ok: false, error: { code: "not_a_repository", message }, nextAction: message };
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: message }], structuredContent: value, isError: true } });
    } else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
}
