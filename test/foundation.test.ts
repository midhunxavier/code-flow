import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join, relative } from "node:path";

const home = mkdtempSync(join(tmpdir(), "codeflow-foundation-home-"));
process.env.CODEFLOW_HOME = home;

const { cleanPath, childEnv } = await import("../src/env.js");
const { envNumber, timerMs, MAX_TIMER_MS } = await import("../src/config.js");
const { git, classifyGitFailure, gitAtLeast, withRepoLock } = await import("../src/git.js");
const { reapOrphanGroups } = await import("../src/adapters/process.js");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("childEnv drops code-flow's token, npm variables and its own node_modules/.bin", () => {
  const saved = { ...process.env };
  try {
    process.env.CODEFLOW_TOKEN = "secret";
    process.env.npm_package_name = "code-flow";
    process.env.npm_config_local_prefix = "/opt/tools/code-flow";
    process.env.npm_config_registry = "https://npm.example.com/";
    process.env.CODEFLOW_HOME = home;
    const env = childEnv({ EXTRA: "1" });
    assert.equal(env.CODEFLOW_TOKEN, undefined);
    assert.equal(env.npm_package_name, undefined);
    assert.equal(env.npm_config_local_prefix, undefined, "code-flow's own folder isn't the repo's");
    assert.equal(env.npm_config_registry, "https://npm.example.com/", "your npm settings are kept");
    assert.equal(env.CODEFLOW_HOME, home, "settings the fakes and checks read are kept");
    assert.equal(env.EXTRA, "1");
  } finally {
    process.env = saved;
  }
  const install = "/opt/tools/code-flow";
  const path = ["/opt/tools/code-flow/node_modules/.bin", "/opt/tools/node_modules/.bin", ".", "relative/bin", "/repo/node_modules/.bin", "/usr/bin", ""].join(":");
  assert.equal(cleanPath(path, install), "/repo/node_modules/.bin:/usr/bin");
});

test("subprocess state stays in the server home when a relative home is inherited or overridden", () => {
  const saved = process.env.CODEFLOW_HOME;
  const directory = mkdtempSync(join(tmpdir(), "codeflow-relative-home-"));
  const cwd = join(directory, "repository"), state = join(directory, "state");
  mkdirSync(cwd);
  try {
    for (const via of ["inherited", "extra"] as const) {
      process.env.CODEFLOW_HOME = via === "inherited" ? relative(process.cwd(), state) : home;
      const env = childEnv(via === "extra" ? { CODEFLOW_HOME: relative(process.cwd(), state) } : {});
      const result = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.CODEFLOW_HOME,{recursive:true});fs.writeFileSync(path.join(process.env.CODEFLOW_HOME,'receipt'),'saved');"], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(state, "receipt")), true, `${via} home must stay outside the repository`);
      rmSync(state, { recursive: true });
    }
  } finally {
    if (saved === undefined) delete process.env.CODEFLOW_HOME; else process.env.CODEFLOW_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("childEnv never launches cwd Git or provider impostors through inherited or overridden PATH", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX executable lookup and fallback");
  const directory = mkdtempSync(join(tmpdir(), "codeflow-path-lookup-")), cwd = join(directory, "repo"), trusted = join(directory, "trusted-bin"), marker = join(directory, "impostor-executed"), provider = "codeflow-path-provider-fixture";
  const originalPath = process.env.PATH;
  try {
    mkdirSync(join(cwd, "relative-bin"), { recursive: true }); mkdirSync(trusted);
    const impostor = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write('impostor\\n');\n`;
    for (const folder of [cwd, join(cwd, "relative-bin")]) for (const name of ["git", provider]) writeFileSync(join(folder, name), impostor, { mode: 0o700 });
    writeFileSync(join(trusted, provider), `#!${process.execPath}\nprocess.stdout.write('trusted fixture provider\\n');\n`, { mode: 0o700 });
    // Prove the fixture can execute when cwd lookup is allowed, then exercise app environments.
    assert.equal(spawnSync(provider, [], { cwd, env: { ...childEnv(), PATH: "." }, encoding: "utf8" }).stdout, "impostor\n"); rmSync(marker);
    for (const via of ["inherited", "extra"] as const) for (const path of [undefined, ".", "", ":", "relative-bin", "..:relative-bin:"]) {
      if (via === "inherited") { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
      else process.env.PATH = `${trusted}:/usr/bin:/bin`;
      const extra = via === "extra" ? { PATH: path } : {};
      assert.equal(childEnv(extra).PATH, "/usr/bin:/bin", `${via} PATH=${String(path)}`);
      // System Git can cold-start slowly on a loaded macOS runner. This test
      // verifies executable lookup; timeout behavior has its own test below.
      const result = await git(["--version"], cwd, { env: extra, timeoutMs: 30_000 });
      assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /^git version /);
      const absent = spawnSync(provider, [], { cwd, env: childEnv(extra), encoding: "utf8" });
      assert.equal((absent.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT", "fallback never searches cwd or its relative tool directory");
      assert.equal(existsSync(marker), false, `${via} PATH=${String(path)} executed a repository impostor`);
    }
    const mixed = `.::relative-bin:${trusted}:/usr/bin:/bin`;
    for (const via of ["inherited", "extra"] as const) {
      process.env.PATH = via === "inherited" ? mixed : "/usr/bin:/bin";
      const environment = childEnv(via === "extra" ? { PATH: mixed } : {});
      assert.equal(environment.PATH, `${trusted}:/usr/bin:/bin`);
      const result = spawnSync(provider, [], { cwd, env: environment, encoding: "utf8" });
      assert.equal(result.status, 0); assert.equal(result.stdout, "trusted fixture provider\n"); assert.equal(existsSync(marker), false, "an explicit absolute provider bin remains usable ahead of system tools");
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("envNumber falls back on values setTimeout would misread", () => {
  process.env.CF_TEST_NUM = "30m";
  assert.equal(envNumber("CF_TEST_NUM", 30, { min: 1 }), 30);
  process.env.CF_TEST_NUM = "0";
  assert.equal(envNumber("CF_TEST_NUM", 30, { min: 1 }), 30);
  process.env.CF_TEST_NUM = "45";
  assert.equal(envNumber("CF_TEST_NUM", 30, { min: 1 }), 45);
  delete process.env.CF_TEST_NUM;
  assert.equal(timerMs(Number.NaN), MAX_TIMER_MS);
  assert.equal(timerMs(99_999 * 60_000), MAX_TIMER_MS);
  assert.equal(timerMs(-5), 0);
});

test("git calls are bounded in time and never prompt", async () => {
  const res = await git(["-c", "alias.slow=!sleep 5", "slow"], tmpdir(), { timeoutMs: 300 });
  assert.equal(res.code, 1);
  assert.equal(res.timedOut, true);
  assert.equal(classifyGitFailure(res), "timeout");

  const controller = new AbortController();
  const pending = git(["-c", "alias.slow=!sleep 5", "slow"], tmpdir(), { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).aborted, true);
  assert.equal(await gitAtLeast(2, 0), true);
});

test("classifyGitFailure names what went wrong", () => {
  const r = (stderr: string) => ({ code: 1, stdout: "", stderr });
  assert.equal(classifyGitFailure(r("fatal: Unable to create '/r/.git/index.lock': File exists.")), "locked");
  assert.equal(classifyGitFailure(r("error: The following untracked working tree files would be overwritten by merge:")), "untracked");
  assert.equal(classifyGitFailure(r("CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed")), "conflict");
  assert.equal(classifyGitFailure(r("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), "auth");
  assert.equal(classifyGitFailure(r("Please tell me who you are.")), "identity");
});

test("withRepoLock runs one operation per repo at a time", async () => {
  const order: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
  };
  await Promise.all([withRepoLock("/tmp/repo-a", slow("a1", 40)), withRepoLock("/tmp/repo-a", slow("a2", 1)), withRepoLock("/tmp/repo-b", slow("b", 1))]);
  assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"), order.join(" "));
  assert.ok(order.indexOf("b:end") < order.indexOf("a1:end"), "another repo isn't blocked");
  // A failure releases the lock.
  await assert.rejects(withRepoLock("/tmp/repo-a", async () => Promise.reject(new Error("boom"))));
  assert.equal(await withRepoLock("/tmp/repo-a", async () => "ok"), "ok");
});

test("a process group a crashed code-flow left behind is killed at the next start", async (t) => {
  if (process.platform === "win32") return t.skip("process groups");
  // What a crashed server leaves: a detached group (an agent and its child) still running,
  // recorded in processes.json.
  const leader = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, 200));
  // An unrelated process whose pid doesn't match its record (as after pid reuse) is left alone.
  const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(
    join(home, "processes.json"),
    JSON.stringify({
      server: 999_999,
      boot: Math.round(Date.now() - uptime() * 1000),
      groups: [
        { pid: leader.pid, startedAt },
        { pid: stranger.pid, startedAt: startedAt - 3_600_000 },
      ],
    }),
  );
  try {
    assert.equal(await reapOrphanGroups(), 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(leader.pid!), false, "the orphaned group is gone");
    assert.equal(alive(stranger.pid!), true, "a process that only shares a recorded pid survives");
  } finally {
    try {
      process.kill(-leader.pid!, "SIGKILL");
    } catch {}
    stranger.kill("SIGKILL");
  }
});
