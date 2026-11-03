import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const scratch = mkdtempSync(join(tmpdir(), "codeflow-discussion-tools-"));
process.env.CODEFLOW_HOME = join(scratch, "home");
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { getAdapter } = await import("../src/adapters/index.js");
const { createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");
const { assertDiscussionProvider } = await import("../src/conversational/discussion.js");
after(() => rmSync(scratch, { recursive: true, force: true }));
function options() {
  return { prompt: "Discuss tradeoffs", cwd: scratch, mode: "read" as const, trust: "safe" as const, disableTools: true,
    permissions: resolveRunPermissions({ policy: createRunPermissions("safe", false, false, ["no-external-tools"]), provider: "claude", mode: "read", currentTrust: "safe", currentTools: false }) };
}
test("tool-free Claude launch disables builtin tools, external MCP, browser, hooks and native delegation", async () => {
  process.env.FAKE_RECORD_DIR = scratch;
  try { const result = await getAdapter("claude").run(options(), () => {}); assert.ok(result.ok, result.error); }
  finally { delete process.env.FAKE_RECORD_DIR; }
  const launch = readdirSync(scratch).filter(p => p.endsWith(".json")).map(p => JSON.parse(readFileSync(join(scratch, p), "utf8")))[0];
  const args: string[] = launch.args;
  assert.equal(args[args.indexOf("--tools") + 1], ""); assert.equal(args[args.indexOf("--setting-sources") + 1], ""); assert.equal(args[args.indexOf("--allowedTools") + 1], "");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}'); assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-chrome"));
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]!).disableAllHooks, true); assert.ok(!args.includes("bypassPermissions"));
});
test("missing tool-disable capability fails before invocation and unsupported providers require a repository", async () => {
  process.env.FAKE_UNKNOWN_FLAG = "--tools";
  try { await assert.rejects(assertDiscussionProvider("claude"), /cannot confirm/); const result = await getAdapter("claude").run(options(), () => {}); assert.equal(result.errorKind, "cli_incompatible"); }
  finally { delete process.env.FAKE_UNKNOWN_FLAG; }
  await assert.rejects(assertDiscussionProvider("codex"), /requires Claude/);
});
