// Opt-in because the real staging limit needs an incompressible >256 MiB fixture.
// Bare cloning/direct refs only: this test never pushes even to its scratch origin.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, open, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { reserveQaPorts } from "./qa-port-block.js";
const root = fileURLToPath(new URL("..", import.meta.url));
test("oversized actual Git fetch is refused from the browser and cleans the quarantine", { skip: process.env.CODEFLOW_QA_LARGE_FETCH !== "1", timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "qa-final-large-fetch-"))), repo = join(directory, "local"), upstream = join(directory, "upstream"), remote = join(directory, "origin.git"), home = join(directory, "home"), quarantine = join(directory, "quarantine"), evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
  let server: ChildProcess | undefined, browser: Browser | undefined, output = ""; const ports = await reserveQaPorts();
  const git = (at: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@test", ...args], { cwd: at, encoding: "utf8" }).trim();
  const token = "qa-size-bound", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }, base = `http://127.0.0.1:${ports.port}`, observations: any[] = [], errors: string[] = [];
  const api = async (path: string, body?: unknown) => { const r = await fetch(base + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) }); assert.ok(r.ok, `${r.status} ${await r.clone().text()}`); return r.json(); };
  try {
    const disk = await statfs(directory); assert.ok(disk.bavail * disk.bsize > 2 * 1024 ** 3, "Need 2 GiB free for the bounded temporary fixture");
    for (const path of [repo, home, quarantine]) await mkdir(path); git(repo, "init", "-q", "-b", "main"); await writeFile(join(repo, "README.md"), "trusted local fixture\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "trusted target"); git(directory, "clone", "-q", repo, upstream); git(upstream, "checkout", "-qb", "feature");
    const blob = await open(join(upstream, "oversized.bin"), "wx"); try { for (let n = 0; n < 257; n++) await blob.write(randomBytes(1024 * 1024)); } finally { await blob.close(); }
    git(upstream, "add", "oversized.bin"); git(upstream, "commit", "-qm", "oversized upstream fixture"); git(directory, "clone", "--bare", "-q", upstream, remote); const before = git(repo, "rev-parse", "HEAD"), beforeObjects = git(repo, "count-objects", "-v");
    const state = join(directory, "provider.json"); await writeFile(state, JSON.stringify({ comments: [], mutations: [], failMutation: false, queue: false, missingPolicy: false }));
    execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await ports.release();
    server = spawn(process.execPath, ["--import", "tsx", "--import", "./test/fake-code-host-transport.ts", "src/server.ts"], { cwd: root, env: { ...process.env, TMPDIR: quarantine, PORT: String(ports.port), CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, FAKE_CODE_HOST_REMOTE: remote, FAKE_CODE_HOST_STATE: state, FIXTURE_CODE_HOST: "fixture-code-host-secret", CODEFLOW_INTEGRATIONS_JSON: JSON.stringify([{ id: "gitlab", provider: "gitlab", project: "org/repo", credentialEnv: "FIXTURE_CODE_HOST", baseUrl: "https://gitlab-fixture.invalid/api/v4/", gitBaseUrl: "https://gitlab-fixture.invalid/" }]), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); server.stdout?.on("data", d => output += d); server.stderr?.on("data", d => output += d);
    for (let n = 0; ; n++) { if (await fetch(base + "/api/health", { headers }).then(r => r.ok, () => false)) break; assert.ok(n < 200, output); await new Promise(r => setTimeout(r, 50)); }
    const project = await api("/api/projects", { name: "Oversize code host fixture", repos: [repo] }); await fetch(base + `/api/integration-connections/projects/${project.id}`, { method: "PUT", headers, body: JSON.stringify({ repository: repo, connectionId: "gitlab" }) });
    browser = await chromium.launch({ channel: "chrome", headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message)); page.on("console", m => { if (m.type() === "error") observations.push({ console: m.text() }); }); page.on("response", r => { if (r.status() >= 400) observations.push({ status: r.status(), url: r.url() }); });
    await page.goto(`${base}/?token=${token}#/project/${project.id}/connections`); await page.getByRole("article", { name: "GitLab connections", exact: true }).getByRole("button", { name: "Choose issue or PR" }).click(); await page.getByRole("button", { name: "Review pull request", exact: true }).click(); await page.getByRole("button", { name: "Load PR preview", exact: true }).click(); const panel = page.getByRole("region", { name: "GitLab and Bitbucket code hosts", exact: true }); const started = Date.now();
    const response = page.waitForResponse(r => r.url().endsWith("/fetch") && r.request().method() === "POST", { timeout: 120000 }); await panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true }).click(); const rejected = await response, body = await rejected.json(); assert.ok(rejected.status() >= 400, JSON.stringify(body)); assert.match(body.error, /exceeds storage limits.*256 MiB/); assert.doesNotMatch(body.error, /push/); await panel.getByRole("alert").waitFor();
    assert.equal(git(repo, "rev-parse", "HEAD"), before); assert.equal(git(repo, "status", "--porcelain"), ""); assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/codeflow/external"), ""); const afterQuarantine = (await readdir(quarantine)).filter(name => name.startsWith("codeflow-code-host-")); assert.deepEqual(afterQuarantine, []); assert.deepEqual(errors, []);
    assert.equal(git(repo, "count-objects", "-v"), beforeObjects);
    const receipt = { inputBytes: 257 * 1024 ** 2, elapsedMs: Date.now() - started, status: rejected.status(), error: body.error, beforeObjects, afterObjects: git(repo, "count-objects", "-v"), observations }; if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "oversized-fetch-refused.png") }); await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2)); }
  } finally { await browser?.close(); if (server?.exitCode === null && server.signalCode === null) { const done = new Promise(resolve => server!.once("exit", resolve)); server.kill("SIGTERM"); await done; } if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, "server.log"), output); } await ports.release(); await rm(directory, { recursive: true, force: true }); }
});
