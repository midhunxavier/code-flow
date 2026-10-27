// Antigravity adapter: kind-aware unrestricted failures, the legacy-only skip-permissions switch,
// and the isolated profile's Git metadata boundary.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-agy-")));
process.env.CODEFLOW_HOME = join(root, "home");
const oldPath = process.env.PATH;
process.env.PATH = `${root}:${oldPath}`;
const { createAgyAdapter, nativeAgyFailure } = await import("../src/adapters/agy.js");
const { agyIsolationProfile, prepareAgyIsolation } = await import("../src/adapters/agy-isolation.js");
const { createRunPermissions, resolveRunPermissions } = await import("../src/run-permissions.js");
type RunOptions = import("../src/adapters/types.js").RunOptions;
after(async () => { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); });

/** A stand-in agy that records its arguments and answers with this result status. */
async function agy(status = "SUCCESS", error = "") {
  await writeFile(join(root, "agy"), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root, "launch.json"))},JSON.stringify({args}));
console.log('private diagnostic SYNTHETIC_SECRET');
console.log(JSON.stringify({event:'result',result:{status:${JSON.stringify(status)},response:'done',error:{message:${JSON.stringify(error)}}}}));
`, { mode: 0o700 });
  return createAgyAdapter(async () => { throw new Error("Native must not prepare isolation"); });
}
const native = (): RunOptions => ({ cwd: root, prompt: "Fixture", mode: "write", trust: "full", permissions: resolveRunPermissions({ policy: createRunPermissions("standard", false, false, [], "native"), provider: "agy", mode: "write", currentTrust: "standard", currentTools: false }) });
const launched = async () => JSON.parse(await readFile(join(root, "launch.json"), "utf8")).args as string[];
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
}

test("unrestricted Antigravity failures give advice for their kind, not a login check for every failure", async () => {
  const cases = [
    { status: "RESOURCE_EXHAUSTED", error: "Resource has been exhausted (e.g. check quota).", kind: "rate_limit", text: /rate limit/i },
    { status: "RESOURCE_EXHAUSTED", error: "Daily quota exceeded for your plan.", kind: "usage_limit", text: /usage limit/i },
    { status: "UNAVAILABLE", error: "The service is currently unavailable.", kind: "transient", text: /temporarily unavailable/i },
    { status: "DEADLINE_EXCEEDED", error: "Deadline exceeded.", kind: "timeout", text: /ran out of time/i },
  ];
  for (const { status, error, kind, text } of cases) {
    const events: unknown[] = [];
    const result = await (await agy(status, error)).run(native(), event => events.push(event));
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, kind, status);
    assert.match(result.error!, text);
    assert.doesNotMatch(result.error!, /login|sign-?in/i, `${kind} failures don't send the user to check the login`);
    assert.doesNotMatch(JSON.stringify({ result, events }), /SYNTHETIC_SECRET/);
  }
  const auth = await (await agy("UNAUTHENTICATED", "Token expired")).run(native(), () => {});
  assert.equal(auth.errorKind, "auth");
  assert.match(auth.error!, /login/i);
  assert.doesNotMatch(auth.error!, /SYNTHETIC_SECRET|Token expired/);
  for (const kind of ["other", "cli_incompatible"] as const) assert.match(nativeAgyFailure(kind), new RegExp(`\\(${kind}\\).*withheld`));
});

test("CODEFLOW_AGY_SKIP_PERMISSIONS only affects legacy calls, never unrestricted runs", async () => {
  const adapter = await agy();
  await withEnv("CODEFLOW_AGY_SKIP_PERMISSIONS", "0", async () => {
    assert.equal((await adapter.run(native(), () => {})).ok, true);
    const args = await launched();
    assert.ok(args.includes("--dangerously-skip-permissions"), "unrestricted mode is defined by the permission-skip flag");
    assert.ok(!args.includes("--sandbox"));
    assert.equal((await adapter.run({ cwd: root, prompt: "Legacy", mode: "read" }, () => {})).ok, true);
    assert.ok(!(await launched()).includes("--dangerously-skip-permissions"), "a legacy call honours =0");
  });
  await withEnv("CODEFLOW_AGY_SKIP_PERMISSIONS", undefined, async () => {
    await adapter.run({ cwd: root, prompt: "Legacy", mode: "read" }, () => {});
    const args = await launched();
    assert.ok(args.includes("--dangerously-skip-permissions") && args.includes("--sandbox"));
  });
});

async function isolated(mode: "read" | "write") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-agy-git-")));
  const workspace = join(base, "workspace"), keychains = join(base, "keychains"), securityCache = join(base, "mds");
  for (const path of [workspace, keychains, securityCache]) await mkdir(path);
  const securityLock = join(securityCache, "mds.lock");
  await writeFile(securityLock, "LOCK");
  const prepared = await prepareAgyIsolation(workspace, mode, { binary: "/bin/bash", keychains, securityCache, securityLock });
  return { ...prepared, base, cleanup: async () => { await prepared.cleanup(); await rm(base, { recursive: true, force: true }); } };
}

test("the isolated profile denies reading Git metadata contents as its prompt says", async () => {
  const f = await isolated("write");
  try {
    const profile = agyIsolationProfile(f.paths, "write");
    assert.match(profile, /\(deny file-read-data file-read-xattr file-write\* \(require-all \(subpath "[^"]+"\) \(regex #"\/\[\.\]git\(\/\|\$\)"\)\)\)/);
    assert.doesNotMatch(profile, /\(deny file-read\*[^\n]*\[\.\]git\(/, "metadata (stat) stays visible for repository detection");
  } finally { await f.cleanup(); }
});

test("managed macOS kernel boundary hides the worktree's .git pointer and nested Git contents", { skip: process.platform !== "darwin", timeout: 20000 }, async () => {
  for (const mode of ["read", "write"] as const) {
    const f = await isolated(mode);
    try {
      const gitdir = join(f.base, "repo/.git/worktrees/solo");
      await writeFile(join(f.paths.workspace, ".git"), `gitdir: ${gitdir}\n`);
      await writeFile(join(f.paths.workspace, ".gitignore"), "node_modules\n");
      await writeFile(join(f.paths.workspace, "README.md"), "Readable\n");
      await mkdir(join(f.paths.workspace, "nested/.git"), { recursive: true });
      await writeFile(join(f.paths.workspace, "nested/.git/HEAD"), "ref: refs/heads/main\n");
      const script = `set -eu
if IFS= read -r x < .git; then exit 54; fi
if IFS= read -r x < nested/.git/HEAD; then exit 55; fi
if ls nested/.git >/dev/null 2>&1; then exit 56; fi
[ -e .git ] || exit 57
[ -f .git ] || exit 58
IFS= read -r x < .gitignore || exit 59
IFS= read -r x < README.md || exit 60
if printf MUTATED >> .git; then exit 61; fi
printf PASSED
`;
      const result = await promisify(execFile)(f.command, [...f.args, "-c", script], { cwd: f.paths.workspace, env: f.env, timeout: 5000 }).catch((error: { code?: number; stdout?: string }) => ({ stdout: `exit ${error.code}: ${error.stdout ?? ""}` }));
      assert.match(result.stdout, /PASSED/, `${mode}: ${result.stdout}`);
      assert.equal(await readFile(join(f.paths.workspace, ".git"), "utf8"), `gitdir: ${gitdir}\n`);
    } finally { await f.cleanup(); }
  }
});
