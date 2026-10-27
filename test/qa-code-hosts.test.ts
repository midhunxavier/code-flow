import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Integrations } from "../src/integrations.js";
import { CodeHosts, CodeHostError, validateCodeHostDocument } from "../src/code-hosts.js";
import { CodeHostGit, codeHostRemote } from "../src/code-host-git.js";
import { codeHostFixture } from "./code-host-fixture.js";
import type { Run } from "../src/engine.js";
process.env.PATH = `${fileURLToPath(new URL("fake-bin", import.meta.url))}:${process.env.PATH}`;

async function fixture(t: any, provider: "gitlab" | "bitbucket" = "gitlab") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeflow-code-host-test-"))); t.after(() => rm(root, { recursive: true, force: true })); const repo = join(root, "repo"), remote = join(root, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo]); await writeFile(join(repo, "subject.txt"), "original\n"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"); const target = git("rev-parse", "HEAD"); git("checkout", "-qb", "feature"); await writeFile(join(repo, "subject.txt"), "reviewed\n"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "source"); const head = git("rev-parse", "HEAD"); execFileSync("git", ["clone", "--bare", "-q", repo, remote]); git("checkout", "-q", "main"); git("branch", "-D", "feature");
  const upstream = codeHostFixture(remote), integrations = new Integrations({ environment: { FIXTURE_CODE_HOST: "fixture-code-host-secret" }, fetch: upstream.fetch }); await integrations.load([{ id: "fixture", provider, project: "org/repo", credentialEnv: "FIXTURE_CODE_HOST", baseUrl: `https://${provider}-fixture.invalid/${provider === "gitlab" ? "api/v4/" : "2.0/"}`, gitBaseUrl: `https://${provider}-fixture.invalid/` }]);
  let now = Date.now(), run: Run | undefined; const manager = { get: () => run, reviewCoverage: async () => ({ head: run?.verification?.head, stale: false }), withIdleRepository: async (_repo: string, operation: () => unknown) => await operation() } as any;
  let member = true; const service = new CodeHosts({ integrations, manager, projects: { get: () => member ? { repos: [repo] } : undefined } as any, file: join(root, "actions.json"), git: new CodeHostGit(upstream.command), now: () => now });
  return { root, repo, remote, head, target, git, integrations, upstream, service, manager, setRun: (value: Run) => { run = value; }, revoke: () => { member = false; }, advance: () => { now += 16 * 60_000; } };
}

import { isCodeHostImport, clearOrphanedCodeHostImports } from "../src/code-host-imports.js";
import { listBranches } from "../src/git.js";

const plain = (status: number) => (error: unknown) => error instanceof CodeHostError && error.status === status && !error.ambiguous;
test("fetch refs stay outside branches, are reused and cleaned, while raw commit provenance survives", async t => {
  const f = await fixture(t);
  f.git("checkout", "-qb", "feature", f.head); await writeFile(join(f.repo, "second.txt"), "another incoming commit"); f.git("add", "."); f.git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "second source commit");
  execFileSync("git", ["fetch", "-q", f.repo, "feature:refs/heads/feature"], { cwd: f.remote }); f.git("checkout", "-q", "main"); f.git("branch", "-D", "feature");
  const input = { integration: "fixture", key: "7", repo: f.repo };
  const preview = await f.service.preview(input);
  const first = await f.service.fetch(preview.id), again = await f.service.fetch(preview.id);
  assert.deepEqual(first.fetched, again.fetched);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/heads/codeflow/external"), "");
  assert.equal((await listBranches(f.repo)).branches.some(branch => branch.name.includes("codeflow/external")), false);
  assert.ok(await isCodeHostImport(f.repo, first.head));
  assert.ok(await isCodeHostImport(f.repo, f.head), "earlier source-only commits keep their provenance too");
  assert.equal(await isCodeHostImport(f.repo, "main"), false);
  const next = await f.service.preview(input);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/codeflow/external"), "");
  assert.throws(() => f.service.get(preview.id), /expired/);
  assert.ok(await isCodeHostImport(f.repo, first.head), "SHA cannot lose provenance when a preview is replaced");
  await f.service.fetch(next.id);
  const restarted = new CodeHosts({ integrations: f.integrations, manager: f.manager, projects: { get: () => undefined } as any, file: join(f.root, "actions.json") });
  await restarted.load();
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/codeflow/external"), "");
  assert.ok(await isCodeHostImport(f.repo, first.head));
  const latest = await f.service.preview(input); await f.service.fetch(latest.id); f.advance();
  assert.throws(() => f.service.get(latest.id), /expired/);
  await f.service.preview(input); // awaits queued expiry cleanup
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/codeflow/external"), "");
});

test("legacy imports are hidden and migrated before cleanup, preserving an active checkout", async t => {
  const f = await fixture(t), prefix = "codeflow/external/legacy";
  f.git("branch", `${prefix}/source`, f.head); f.git("branch", `${prefix}/target`, f.target);
  assert.equal((await listBranches(f.repo)).branches.some(branch => branch.name.startsWith(prefix)), false);
  assert.ok(await isCodeHostImport(f.repo, f.head));
  f.git("checkout", "-q", `${prefix}/source`);
  await clearOrphanedCodeHostImports(f.repo);
  assert.equal(f.git("rev-parse", "HEAD"), f.head, "cleanup preserves an existing checkout");
  assert.ok(await isCodeHostImport(f.repo, f.head));
  f.git("checkout", "-q", "main"); await clearOrphanedCodeHostImports(f.repo);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/heads/codeflow/external"), "");
  assert.ok(await isCodeHostImport(f.repo, f.head));
});

test("validation refusals leave no ambiguous receipt or ledger pressure, but provider effects remain unknown", async t => {
  const f = await fixture(t, "bitbucket"), preview = await f.service.preview({ integration: "fixture", key: "7", repo: f.repo });
  for (let n = 0; n < 205; n++) await assert.rejects(f.service.review(preview.id, { action: "approve" }), plain(400));
  assert.deepEqual(f.service.history(), []);
  assert.equal(f.upstream.read().mutations.length, 0);
  await f.service.fetch(preview.id);
  for (const request of [
    { action: "comment", body: "note", path: "subject.txt", line: 0 },
    { action: "comment", body: "note", path: "absent.txt", line: 1 },
    { action: "comment", body: " " },
  ] as const) await assert.rejects(f.service.review(preview.id, request), plain(400));
  assert.equal(f.service.history().length, 1, "only the confirmed fetch remains");
  await assert.rejects(f.service.push(preview.id, "missing-plan"), plain(409));
  await assert.rejects(f.service.merge(preview.id, "missing-plan"), plain(409));
  f.upstream.set({ failMutation: true });
  await assert.rejects(f.service.review(preview.id, { action: "comment", body: "Effect may have happened" }), error => error instanceof CodeHostError && error.ambiguous);
  assert.equal(f.service.history()[0]?.status, "unknown");
  await assert.rejects(f.service.review(preview.id, { action: "comment", body: "Do not replay" }), plain(409));
});

test("preview input errors are precise client errors without Git stderr or changed-membership wording", async t => {
  const f = await fixture(t), input = { integration: "fixture", key: "7", repo: f.repo };
  for (const repo of ["relative", f.root, join(f.root, "absent")]) {
    await assert.rejects(f.service.preview({ ...input, repo }), error => plain(400)(error) && !/stderr|fatal:|ENOENT|rev-parse/.test((error as Error).message));
  }
  await assert.rejects(f.service.preview({ ...input, integration: "missing" }), plain(404));
  await f.integrations.load([{ id: "linear", provider: "linear", project: "ENG", credentialEnv: "FIXTURE_CODE_HOST" }]);
  await assert.rejects(f.service.preview({ ...input, integration: "linear" }), plain(400));
  f.revoke(); await assert.rejects(f.service.preview({ ...input, project: "missing" }), plain(404));
  const wrong = new CodeHosts({ integrations: f.integrations, manager: f.manager, projects: { get: () => ({ repos: [] }) } as any });
  await assert.rejects(wrong.preview({ ...input, project: "wrong" }), error => plain(400)(error) && /belongs to this project/.test((error as Error).message));
});

test("oversized source histories fail before creating local preview or provenance refs", async t => {
  const f = await fixture(t), preview = await f.service.preview({ integration: "fixture", key: "7", repo: f.repo });
  const transport = new CodeHostGit(async (args, cwd, options) => args.includes("rev-list") ? { code: 0, stdout: `${f.head}\n`.repeat(1001), stderr: "" } : f.upstream.command(args, cwd, options));
  const saved = f.service.get(preview.id);
  await assert.rejects(transport.fetch(f.repo, saved.session, saved.refs), /1,000-commit import limit/);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/codeflow/external", "refs/codeflow/untrusted-code"), "");
});


test("untrusted text context or a locked-down parent cannot substitute for pinned code provenance", async t => {
  const f = await fixture(t), preview = await f.service.preview({ integration: "fixture", key: "7", repo: f.repo }); await f.service.fetch(preview.id);
  const { RunManager } = await import("../src/engine.js"), { findPattern } = await import("../src/patterns/index.js");
  const manager = new RunManager(findPattern);
  const input = { pattern: findPattern("solo")!, task: "Do not start native", repo: f.repo, baseRef: f.head, roles: { agent: ["claude" as const] }, options: {} };
  await assert.rejects(manager.start({ ...input, externalSource: { integration: "fixture", provider: "gitlab", kind: "issue", key: "7", title: "Untrusted issue", body: "", id: "text", importedAt: Date.now(), expiresAt: Date.now() + 60000, trusted: false, untrusted: true } as any }), /untrusted fetched PR code/);
  manager.get = () => ({ id: "parent", repo: f.repo, lockdown: "Untrusted issue", trust: "safe" }) as any;
  await assert.rejects(manager.start({ ...input, parentRunId: "parent" }), /untrusted fetched PR code/);
  assert.equal(manager.list().length, 0);
});
