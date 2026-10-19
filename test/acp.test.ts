import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, RunOptions } from "../src/adapters/types.js";
import type { AcpConnection } from "../src/adapters/acp-types.js";
import { ApprovalRegistry } from "../src/approvals.js";
const home = mkdtempSync(join(tmpdir(), "cf-acp-tests-"));
process.env.CODEFLOW_HOME = home;
const { acpCatalog, probeAcp, runAcp } = await import("../src/adapters/acp.js");
const fixture = fileURLToPath(new URL("./fake-acp.mjs", import.meta.url));
let sequence = 0;
function connection(scenario = "happy") {
  const log = join(home, `rpc-${++sequence}.jsonl`);
  const value: AcpConnection = { id: "acp:fixture", name: "Fixture ACP", command: process.execPath, args: [fixture, scenario, log], enabled: true };
  return { value, log, messages: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}
async function turn(scenario = "happy", options: Partial<RunOptions> = {}) {
  const cli = connection(scenario), events: AgentEvent[] = [];
  const result = await runAcp(cli.value, { cwd: home, prompt: "Do the task", mode: "write", trust: "full", timeoutMs: 5000, ...options }, (event) => events.push(event));
  return { ...cli, result, events };
}
after(() => rmSync(home, { recursive: true, force: true }));

test("ACP handshake discovers grouped models and capabilities without a prompt or host capabilities", async () => {
  const cli = connection(), probe = await probeAcp(cli.value), messages = cli.messages();
  assert.equal(probe.protocolVersion, 1); assert.equal(probe.agent, "fixture-agent"); assert.equal(probe.sessionResume, true);
  assert.deepEqual(probe.catalog.models.map((model) => model.id), ["fixture/model-a", "fixture/model-b"]);
  assert.deepEqual(probe.catalog.efforts, ["low", "high"]);
  assert.deepEqual(messages[0].params.clientCapabilities, {});
  assert.deepEqual(messages.map((message) => message.method), ["initialize", "session/new"]);
  assert.equal(existsSync(messages[1].params.cwd), false, "probe scratch directory removed");
});
test("ACP streams text, reasoning and merged tool updates, selects models/effort, and ignores history and context occupancy", async () => {
  const { result, events, messages } = await turn("happy", { model: "fixture/model-b", effort: "high", resumeSessionId: "session-fixture", jsonSchema: { type: "object" } });
  assert.equal(result.ok, true); assert.equal(result.finalText, "Hello world"); assert.equal(result.sessionId, "session-fixture");
  assert.equal(events.filter((event) => event.kind === "tool_result").length, 1);
  assert.ok(events.some((event) => event.kind === "thinking")); assert.ok(!events.some((event) => event.kind === "usage"));
  assert.deepEqual(messages().filter((message) => message.method === "session/set_config_option").map((message) => message.params.value), ["fixture/model-b", "high"]);
  assert.match(messages().find((message) => message.method === "session/prompt").params.prompt[0].text, /JSON matching this schema/);
});
test("legacy ACP model selection works and unsupported settings fail before prompting", async () => {
  const legacy = await turn("legacy", { model: "fixture/model-a" });
  assert.equal(legacy.result.ok, true); assert.ok(legacy.messages().some((message) => message.method === "session/set_model"));
  const unsupported = await turn("happy", { model: "made-up" });
  assert.equal(unsupported.result.errorKind, "cli_incompatible"); assert.ok(!unsupported.messages().some((message) => message.method === "session/prompt"));
});
test("Cline config discovers models instead of providers and keeps approval policy unchanged across new and resumed turns", async () => {
  const cli = connection("cline"), probe = await probeAcp(cli.value);
  assert.deepEqual(probe.catalog.models.map((model) => model.id), ["fixture/model-a", "fixture/model-b"]);
  assert.equal(probe.catalog.defaultModel, "fixture/model-a");
  assert.deepEqual(probe.catalog.efforts, []);
  for (const [scenario, resumeSessionId] of [["cline", undefined], ["cline", "session-fixture"], ["cline-partial", undefined]] as const) {
    let asked = false;
    const registry = new ApprovalRegistry();
    const { result, events, messages } = await turn(scenario, { model: "fixture/model-b", resumeSessionId, interactiveApprovals: true, onApproval: async (request, signal) => {
      asked = true; assert.equal(request.kind, "file-change"); assert.deepEqual(request.paths, ["example.txt"]); assert.match(request.command!, /example.txt/);
      const pending = registry.request("run", "step", request, signal);
      const [record] = registry.list();
      assert.ok(record, "Cline's edit must reach the real approval inbox instead of being silently declined");
      assert.deepEqual(record.paths, ["example.txt"]);
      assert.equal(registry.respond(record.id, "approve"), true);
      return pending;
    } });
    registry.close();
    assert.equal(result.ok, true, result.error); assert.equal(asked, true);
    assert.deepEqual(messages().filter((message) => message.method === "session/set_config_option").map((message) => message.params), [{ sessionId: "session-fixture", configId: "model", value: "fixture/model-b" }]);
    assert.equal(messages().find((message) => message.id === "permission-1").result.outcome.optionId, "allow_once");
    assert.ok(events.some((event) => event.kind === "tool_result" && event.output === "Wrote example.txt"));
    assert.ok(!result.finalText.includes("Old history"));
  }
  const denied = await turn("cline");
  assert.equal(denied.messages().find((message) => message.id === "permission-1").result.outcome.optionId, "reject_once");
  const legacy = acpCatalog({ configOptions: [{ id: "provider", category: "model", type: "select", options: [{ value: "cline", name: "Cline" }] }], models: { currentModelId: "model-a", availableModels: [{ modelId: "model-a", name: "A" }] } });
  assert.deepEqual(legacy.models, [{ id: "model-a", label: "A" }]);
});
test("late ACP tool details update the same call and completion is emitted once", async () => {
  const { result, events } = await turn("partial-tools");
  assert.equal(result.ok, true);
  const calls = events.filter((event) => event.kind === "tool_call");
  assert.equal(calls.length, 2); assert.equal(calls[0]!.callId, calls[1]!.callId);
  assert.equal(calls[0]!.input, "{}"); assert.equal(calls[1]!.name, "Read README.md");
  assert.deepEqual(JSON.parse(calls[1]!.input), { path: "README.md" });
  assert.equal(events.filter((event) => event.kind === "tool_result").length, 1);
});
test("permissions are single-action only, declined headlessly and for writes in read mode", async () => {
  for (const [scenario, options, outcome] of [
    ["permission", {}, "deny-once"],
    ["permission", { interactiveApprovals: true, onApproval: async () => "approve" as const }, "allow-once"],
    ["permission", { mode: "read" as const, interactiveApprovals: true, onApproval: async () => { throw new Error("must not ask"); } }, "deny-once"],
    ["permission-always", { interactiveApprovals: true, onApproval: async () => { throw new Error("must not grant persistent approval"); } }, "deny-once"],
  ] as const) {
    const result = await turn(scenario, options);
    assert.equal(result.result.ok, true);
    assert.equal(result.messages().find((message) => message.id === "permission-1").result.outcome.optionId, outcome);
  }
});
test("unadvertised host operations are rejected", async () => {
  const result = await turn("host-request");
  assert.equal(result.result.ok, true);
  assert.equal(result.messages().find((message) => message.id === "host-1").error.code, -32601);
});
test("partial permission requests use the earlier tool details", async () => {
  let asked = false;
  const result = await turn("permission-partial", { interactiveApprovals: true, onApproval: async (request) => {
    asked = true; assert.equal(request.kind, "file-change"); assert.deepEqual(request.paths, ["/tmp/example.txt"]); assert.equal(request.reason, "Edit file"); return "approve";
  } });
  assert.equal(result.result.ok, true); assert.equal(asked, true);
  assert.equal(result.messages().find((message) => message.id === "permission-1").result.outcome.optionId, "allow-once");
});
test("auth, missing sessions, unsupported versions, malformed output, crashes and refusals fail explicitly", async () => {
  for (const [scenario, kind, options] of [
    ["auth", "auth", {}], ["missing-session", "session_not_found", { resumeSessionId: "missing" }],
    ["no-resume", "session_not_found", { resumeSessionId: "missing" }], ["wrong-version", "cli_incompatible", {}],
    ["malformed", "cli_incompatible", {}], ["crash", "other", {}], ["refusal", "other", {}],
  ] as const) {
    const result = await turn(scenario, options);
    assert.equal(result.result.ok, false, scenario); assert.equal(result.result.errorKind, kind, scenario);
    if (kind === "session_not_found") assert.equal(result.result.sessionId, undefined);
  }
});
test("cancellation sends session/cancel, ends permission requests, and does not spawn already-aborted turns", async () => {
  const controller = new AbortController();
  const cli = connection("hang"), events: AgentEvent[] = [];
  const promise = runAcp(cli.value, { cwd: home, mode: "write", trust: "full", prompt: "wait", signal: controller.signal, timeoutMs: 5000 }, (event) => { events.push(event); if (event.kind === "session") setTimeout(() => controller.abort(), 100); });
  const result = await promise;
  assert.equal(result.errorKind, "cancelled"); assert.ok(cli.messages().some((message) => message.method === "session/cancel"));
  const aborted = await turn("happy", { signal: controller.signal }); assert.equal(aborted.messages().length, 0);
  const approvalController = new AbortController();
  const approved = await turn("permission", { signal: approvalController.signal, interactiveApprovals: true, onApproval: async (_request, signal) => {
    approvalController.abort(); await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(signal.aborted, true); return "approve";
  } });
  assert.equal(approved.result.errorKind, "cancelled");
  assert.equal(approved.messages().find((message) => message.id === "permission-1").result.outcome.outcome, "cancelled");
});
test("silent agents time out or stall and unsupported trust never starts a process", async () => {
  assert.equal((await turn("init-hang", { timeoutMs: 150 })).result.errorKind, "timeout");
  assert.equal((await turn("stall", { idleTimeoutMs: 150 })).result.errorKind, "stalled");
  const safe = await turn("happy", { trust: "safe" }); assert.equal(safe.result.ok, false); assert.equal(safe.messages().length, 0);
});
