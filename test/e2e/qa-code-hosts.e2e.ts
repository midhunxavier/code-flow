import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { CodeHostPreview } from "../../src/code-hosts.js";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url)), token = "qa-code-host-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let directory: string, repo: string, remote: string, home: string, stateFile: string, binary: string, containerRecords: string, server: ChildProcess, browser: Browser, page: Page, base: string, port: number;
let project: string;
const errors: string[] = [];
const listings: unknown[] = [];
let serverOutput = "", restarting = false;
const expectedDisconnects: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function api<T = any>(path: string, body?: unknown): Promise<T> { const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json() as Promise<T>; }
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const deadline = Date.now() + 40_000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > deadline) throw new Error(`Code host fixture timed out: ${JSON.stringify(value)}`); await new Promise((accept) => setTimeout(accept, 100)); } }
async function start() { server = spawn(process.execPath, ["--import", "tsx", "--import", "./test/fake-code-host-transport.ts", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), FIXTURE_CODE_HOST: "fixture-code-host-secret", FAKE_DOCKER_RECORD_DIR: containerRecords, FAKE_CODE_HOST_REMOTE: remote, FAKE_CODE_HOST_STATE: stateFile, CODEFLOW_INTEGRATIONS_JSON: JSON.stringify(["gitlab", "bitbucket"].map((provider) => ({ id: provider, provider, project: "org/repo", credentialEnv: "FIXTURE_CODE_HOST", baseUrl: `https://${provider}-fixture.invalid/${provider === "gitlab" ? "api/v4/" : "2.0/"}`, gitBaseUrl: `https://${provider}-fixture.invalid/` }))), PATH: `${binary}:${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" }); let output = ""; server.stdout?.on("data", (chunk) => { output += chunk; serverOutput += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; serverOutput += chunk; }); for (let count = 0; ; count++) { if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) return; if (count >= 150 || server.exitCode !== null) throw new Error(output); await new Promise((accept) => setTimeout(accept, 60)); } }
async function stop() { if (!server || server.exitCode !== null || server.signalCode !== null) return; server.kill("SIGTERM"); await new Promise<void>((accept) => { const timer = setTimeout(() => { server.kill("SIGKILL"); accept(); }, 5000); server.once("exit", () => { clearTimeout(timer); accept(); }); }); }
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-code-host-browser-"))); repo = join(directory, "repo"); remote = join(directory, "upstream.git"); home = join(directory, "home"); stateFile = join(directory, "provider.json");
  binary = join(directory, "bin"); containerRecords = join(directory, "containers"); await mkdir(binary); await mkdir(containerRecords); await writeFile(join(binary, "docker"), `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);const file=args.includes('--entrypoint')?${JSON.stringify(join(root, "test/fake-agent-docker.mjs"))}:${JSON.stringify(join(root, "test/fake-docker.mjs"))};const result=spawnSync(process.execPath,[file,...args],{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`, { mode: 0o755 });
  git(directory, "init", "-q", "-b", "main", repo); await mkdir(join(repo, ".codeflow")); await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ prove: false })); await writeFile(join(repo, "subject.txt"), "initial\n"); await writeFile(join(repo, "AGENTS.md"), "TRUSTED_TARGET_CONVENTIONS\nKeep tests passing.\n"); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "trusted target"); git(repo, "checkout", "-qb", "feature"); await writeFile(join(repo, "subject.txt"), "incoming source\n"); await writeFile(join(repo, "AGENTS.md"), "UNTRUSTED_PR_INSTRUCTION_MUST_NOT_BECOME_CONVENTIONS\n"); git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "untrusted source"); git(directory, "clone", "--bare", "-q", repo, remote); git(repo, "checkout", "-q", "main"); git(repo, "branch", "-D", "feature"); await writeFile(stateFile, JSON.stringify({ comments: [{ id: 1, body: "Inspect incoming subject change", resolved: false }], mutations: [], failMutation: false, queue: false, missingPolicy: false }));
  port = await new Promise<number>((accept) => { const listener = createServer().listen(0, "127.0.0.1", () => { const port = (listener.address() as AddressInfo).port; listener.close(() => accept(port)); }); }); base = `http://127.0.0.1:${port}`; execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root }); await start(); browser = await chromium.launch({ channel: "chrome", headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15_000); page.on("response", response => { if (response.url().includes("/items?")) void response.text().then(body => listings.push({ url: response.url(), status: response.status(), body })); }); page.on("pageerror", (error) => errors.push(error.message)); page.on("console", message => { if (message.type() !== "error") return; if (restarting && /net::ERR_(?:CONNECTION_REFUSED|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE)/.test(message.text())) expectedDisconnects.push(message.text()); else errors.push(message.text()); }); project = (await api("/api/projects", { name: "Code-host QA", repos: [repo] })).id;
  assert.equal((await fetch(base + `/api/integration-connections/projects/${project}`, { method: "PUT", headers, body: JSON.stringify({ repository: repo, connectionId: "gitlab" }) })).status, 200);
  await mkdir(join(root, "output/playwright/qa-code-hosts"), { recursive: true });
  await page.addInitScript((repo) => { localStorage.setItem("repo", repo); localStorage.setItem("sideOpen", "0"); }, repo);
});
after(async () => { await browser?.close(); await stop(); await writeFile(join(root, "output/playwright/qa-code-hosts/server.log"), serverOutput); await writeFile(join(root, "output/playwright/qa-code-hosts/browser-errors.json"), JSON.stringify({ errors, expectedDisconnects, listings }, null, 2)); if (directory) await rm(directory, { recursive: true, force: true }); });


async function openPanel() {
  await page.goto(base + `/?token=${token}#/project/${project}/connections`);
  await page.getByRole("article", { name: "GitLab connections", exact: true }).getByRole("button", { name: "Choose issue or PR" }).click();
  await page.getByRole("button", { name: "Review pull request", exact: true }).click();
  try { await page.getByRole("button", { name: "Load PR preview", exact: true }).click(); } catch (error) { await page.screenshot({ path: join(root, "output/playwright/qa-code-hosts/picker-failure.png") }); await writeFile(join(root, "output/playwright/qa-code-hosts/picker-failure.json"), JSON.stringify({ listings, body: await page.locator("body").innerText(), errors }, null, 2)); throw error; }
  const panel = page.getByRole("region", { name: "GitLab and Bitbucket code hosts", exact: true });
  await panel.getByRole("heading", { name: "Fixture merge request", exact: true }).waitFor(); return panel;
}

test("fetched PR refs never become normal run bases, including raw SHAs across restart", { timeout: 60000 }, async () => {
  const panel = await openPanel();
  await panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true }).click(); await panel.getByText(/Fetched diff · base/).waitFor();
  const refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/codeflow/external").split("\n");
  assert.equal(refs.length, 2);
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/codeflow/external"), "");
  await panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true }).click();
  await until(() => panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true }).isEnabled(), Boolean);
  assert.deepEqual(git(repo, "for-each-ref", "--format=%(refname)", "refs/codeflow/external").split("\n"), refs);
  assert.equal((await api(`/api/branches?repo=${encodeURIComponent(repo)}`)).branches.some((branch: any) => /codeflow\/external/.test(branch.name)), false);
  const head = git(remote, "rev-parse", "feature"); git(repo, "branch", "imported-alias", head);
  const refuse = async (baseRef: string) => {
    const response = await fetch(base + "/api/runs", { method: "POST", headers, body: JSON.stringify({ repo, project, pattern: "solo", task: "Must never run untrusted instructions on the host", roles: { agent: ["claude"] }, baseRef }) });
    assert.equal(response.status, 409, await response.clone().text()); assert.match((await response.json()).error, /untrusted fetched PR code/);
  };
  for (const ref of [refs.find(ref => ref.endsWith("/source"))!, head, "imported-alias"]) await refuse(ref);
  assert.equal((await api<Run[]>("/api/runs")).length, 0);
  await page.screenshot({ path: join(root, "output/playwright/qa-code-hosts/imports.png") });
  restarting = true; await stop(); await start(); await page.reload(); await page.getByRole("article", { name: "GitLab connections", exact: true }).waitFor(); restarting = false;
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/codeflow/external"), "");
  await refuse(head);
  assert.deepEqual(errors, []);
});

test("inline review requires a fetched positive line and clears its location before the next general comment", { timeout: 60000 }, async () => {
  const panel = await openPanel();
  await panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true }).click(); await panel.getByText(/Fetched diff · base/).waitFor();
  await panel.getByText(/Review comments and discussions ·/).click();
  await panel.getByLabel("Code host review comment", { exact: true }).fill("Inline note");
  await panel.getByLabel("Code host inline path", { exact: true }).fill("subject.txt");
  const publish = panel.getByRole("button", { name: "Publish commit-scoped review comment", exact: true });
  assert.equal(await publish.isDisabled(), true);
  for (const line of ["0", "-1", "1.5"]) { await panel.getByLabel("Code host inline line", { exact: true }).fill(line); assert.equal(await publish.isDisabled(), true); }
  await panel.getByLabel("Code host inline line", { exact: true }).fill("1"); await publish.click();
  await panel.getByRole("status").getByText(/Provider confirmed/).waitFor();
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).mutations.at(-1).body.position.new_line, 1);
  await panel.getByRole("button", { name: "Load pinned PR preview", exact: true }).click();
  await panel.getByText(/Review comments and discussions ·/).click();
  for (const label of ["Code host inline path", "Code host inline line"]) assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), "");
  await panel.getByLabel("Code host review comment", { exact: true }).fill("General note"); await publish.click(); await panel.getByRole("status").getByText(/Provider confirmed/).waitFor();
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).mutations.at(-1).body.position, undefined);
  assert.equal((await api("/api/code-hosts")).history.some((entry: any) => entry.status === "unknown"), false);
  assert.deepEqual(errors, []);
});

test("pre-effect refusals are plain errors and every integration's genuine unknown outcomes remain reachable", { timeout: 60000 }, async () => {
  const preview = await api<CodeHostPreview>("/api/code-hosts/preview", { integration: "bitbucket", key: "7", repo });
  const post = async (input: unknown) => fetch(base + `/api/code-hosts/${preview.id}/review`, { method: "POST", headers, body: JSON.stringify(input) });
  for (let n = 0; n < 205; n++) { const refused = await post({ action: "approve" }); assert.equal(refused.status, 400); assert.equal((await refused.json()).ambiguous, false); }
  assert.equal((await api("/api/code-hosts")).history.some((entry: any) => entry.status === "unknown"), false);
  const state = JSON.parse(await readFile(stateFile, "utf8")); await writeFile(stateFile, JSON.stringify({ ...state, failMutation: true }));
  const failed = await post({ action: "comment", body: "Provider outcome unavailable" }); assert.equal(failed.status, 502); assert.equal((await failed.json()).ambiguous, true);
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, "utf8")), failMutation: false }));
  const panel = await openPanel(); await panel.getByText(/Explicit action history ·/).click();
  const entry = panel.locator("li").filter({ hasText: /bitbucket #7 · review: unknown/ }); await entry.waitFor();
  await page.screenshot({ path: join(root, "output/playwright/qa-code-hosts/all-history.png") });
  await entry.getByRole("button", { name: /I inspected this exact outcome/ }).click();
  await until(() => api("/api/code-hosts"), value => !value.history.some((entry: any) => entry.status === "unknown"));
  assert.deepEqual(errors, []);
});

test("preview action buttons expire without interaction", { timeout: 30000 }, async () => {
  await page.route("**/api/code-hosts/preview", async route => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), expiresAt: Date.now() + 1500 } });
  });
  try {
    const panel = await openPanel();
    const fetch = panel.getByRole("button", { name: "Fetch pinned code and diff", exact: true });
    assert.equal(await fetch.isEnabled(), true);
    await until(() => fetch.isDisabled(), Boolean);
    await panel.getByText(/Review comments and discussions ·/).click();
    assert.equal(await panel.getByRole("button", { name: "Approve exact GitLab source commit", exact: true }).isDisabled(), true);
    await page.screenshot({ path: join(root, "output/playwright/qa-code-hosts/expired.png") });
  } finally { await page.unroute("**/api/code-hosts/preview"); }
});

test("invalid preview inputs return client errors through the real HTTP route", async () => {
  for (const [input, expected] of [
    [{ integration: "missing", repo }, 404], [{ integration: "gitlab", repo: "relative" }, 400], [{ integration: "gitlab", repo: directory }, 400],
    [{ integration: "gitlab", repo: join(directory, "missing") }, 400], [{ integration: "gitlab", repo, project: "missing-project" }, 404],
  ] as const) {
    const response = await fetch(base + "/api/code-hosts/preview", { method: "POST", headers, body: JSON.stringify({ key: "7", ...input }) });
    assert.equal(response.status, expected); assert.doesNotMatch((await response.json()).error, /fatal:|ENOENT|rev-parse|membership changed/);
  }
  assert.deepEqual(errors, []);
});

test("new PR creation also expires without another render or provider mutation", { timeout: 30000 }, async () => {
  await page.route("**/api/code-hosts/create-preview", async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { ...input, id: "a".repeat(40), provider: "gitlab", repo, head: git(repo, "rev-parse", "main"), target: git(repo, "rev-parse", "main"), sourceBranch: "codeflow/pr/expiry-fixture", expiresAt: Date.now() + 1500 } });
  });
  try {
    const panel = await openPanel(); await panel.getByText("Create a new PR from a verified owned result", { exact: true }).click();
    await panel.getByLabel("New PR owned run", { exact: true }).fill("expiry-fixture"); await panel.getByLabel("New PR result branch", { exact: true }).fill("fixture-result"); await panel.getByLabel("New PR title", { exact: true }).fill("Expiry fixture");
    await panel.getByRole("button", { name: "Preview new PR and source branch", exact: true }).click();
    const create = panel.getByRole("button", { name: "Push new source branch and create PR", exact: true });
    await create.waitFor(); assert.equal(await create.isEnabled(), true); await until(() => create.isDisabled(), Boolean);
    await page.screenshot({ path: join(root, "output/playwright/qa-code-hosts/creation-expired.png") });
  } finally { await page.unroute("**/api/code-hosts/create-preview"); }
});
