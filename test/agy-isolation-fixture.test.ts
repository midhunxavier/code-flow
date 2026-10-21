import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { offlineAgyProfile, prepareAgyIsolationFixture } from "../scripts/live-permission-probes/agy-isolation-fixture.js";

const exec = promisify(execFile);
test("isolated fixture has a clean environment and protected restrictive configuration", async () => {
  const fixture = await prepareAgyIsolationFixture();
  try {
    assert.equal(fixture.env.HOME, fixture.home);
    assert.equal(fixture.env.CODEFLOW_TOKEN, undefined);
    assert.equal(fixture.env.GEMINI_API_KEY, undefined);
    assert.equal(fixture.env.SSH_AUTH_SOCK, undefined);
    const settings = JSON.parse(await readFile(fixture.settings, "utf8"));
    assert.equal(settings.enableTerminalSandbox, true);
    assert.equal(settings.allowNonWorkspaceAccess, false);
    assert.ok(settings.permissions.deny.includes("unsandboxed(*)"));
    assert.ok(settings.permissions.deny.includes("mcp(*)"));
    const agent = await readFile(join(fixture.home, ".gemini/config/agents/codeflow-isolated-probe.md"), "utf8");
    assert.match(agent, /commandExecutionPolicy: off/);
    assert.doesNotMatch(agent, /run_command|invoke_subagent|browser_|call_mcp_tool|run_workflow/);
    for (const bad of ["relative", "/tmp/a\n(allow default)", "/tmp/../etc"]) assert.throws(() => offlineAgyProfile({ home: bad, workspace: "/tmp/workspace", scratch: "/tmp/scratch" }), /Invalid isolation path/);
    assert.throws(() => offlineAgyProfile({ home: "/tmp/workspace/profile", workspace: "/tmp/workspace", scratch: "/tmp/scratch" }), /must not overlap/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("macOS kernel denies policy edits, ambient hooks, outside files and terminal networking", { skip: process.platform !== "darwin", timeout: 20000 }, async () => {
  const fixture = await prepareAgyIsolationFixture();
  let connections = 0;
  const server = createServer(socket => { connections++; socket.end(); });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const outside = join(fixture.root, "outside");
    await writeFile(outside, "OUTSIDE_SENTINEL");
    await symlink(outside, join(fixture.workspace, "escape"));
    // No provider, login or private data: attempt operations on our own fixtures only.
    const script = `set -eu
cat fixture.txt
printf WORKSPACE_WRITE > local.txt
printf SCRATCH_WRITE > "$TMPDIR/probe"
if cat escape >/dev/null 2>&1; then exit 41; fi
if cat .agents/hooks.json >/dev/null 2>&1; then exit 42; fi
if chmod 600 "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; then exit 43; fi
if printf MUTATED > "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; then exit 44; fi
if mv "$HOME/.gemini" "$HOME/replaced" 2>/dev/null; then exit 45; fi
if printf OUTSIDE > "$1" 2>/dev/null; then exit 46; fi
if /usr/bin/nc -z -w 1 127.0.0.1 "$2" >/dev/null 2>&1; then exit 47; fi
printf CONTAINMENT_PASSED
`;
    const result = await exec("/usr/bin/sandbox-exec", ["-f", fixture.profile, "/bin/sh", "-c", script, "probe", outside, String(port)], { cwd: fixture.workspace, env: fixture.env, timeout: 10000 }).catch(error => { throw new Error(JSON.stringify({ code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr })); });
    assert.match(result.stdout, /CONTAINMENT_PASSED/);
    assert.equal(await readFile(join(fixture.workspace, "local.txt"), "utf8"), "WORKSPACE_WRITE");
    assert.equal(await readFile(outside, "utf8"), "OUTSIDE_SENTINEL");
    assert.equal(connections, 0);
    assert.equal(JSON.parse(await readFile(fixture.settings, "utf8")).enableTerminalSandbox, true);
  } finally { server.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
