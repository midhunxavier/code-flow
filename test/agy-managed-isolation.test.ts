import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.CODEFLOW_HOME = await mkdtemp(join(tmpdir(), "codeflow-agy-policy-home-"));
const { agyIsolationProfile, agyManagedOptionsProblem, prepareAgyIsolation, verifyAgyVersion, verifiedAgyVersion, AGY_ISOLATION_VERSION } = await import("../src/adapters/agy-isolation.js");
after(async () => { await rm(process.env.CODEFLOW_HOME!, { recursive: true, force: true }); });

const exec = promisify(execFile);
async function fixture(mode: "read" | "write") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-agy-managed-test-")));
  const workspace = join(root, "workspace.[test]"), keychains = join(root, "keychains"), securityCache = join(root, "mds");
  for (const path of [workspace, keychains, securityCache]) await mkdir(path);
  const securityLock = join(securityCache, "mds.lock");
  await writeFile(securityLock, "SYNTHETIC_LOCK");
  await writeFile(join(keychains, "sentinel"), "SYNTHETIC_KEYCHAIN");
  const isolated = await prepareAgyIsolation(workspace, mode, { binary: "/bin/bash", keychains, securityCache, securityLock });
  return { ...isolated, fixtureRoot: root, cleanup: async () => { await isolated.cleanup(); await rm(root, { recursive: true, force: true }); } };
}

test("clean managed profiles inherit no ambient authority and leave the native login untouched", async () => {
  const f = await fixture("write");
  try {
    assert.equal(f.env.HOME, f.paths.home);
    for (const key of ["CODEFLOW_TOKEN", "SSH_AUTH_SOCK", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "CODEFLOW_AGY_SKIP_PERMISSIONS"]) assert.equal(f.env[key], undefined);
    const settings = JSON.parse(await readFile(join(f.paths.home, ".gemini/antigravity-cli/settings.json"), "utf8"));
    for (const rule of ["command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)", "mcp(*)", `read_file(${f.paths.keychains})`, `read_file(${f.paths.securityCache})`]) assert.ok(settings.permissions.deny.includes(rule));
    assert.equal(settings.toolPermission, "request-review");
    const agent = await readFile(join(f.paths.home, ".gemini/config/agents/codeflow-isolated.md"), "utf8");
    assert.match(agent, /write_to_file/);
    assert.doesNotMatch(agent, /run_command|invoke_subagent|browser_|call_mcp_tool|run_workflow/);
    assert.equal(await realpath(join(f.paths.home, "Library/Keychains")), f.paths.keychains);
    assert.throws(() => agyIsolationProfile({ ...f.paths, workspace: "/tmp/x\n(allow default)" }, "write"), /Invalid/);
    assert.throws(() => agyIsolationProfile({ ...f.paths, workspace: f.paths.keychains }, "write"), /overlap/);
    assert.throws(() => agyIsolationProfile({ ...f.paths, securityLock: join(f.paths.securityCache, "other") }, "write"), /Unsafe/);
    await rm(f.root, { recursive: true, force: true });
    assert.equal(await readFile(join(f.paths.keychains, "sentinel"), "utf8"), "SYNTHETIC_KEYCHAIN", "removing the fresh home never follows its keychain symlink");
  } finally { await f.cleanup(); }
});

test("read turns remove write tools and forged permission receipts cannot change execution", async () => {
  const f = await fixture("read");
  try {
    assert.doesNotMatch(await readFile(join(f.paths.home, ".gemini/config/agents/codeflow-isolated.md"), "utf8"), /write_to_file|replace_file_content/);
    const settings = JSON.parse(await readFile(join(f.paths.home, ".gemini/antigravity-cli/settings.json"), "utf8"));
    assert.ok(settings.permissions.deny.includes("write_file(*)"));
    const opts: any = { cwd: f.paths.workspace, prompt: "test", mode: "read", trust: "standard", permissions: { provider: "agy", mode: "read", trust: "standard", nativeDelegation: false, isolation: "os-sandbox", implementation: AGY_ISOLATION_VERSION, commandNetwork: "denied", externalTools: "disabled", toolApprovals: false } };
    assert.equal(agyManagedOptionsProblem(opts), undefined);
    for (const patch of [{ nativeDelegation: true }, { externalTools: "provider-configured" }, { commandNetwork: "allowed" }, { implementation: "future" }, { mode: "write" }, { trust: "full" }, { toolApprovals: true }]) assert.ok(agyManagedOptionsProblem({ ...opts, permissions: { ...opts.permissions, ...patch } }));
    assert.ok(agyManagedOptionsProblem({ ...opts, agentContainer: { image: "fixture" } }));
  } finally { await f.cleanup(); }
});

test("managed macOS kernel boundary protects policy, outside files, git and authentication writes", { skip: process.platform !== "darwin", timeout: 20000 }, async () => {
  for (const mode of ["read", "write"] as const) {
    const f = await fixture(mode);
    try {
      const outside = join(f.root, "outside");
      await writeFile(outside, "OUTSIDE\n");
      await symlink(outside, join(f.paths.workspace, "escape"));
      await mkdir(join(f.paths.workspace, ".agents"));
      await writeFile(join(f.paths.workspace, ".agents/hooks.json"), "HOOK\n");
      await writeFile(join(f.paths.workspace, ".git"), "GIT");
      for (const dir of ["nested/.agents", "nested/.gemini", "nested/.git"]) {
        await mkdir(join(f.paths.workspace, dir), { recursive: true });
        await writeFile(join(f.paths.workspace, dir, "sentinel"), "PROTECTED\n");
      }
      await symlink(join(f.paths.workspace, "nested/.gemini"), join(f.paths.workspace, "config-alias"));
      const script = `set -eu
if IFS= read -r x < escape; then exit 40; fi
if IFS= read -r x < .agents/hooks.json; then exit 41; fi
if printf MUTATED > "$HOME/.gemini/antigravity-cli/settings.json"; then exit 42; fi
if printf MUTATED > "$HOME/.gemini/config/agents/evil.md"; then exit 43; fi
if printf MUTATED > "$1"; then exit 44; fi
if printf MUTATED > .git; then exit 45; fi
if printf MUTATED > "$2/sentinel"; then exit 46; fi
if printf MUTATED > "$3/other.db"; then exit 47; fi
if /usr/bin/true 2>/dev/null; then exit 48; fi
if IFS= read -r x < nested/.agents/sentinel; then exit 50; fi
if IFS= read -r x < nested/.gemini/sentinel; then exit 51; fi
if IFS= read -r x < config-alias/sentinel; then exit 52; fi
if printf MUTATED > nested/.git/sentinel; then exit 53; fi
printf SCRATCH > "$TMPDIR/result"
${mode === "write" ? "printf WORKSPACE > local.txt" : "if printf DENIED > local.txt; then exit 49; fi"}
printf PASSED
`;
      const result = await exec(f.command, [...f.args, "-c", script, "probe", outside, f.paths.keychains, f.paths.securityCache], { cwd: f.paths.workspace, env: f.env, timeout: 5000 });
      assert.match(result.stdout, /PASSED/);
      assert.equal(await readFile(outside, "utf8"), "OUTSIDE\n");
      assert.equal(await readFile(join(f.paths.keychains, "sentinel"), "utf8"), "SYNTHETIC_KEYCHAIN");
      assert.equal(await readFile(f.paths.securityLock, "utf8"), "SYNTHETIC_LOCK");
    } finally { await f.cleanup(); }
  }
});


test("version inspection cannot execute an unverified wrapper outside the sandbox", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflow-agy-version-test-"));
  try {
    const script = join(root, "agy"), marker = join(root, "escaped");
    await writeFile(script, `#!/bin/bash\nprintf unsafe > '${marker}'\necho 1.4.4\n`, { mode: 0o700 });
    await assert.rejects(verifyAgyVersion(await realpath(script)));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("only explicitly exercised Antigravity runtime versions are accepted", () => {
  for (const version of ["1.4.4", "1.4.5\n", "1.4.6", "1.4.6\n"]) assert.equal(verifiedAgyVersion(version), true);
  for (const version of ["1.4.3", "1.4.7", "1.5.0", "1.4.6-custom", "unknown"]) assert.equal(verifiedAgyVersion(version), false);
});
