import { CLI_TOOLS } from "./tools.js";
import { CliTeamError } from "./model.js";
import { connectRuntime, runtimeRequest } from "./client.js";
import { randomBytes } from "node:crypto";

export async function serveMcp(projectRoot: string) {
  const client = await connectRuntime(projectRoot);
  const heartbeat = setInterval(() => { void runtimeRequest(client.runtime, "/heartbeat", {}, client.token).catch(() => undefined); }, 10000).unref();
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
  const approveInHost = async (parent: string | number, args: any) => {
    const preview = await runtimeRequest(client.runtime, "/preview", { projectRoot, proposalId: args.proposalId, revision: args.expectedRevision });
    if (preview.hash !== args.proposalHash) throw new CliTeamError("acceptance_stale", "Proposal changed; review its current revision before starting");
    const result = await new Promise<any>((resolve, reject) => {
      const id = `codeflow-approval-${randomBytes(16).toString("hex")}`;
      const timer = setTimeout(() => { prompts.delete(id); reject(new CliTeamError("acceptance_cancelled", "This confirmation timed out without starting work. Check the shared task before requesting start again.")); }, 5 * 60_000);
      prompts.set(id, { parent, resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method: "elicitation/create", params: {
        mode: "form", message: `Review this Code Flow proposal before starting.\n\n${preview.preview}`,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve and start this exact proposal", description: `Proposal ${args.proposalId}, revision ${args.expectedRevision}. Declining starts no work.`, default: false } }, required: ["approve"] },
      } });
    });
    if (result?.action !== "accept" || result.content?.approve !== true) throw new CliTeamError(result?.action === "cancel" ? "acceptance_cancelled" : "acceptance_declined", "This confirmation did not approve or start work. Check the shared task if it was started elsewhere; otherwise revise it or request start again when ready.");
    // The reply is a server-request response from the native host, never a tool argument
    // supplied by the model. The owner rechecks the exact revision/hash atomically.
    await runtimeRequest(client.runtime, "/confirm", { projectRoot, proposalId: args.proposalId, revision: args.expectedRevision, hash: preview.hash });
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
        result = { protocolVersion: versions.includes(m.params?.protocolVersion) ? m.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "code-flow", version: "1.0.0" }, instructions: `Generate a task-specific team and process. Present a readable proposal; ${nativeForm ? "call start_run to show the native approval form in this session; do not send the user to another terminal" : "this host has no form elicitation; use the Code Flow workspace or terminal confirmation returned by propose_run"}. No presets or saved teams. Preserve explicit model/effort pins. Show workspace.url as Open in Code Flow. Call codeflow_open_task only when asked to open the UI. For continuation pass context.chatId from the workspace. Browser approval/start and steering are authoritative; reconcile conversation.latestProposal and taskMessages before acting. Poll with bounded waits; retrieve the actual result artifact.` };
      } else if (m.method === "ping") result = {};
      else if (!initialized) { rpcError(m.id, -32000, "Initialize first"); return; }
      else if (m.method === "tools/list") result = { tools: CLI_TOOLS };
      else if (m.method === "tools/call") {
        let value: unknown, error = false;
        try {
          const name = m.params?.name, args = m.params?.arguments ?? {};
          let data: any;
          try { data = await client.call(name, args); }
          catch (e) {
            if (name !== "codeflow_start_run" || !nativeForm || !(e instanceof CliTeamError) || e.code !== "acceptance_required") throw e;
            await approveInHost(m.id, args); data = await client.call(name, args);
          }
          if (name === "codeflow_propose_run") data = { ...data, approvalMethod: nativeForm ? "native_form" : data.workspace ? "browser" : "terminal", ...(nativeForm ? { nextAction: "Review this proposal, then call codeflow_start_run with its ID, revision, and hash. Code Flow will ask the user to approve and start inside this session; no separate terminal is needed." } : data.workspace ? { nextAction: "Review and start the approach in Code Flow using workspace.url or codeflow_open_task. Then call codeflow_start_run with the same proposal revision and hash to recover the existing run. Terminal approval remains available." } : {}) };
          if (name === "codeflow_list_providers") data = { ...data, approvalMethod: nativeForm ? "native_form" : "terminal" };
          value = { protocolVersion: 1, ok: true, data };
        }
        catch (e) { error = true; value = { protocolVersion: 1, ok: false, error: { code: e instanceof CliTeamError ? e.code : "runtime_unavailable", message: e instanceof Error ? e.message : "CLI request failed", details: e instanceof CliTeamError ? e.details : undefined } }; }
        result = { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: error };
      } else { rpcError(m.id, -32601, "Method not found"); return; }
      send({ jsonrpc: "2.0", id: m.id, result });
    } finally { inflight--; }
  };
  let buffered = Buffer.alloc(0), discard = false;
  try {
    for await (const chunk of process.stdin) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      let end: number;
      while ((end = buffered.indexOf(10)) >= 0) {
        const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        if (discard || line.length > 64 * 1024) { rpcError(null, -32600, "Request exceeds 64 KiB"); discard = false; continue; }
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
      if (buffered.length > 64 * 1024) { buffered = Buffer.alloc(0); discard = true; }
    }
    cancelPrompts("Host disconnected; no approval was recorded");
    while (inflight) await new Promise(resolve => setTimeout(resolve, 25));
  } finally { clearInterval(heartbeat); process.off("SIGINT", stop); process.off("SIGTERM", stop); await client.close(); }
}
