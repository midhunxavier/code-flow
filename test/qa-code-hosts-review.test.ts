import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, RunManager, StartRunInput } from "../src/engine.js";
import type { CodeHostGitCommand } from "../src/code-host-git.js";

// Set the home before importing modules that capture CODEFLOW_HOME at evaluation time.
// These regressions never load the user's store or invoke real providers/Docker.
const home = mkdtempSync(join(tmpdir(), "codeflow-qa-host-review-home-"));
process.env.CODEFLOW_HOME = home;
const priorPath = process.env.PATH, binary = join(home, "bin");
process.env.PATH = `${binary}:${fileURLToPath(new URL("fake-bin", import.meta.url))}:${priorPath}`;
let dependencies: ReturnType<typeof loadDependencies> | undefined;
async function loadDependencies() {
  await mkdir(binary, { recursive: true });
  await writeFile(join(binary, "docker"), `#!/usr/bin/env node\nrequire('node:child_process').spawnSync(process.execPath,[${JSON.stringify(fileURLToPath(new URL("fake-docker.mjs", import.meta.url)))},...process.argv.slice(2)],{stdio:'inherit',env:process.env}).status===0?process.exit(0):process.exit(1);\n`, { mode: 0o755 });
  const [hosts, transport, imports, integrations, fixture, engine, patterns] = await Promise.all([
    import("../src/code-hosts.js"), import("../src/code-host-git.js"), import("../src/code-host-imports.js"),
    import("../src/integrations.js"), import("./code-host-fixture.js"), import("../src/engine.js"), import("../src/patterns/index.js"),
  ]);
  return { ...hosts, ...transport, ...imports, ...integrations, ...fixture, ...engine, ...patterns };
}
const modules = () => dependencies ??= loadDependencies();
after(async () => {
  if (dependencies) await (await import("../src/store.js")).flushWrites();
  await rm(home, { recursive: true, force: true });
  process.env.PATH = priorPath;
});

async function fixture(t: TestContext, advancedTarget = false) {
  const m = await modules(), root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-host-review-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "local"), remote = join(root, "remote.git"), upstream = join(root, "upstream");
  const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => gitAt(repo, ...args), upstreamGit = (...args: string[]) => gitAt(upstream, ...args);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.name", "fixture"); git("config", "user.email", "fixture@test");
  await writeFile(join(repo, "subject.txt"), "trusted local history\n"); git("add", "."); git("commit", "-qm", "trusted initial");
  const trusted = git("rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "-q", repo, remote]);
  execFileSync("git", ["clone", "-q", remote, upstream]);
  upstreamGit("config", "user.name", "fixture"); upstreamGit("config", "user.email", "fixture@test");
  const commit = async (name: string) => { await writeFile(join(upstream, name), `${name}\n`); upstreamGit("add", name); upstreamGit("commit", "-qm", name); return upstreamGit("rev-parse", "HEAD"); };
  const base = advancedTarget ? await commit("new-common.txt") : trusted;
  upstreamGit("branch", "feature", base);
  const targetIntermediate = advancedTarget ? await commit("target-middle.txt") : trusted;
  const target = advancedTarget ? await commit("target-final.txt") : trusted;
  upstreamGit("checkout", "-q", "feature"); const head = await commit("source-only.txt");
  // This is a throwaway local bare repository, never a configured provider remote.
  upstreamGit("push", "-q", "origin", "main", "feature");
  const provider = m.codeHostFixture(remote), integrations = new m.Integrations({ environment: { FIXTURE_CODE_HOST: "fixture-code-host-secret" }, fetch: provider.fetch });
  await integrations.load([{ id: "fixture", provider: "gitlab", project: "org/repo", credentialEnv: "FIXTURE_CODE_HOST", baseUrl: "https://gitlab-fixture.invalid/api/v4/", gitBaseUrl: "https://gitlab-fixture.invalid/" }]);
  const manager = { get: () => undefined, reviewCoverage: async () => { throw new Error("Not used by this fixture"); }, withIdleRepository: async (_repo: string, operation: () => unknown) => operation() } as any;
  const options = { integrations, manager, projects: { get: () => undefined } as any, file: join(root, "actions.json"), git: new m.CodeHostGit(provider.command) };
  const service = new m.CodeHosts(options), input = { integration: "fixture", key: "7", repo };
  const fetchPreview = async () => { const preview = await service.preview(input); return service.fetch(preview.id); };
  const previewRefs = () => git("for-each-ref", "--format=%(refname)", "refs/codeflow/external").split("\n").filter(Boolean);
  return { m, root, repo, remote, trusted, base, targetIntermediate, target, head, git, provider, integrations, options, service, input, fetchPreview, previewRefs };
}

const STOP = "QA_STOPPED_BEFORE_AGENT_DISPATCH";
function runInput(f: Awaited<ReturnType<typeof fixture>>, baseRef: string): StartRunInput {
  return { pattern: f.m.findPattern("solo")!, task: "Independent code-host regression", repo: f.repo, baseRef, roles: { agent: ["claude"] }, options: {}, loop: { check: "true" } };
}
async function stopAtDispatch(manager: RunManager, input: StartRunInput): Promise<Run> {
  let captured: Run | undefined;
  await assert.rejects(manager.start({ ...input, beforeDispatch: async run => { captured = run; throw new Error(STOP); } }), new RegExp(STOP));
  assert.ok(captured, "the intended start reached registration, without dispatching an agent");
  return captured;
}

test("new imported target, base and intermediate identities cannot become native run bases", async t => {
  const f = await fixture(t, true), manager = new f.m.RunManager(f.m.findPattern);
  try {
    await f.fetchPreview();
    for (const [label, sha] of Object.entries({ source: f.head, target: f.target, base: f.base, intermediate: f.targetIntermediate })) {
      assert.equal(await f.m.isCodeHostImport(f.repo, sha), true, `${label} must retain imported provenance`);
      await assert.rejects(manager.start({ ...runInput(f, sha), loop: { agentContainer: { image: "bad image!" } } }), /untrusted fetched PR code/, `${label} must stop before later startup validation`);
    }
    f.git("branch", "alias-for-imported-target", f.target);
    assert.equal(await f.m.isCodeHostImport(f.repo, "alias-for-imported-target"), true);
    assert.equal(await f.m.isCodeHostImport(f.repo, f.trusted), false);
    const native = await stopAtDispatch(manager, runInput(f, f.trusted));
    assert.equal(native.loop.agentContainer, undefined, "already trusted local history remains usable natively");
    await f.service.preview(f.input); // replacement removes only temporary preview refs
    assert.deepEqual(f.previewRefs(), []);
    for (const sha of [f.head, f.target, f.base, f.targetIntermediate]) assert.equal(await f.m.isCodeHostImport(f.repo, sha), true);
  } finally { await manager.shutdown(); }
});

test("a local branch ahead of the incoming target keeps its existing ancestors native", async t => {
  const f = await fixture(t, true);
  f.git("fetch", "-q", f.remote, "main:refs/heads/local-target");
  f.git("merge", "--ff-only", "local-target"); f.git("branch", "-D", "local-target");
  await writeFile(join(f.repo, "local-ahead.txt"), "explicit local work\n"); f.git("add", "."); f.git("commit", "-qm", "trusted local ahead");
  const localAhead = f.git("rev-parse", "HEAD");
  await f.fetchPreview();
  for (const sha of [f.trusted, f.base, f.targetIntermediate, f.target, localAhead]) assert.equal(await f.m.isCodeHostImport(f.repo, sha), false, "incoming history already reachable locally must remain trusted");
  assert.equal(await f.m.isCodeHostImport(f.repo, f.head), true, "upstream-only source still requires isolation");
});

test("post-import failures remove preview refs immediately and keep provenance", async t => {
  const f = await fixture(t);
  const failing: CodeHostGitCommand = async (args, cwd, options) => args.includes("diff")
    ? { code: 1, stdout: "", stderr: "Injected failure after the atomic local import" }
    : f.provider.command(args, cwd, options);
  const service = new f.m.CodeHosts({ ...f.options, git: new f.m.CodeHostGit(failing) });
  const preview = await service.preview(f.input);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(service.fetch(preview.id), /Code host Git action failed/);
    assert.deepEqual(f.previewRefs(), [], "failed fetches cannot accumulate invisible preview refs");
    assert.equal(await f.m.isCodeHostImport(f.repo, f.head), true, "cleanup must not erase imported-code provenance");
    assert.deepEqual(service.history(), [], "a rolled-back local fetch is not an ambiguous provider mutation");
  }
  await service.preview(f.input); assert.deepEqual(f.previewRefs(), []);
  const abort = new AbortController(), lateAbort: CodeHostGitCommand = async (args, cwd, options) => {
    const result = await f.provider.command(args, cwd, options);
    if (args.includes("diff") && result.code === 0) abort.abort();
    return result;
  };
  const aborted = new f.m.CodeHosts({ ...f.options, file: join(f.root, "aborted-actions.json"), git: new f.m.CodeHostGit(lateAbort) });
  const next = await aborted.preview(f.input);
  await assert.rejects(aborted.fetch(next.id, abort.signal));
  assert.deepEqual(f.previewRefs(), [], "cleanup also covers the staging wrapper's final abort check");
  assert.equal(await f.m.isCodeHostImport(f.repo, f.head), true);
});

test("an ordinary missing base keeps the friendly startup error", async t => {
  const f = await fixture(t), manager = new f.m.RunManager(f.m.findPattern);
  try {
    await assert.rejects(manager.start(runInput(f, "missing-ordinary-base")), error => error instanceof Error && /Base branch.*missing-ordinary-base.*not found/.test(error.message) && !/rev-parse|fatal:|Needed a single revision/.test(error.message));
    assert.equal(manager.list().length, 0);
  } finally { await manager.shutdown(); }
});

test("run preflight refusals are plain while failures after registration retain an exact unknown receipt", async t => {
  const f = await fixture(t), preview = await f.fetchPreview(), manager = new f.m.RunManager(f.m.findPattern);
  const { createCodeHostsApi } = await import("../src/code-hosts-api.js");
  let registered: Run | undefined;
  const api = createCodeHostsApi({ integrations: f.integrations, manager, projects: f.options.projects, service: f.service,
    build: async body => ({ ...body, pattern: f.m.findPattern(body.pattern)! }),
    persist: async run => { registered = run; throw new Error("Injected registered-run receipt failure"); },
  });
  const server = createServer((req, res) => { void api.handle(req, res, req.url!.split("/").filter(Boolean)).catch(error => { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const start = () => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/code-hosts/${preview.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: { pattern: "solo", task: "No real agent dispatch", roles: { agent: ["claude"] }, options: {}, loop: { check: "true", agentContainer: { image: "prepared/fixture:local" } } } }) });
  const originalDown = process.env.FAKE_DOCKER_DOWN;
  try {
    process.env.FAKE_DOCKER_DOWN = "1";
    const refused = await start(), refusal = await refused.json();
    assert.equal(refused.ok, false); assert.equal(refusal.ambiguous, false); assert.match(refusal.error, /Docker/); assert.doesNotMatch(refusal.error, /receipt is unknown/);
    assert.equal(manager.list().length, 0); assert.equal(Boolean(registered), false);
    assert.deepEqual(f.service.history().filter(entry => entry.kind === "run"), []);
    delete process.env.FAKE_DOCKER_DOWN;
    const failed = await start(), failure = await failed.json();
    assert.equal(failed.ok, false); assert.equal(failure.ambiguous, true); assert.match(failure.error, /registered-run receipt failure/);
    assert.ok(registered); assert.equal(manager.list().length, 1);
    const receipt = f.service.history().find(entry => entry.kind === "run");
    assert.equal(receipt?.status, "unknown"); assert.equal(receipt?.runId, registered.id);
    assert.equal(manager.get(registered.id)?.status, "failed");
  } finally {
    if (originalDown === undefined) delete process.env.FAKE_DOCKER_DOWN; else process.env.FAKE_DOCKER_DOWN = originalDown;
    await new Promise<void>(resolve => server.close(() => resolve())); await manager.shutdown();
  }
});

test("a legitimate isolated review continuation keeps code provenance and container restrictions", async t => {
  const f = await fixture(t), preview = await f.fetchPreview(), manager = new f.m.RunManager(f.m.findPattern);
  try {
    const source = f.service.source(preview.id);
    const parent = await stopAtDispatch(manager, { ...runInput(f, f.head), checkpointOnFinish: true, externalSource: source, trust: "safe", loop: { check: "true", agentContainer: { image: "prepared/fixture:local" }, container: { image: "node:22", network: false } } });
    const child = await stopAtDispatch(manager, { ...runInput(f, f.head), checkpointOnFinish: true, parentRunId: parent.id, loop: {} });
    assert.ok(child.loop.agentContainer); assert.equal(child.loop.container?.network, false); assert.equal(child.trust, "safe");
    assert.deepEqual(child.externalSource?.code, source.code); assert.equal(child.lockdownOnHost, undefined);
  } finally { await manager.shutdown(); }
});

test("legacy migration marks new target history while preserving checked-out imports and preexisting main", async t => {
  for (const advanced of [false, true]) {
    const f = await fixture(t, advanced), prefix = "codeflow/external/legacy-review";
    f.git("fetch", "-q", f.remote, `feature:refs/heads/${prefix}/source`, `main:refs/heads/${prefix}/target`);
    f.git("checkout", "-q", `${prefix}/source`);
    const untrusted = advanced ? [f.head, f.base, f.targetIntermediate, f.target] : [f.head];
    for (const sha of untrusted) assert.equal(await f.m.isCodeHostImport(f.repo, sha), true, "legacy raw SHA fallback covers all newly imported history");
    assert.equal(await f.m.isCodeHostImport(f.repo, "main"), false, "normal preexisting main is not a legacy import");
    await f.m.clearOrphanedCodeHostImports(f.repo);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
    assert.equal(f.git("symbolic-ref", "HEAD"), `refs/heads/${prefix}/source`);
    assert.equal(f.git("for-each-ref", "--format=%(refname)", `refs/heads/${prefix}/target`), "");
    for (const sha of untrusted) assert.equal(await f.m.isCodeHostImport(f.repo, sha), true, "target cleanup cannot erase durable provenance");
    assert.equal(await f.m.isCodeHostImport(f.repo, "main"), false);
    f.git("checkout", "-q", "main"); await f.m.clearOrphanedCodeHostImports(f.repo);
    assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/heads/codeflow/external"), "");
    for (const sha of untrusted) assert.equal(await f.m.isCodeHostImport(f.repo, sha), true);
    assert.equal(await f.m.isCodeHostImport(f.repo, f.trusted), false);
  }
});
