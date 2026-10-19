import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const [scenario = "happy", log] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const result = (id, value) => send({ id, result: value });
const update = (value, sessionId = "session-fixture") => send({ method: "session/update", params: { sessionId, update: value } });
const configOptions = [
  { id: "models", category: "model", type: "select", currentValue: "fixture/model-a", options: [{ group: "fixture", name: "Fixture", options: [{ value: "fixture/model-a", name: "Model A" }, { value: "fixture/model-b", name: "Model B" }] }] },
  { id: "reasoning", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
let promptId;
const finish = () => result(promptId, { stopReason: scenario === "refusal" ? "refusal" : "end_turn" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    if (scenario === "malformed") { process.stdout.write("not JSON\n"); return; }
    if (scenario === "init-hang") return;
    result(id, { protocolVersion: scenario === "wrong-version" ? 2 : 1, agentInfo: { name: "fixture-agent", version: "1.2.3" }, agentCapabilities: { loadSession: scenario !== "no-resume" } });
  } else if (method === "session/new" || method === "session/load") {
    if (scenario === "auth") { send({ id, error: { code: -32000, message: "Authentication required" } }); return; }
    if (method === "session/load") {
      if (scenario === "missing-session") { send({ id, error: { code: -32002, message: "Session not found" } }); return; }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old history, never repeat this" } });
    }
    result(id, scenario === "legacy" ? { sessionId: "session-fixture", models: { currentModelId: "fixture/model-a", availableModels: [{ modelId: "fixture/model-a", name: "Model A" }] } } : { sessionId: "session-fixture", configOptions });
  } else if (["session/set_config_option", "session/set_model"].includes(method)) result(id, { configOptions });
  else if (method === "session/prompt") {
    promptId = id;
    if (scenario === "crash") { process.exit(3); }
    if (scenario === "hang" || scenario === "stall") return;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong-session" } }, "unrelated-session");
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });
    update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", kind: "read", ...(scenario === "partial-tools" ? {} : { rawInput: { path: "README.md" } }), status: "pending" });
    if (scenario === "partial-tools") update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "Read README.md", rawInput: { path: "README.md" }, status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file contents" } }] });
    update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
    update({ sessionUpdate: "usage_update", used: 10000, size: 100000, cost: { amount: 1, currency: "USD" } });
    if (scenario.startsWith("permission")) {
      const details = { toolCallId: "edit-1", kind: "edit", title: "Edit file", locations: [{ path: "/tmp/example.txt" }] };
      if (scenario === "permission-partial") update({ sessionUpdate: "tool_call", ...details });
      send({ id: "permission-1", method: "session/request_permission", params: { sessionId: "session-fixture", toolCall: scenario === "permission-partial" ? { toolCallId: "edit-1" } : details, options: [{ optionId: "allow-once", kind: scenario === "permission-always" ? "allow_always" : "allow_once", name: "Allow" }, { optionId: "deny-once", kind: "reject_once", name: "Deny" }] } });
      return;
    }
    if (scenario === "host-request") {
      send({ id: "host-1", method: "fs/write_text_file", params: { path: "/tmp/not-authorized", content: "no" } }); return;
    }
    if (scenario === "write") writeFileSync("acp-result.txt", "ACP fixture change\n");
    finish();
  } else if (method === "session/cancel") { if (promptId) result(promptId, { stopReason: "cancelled" }); }
  else if (id === "permission-1") { update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(message.result) } }); finish(); }
  else if (id === "host-1") finish();
  else send({ id, error: { code: -32601, message: "Method not supported" } });
});
