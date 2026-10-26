import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";
import { copyFinalQaApp } from "../qa-final-app.js";

test("repository defaults respect repository policy and retain browser commands through pause, late reads and project switches", { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)), dir = await mkdtemp("/private/tmp/codeflow-defaults-policy-"), app = join(dir, "app"), home = join(dir, "home");
  const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR ?? join(root, "output/playwright/qa-final-repository-defaults-policy");
  const ports = await reserveQaPorts(2), base = `http://127.0.0.1:${ports.port}`, token = "qa-defaults-policy", headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
  let server: ChildProcess | undefined, browser: Browser | undefined, logs = "";
  const errors: string[] = [], consoleErrors: { text: string; url: string }[] = [], responses: { path: string; repo: string | null; method: string; status: number }[] = [], receipts: unknown[] = [];
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => { const response = await fetch(base + path, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() as any }; };
  const api = async (path: string, body?: unknown, method?: string) => { const response = await call(path, body, method); assert.ok(response.status < 400, JSON.stringify(response)); return response.value; };
  const until = async (read: () => Promise<boolean>, label: string) => { const end = Date.now() + 20000; while (!await read()) { assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 50)); } };
  try {
    await mkdir(home); await mkdir(evidence, { recursive: true });
    const repos = [join(dir, "alpha"), join(dir, "beta")] as const;
    for (const repository of repos) { await mkdir(repository); execFileSync("git", ["init", "-qb", "main"], { cwd: repository }); await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { test: "echo fixture" } })); execFileSync("git", ["add", "."], { cwd: repository }); execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "initial"], { cwd: repository }); }
    copyFinalQaApp(root, app);
    const env = { ...process.env, HOME: home, ZDOTDIR: home, SHELL: "/bin/sh", CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${app}/test/fake-bin:${process.env.PATH}` };
    execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: app, env }); await ports.release();
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] }); server.stdout?.on("data", b => logs += b); server.stderr?.on("data", b => logs += b);
    await until(() => fetch(base + "/api/health", { headers }).then(r => r.ok, () => false), "server startup");
    const alpha = await api("/api/projects", { name: "Defaults Alpha", repos: [repos[0]] }), beta = await api("/api/projects", { name: "Defaults Beta", repos: [repos[1]] });
    const shared = await api("/api/projects", { name: "Shared Alpha repository", repos: [repos[0]] });
    const policyPath = (id: string) => `/api/projects/${id}/filesystem-policy`;
    await api(policyPath(alpha.id), { revision: 0, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }, "PUT");
    for (const [name, repository, expected] of [["Alpha", repos[0], 403], ["Beta", repos[1], 200]] as const) for (const endpoint of ["repo-config", "check"]) { const result = await call(`/api/${endpoint}?repo=${encodeURIComponent(repository)}`); receipts.push({ name, endpoint, ...result }); assert.equal(result.status, expected); }
    browser = await chromium.launch({ channel: "chrome", headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url }); });
    page.on("response", response => { const url = new URL(response.url()); if (url.pathname.startsWith("/api/")) responses.push({ path: url.pathname, repo: url.searchParams.get("repo"), method: response.request().method(), status: response.status() }); });
    await page.addInitScript(({ repos, alpha }) => { localStorage.setItem("project", alpha); localStorage.setItem("sideOpen", "0"); for (const [index, repository] of repos.entries()) { for (const command of ["check", "setup"]) if (localStorage.getItem(`${command}:${repository}`) === null) localStorage.setItem(`${command}:${repository}`, `${command} remembered ${index}`); } }, { repos, alpha: alpha.id });
    await page.goto(`${base}/?token=${token}#/settings/projects`); await page.getByLabel("Project", { exact: true }).selectOption(alpha.id);
    const panel = page.getByRole("region", { name: "Project run defaults", exact: true }), policy = page.getByRole("region", { name: "Project filesystem policy", exact: true });
    const check = panel.getByLabel("Default check command", { exact: true }), setup = panel.getByLabel("Worktree setup command", { exact: true });
    const pause = panel.getByText(/Repository defaults discovery is paused/);
    await pause.waitFor(); assert.equal(await check.inputValue(), "check remembered 0"); assert.equal(await setup.inputValue(), "setup remembered 0"); assert.equal(await check.isEnabled(), true);
    assert.deepEqual(responses.filter(r => r.repo === repos[0] && ["/api/repo-config", "/api/check"].includes(r.path)), [], "restricted repository is not queried at boot");
    await check.fill("alpha saved while paused"); await setup.fill("alpha setup while paused"); await panel.getByRole("button", { name: "Save project defaults", exact: true }).click();
    await panel.getByText("Project defaults saved.", { exact: true }).waitFor(); await panel.screenshot({ path: join(evidence, "restricted-browser-defaults.png") });
    const inventory = await api("/api/projects"); assert.equal(inventory.find((project: any) => project.id === shared.id).filesystemRestricted === true, false);
    await page.getByLabel("Project", { exact: true }).selectOption(shared.id); await pause.waitFor();
    assert.equal(await check.inputValue(), "alpha saved while paused", "browser defaults belong to the shared repository");
    assert.deepEqual(responses.filter(r => r.repo === repos[0] && ["/api/repo-config", "/api/check"].includes(r.path)), [], "an unrestricted project cannot bypass another owner's repository restriction");
    await check.fill("shared-owner unsaved check"); await setup.fill("shared-owner unsaved setup"); await panel.getByLabel("Default verification profile").selectOption("thorough");
    await pause.getByRole("link", { name: "Review the filesystem policy", exact: true }).click();
    await page.waitForFunction(id => (document.querySelector("#settings-project") as HTMLSelectElement)?.value === id, alpha.id);
    assert.equal(await check.inputValue(), "shared-owner unsaved check"); assert.equal(await setup.inputValue(), "shared-owner unsaved setup"); assert.equal(await panel.getByLabel("Default verification profile").inputValue(), "thorough");
    assert.equal(await page.evaluate(repository => localStorage.getItem(`check:${repository}`), repos[0]), "alpha saved while paused", "Review transfers the draft without implicitly saving it");
    await panel.screenshot({ path: join(evidence, "shared-owner-review-keeps-unsaved.png") });
    await check.fill("alpha saved while paused"); await setup.fill("alpha setup while paused"); await panel.getByLabel("Default verification profile").selectOption(""); await panel.getByRole("button", { name: "Save project defaults", exact: true }).click();

    await page.getByLabel("Project", { exact: true }).selectOption(beta.id); await until(() => check.isEnabled(), "Beta discovery finishes");
    assert.equal(await check.inputValue(), "check remembered 1"); assert.equal(await setup.inputValue(), "setup remembered 1"); assert.equal(await pause.count(), 0);
    assert.deepEqual(responses.filter(r => r.repo === repos[1] && ["/api/repo-config", "/api/check"].includes(r.path)).map(r => [r.path, r.status]).sort(), [["/api/check", 200], ["/api/repo-config", 200]]);
    await page.getByLabel("Project", { exact: true }).selectOption(alpha.id); await pause.waitFor(); assert.equal(await check.inputValue(), "alpha saved while paused");
    const idlePolicy = async (id: string) => { const saved = await api(policyPath(id)); await until(async () => { const r = await call(policyPath(id), saved, "PUT"); if (r.status === 409) { assert.equal(r.value.error, "Wait for active application operations to finish before changing filesystem policy"); return false; } assert.equal(r.status, 200); assert.deepEqual(r.value, saved); return true; }, "finite requests finish before explicit policy action"); };
    const remove = async (id: string) => { await idlePolicy(id); const health = page.waitForResponse(r => new URL(r.url()).pathname === "/api/doctor"); await policy.getByRole("button", { name: "Remove restrictions", exact: true }).click(); await page.getByRole("dialog", { name: "Remove restrictions?", exact: true }).getByRole("button", { name: "Remove restrictions", exact: true }).click(); await pause.waitFor({ state: "hidden" }); await (await health).finished(); await until(() => check.isEnabled(), "read recovery"); };
    const restrict = async (id: string) => { await idlePolicy(id); await policy.getByLabel("Read deny paths", { exact: true }).fill("private"); await policy.getByRole("button", { name: "Apply policy", exact: true }).click(); await page.getByRole("dialog", { name: "Pause execution in every project?", exact: true }).getByRole("button", { name: "Apply restriction", exact: true }).click(); await pause.waitFor(); };
    await remove(alpha.id);
    await check.fill("alpha unsaved check"); await setup.fill("alpha unsaved setup"); await panel.getByLabel("Default verification profile").selectOption("thorough");
    await restrict(alpha.id); assert.equal(await check.inputValue(), "alpha unsaved check"); assert.equal(await setup.inputValue(), "alpha unsaved setup"); assert.equal(await panel.getByLabel("Default verification profile").inputValue(), "thorough");
    assert.equal(await page.evaluate(repository => localStorage.getItem(`check:${repository}`), repos[0]), "alpha saved while paused", "pause cannot save an unsaved command");
    await remove(alpha.id); assert.equal(await check.inputValue(), "alpha unsaved check"); assert.equal(await setup.inputValue(), "alpha unsaved setup");
    await panel.getByRole("button", { name: "Save project defaults", exact: true }).click();
    // Hold already-successful HTTP reads, then pause while their browser delivery is late.
    let release!: () => void; const held = new Promise<void>(resolve => release = resolve); let captured = 0;
    const holdReads = async (route: import("playwright-core").Route) => { if (new URL(route.request().url()).searchParams.get("repo") !== repos[1]) return route.continue(); const response = await route.fetch(); captured++; await held; await route.fulfill({ response }); };
    await page.route("**/api/repo-config?*", holdReads); await page.route("**/api/check?*", holdReads);
    await page.getByLabel("Project", { exact: true }).selectOption(beta.id); await until(async () => captured === 2, "both Beta read responses held"); await restrict(beta.id);
    await check.fill("beta draft after pause"); release(); await page.unroute("**/api/repo-config?*", holdReads); await page.unroute("**/api/check?*", holdReads);
    await page.getByLabel("Default verification profile").selectOption("standard"); assert.equal(await check.inputValue(), "beta draft after pause");
    await remove(beta.id); assert.equal(await check.inputValue(), "beta draft after pause", "late reads must not overwrite the edited command");
    await panel.getByRole("button", { name: "Save project defaults", exact: true }).click(); await panel.screenshot({ path: join(evidence, "recovered-late-reads.png") });
    await page.getByLabel("Project", { exact: true }).selectOption(alpha.id); await until(() => check.isEnabled(), "Alpha reload"); assert.equal(await check.inputValue(), "alpha unsaved check"); assert.equal(await setup.inputValue(), "alpha unsaved setup"); assert.equal(await panel.getByLabel("Default verification profile").inputValue(), "thorough");
    await page.reload(); await page.getByLabel("Project", { exact: true }).selectOption(beta.id); await until(() => check.isEnabled(), "Beta remembered reload"); assert.equal(await check.inputValue(), "beta draft after pause"); assert.equal(await panel.getByLabel("Default verification profile").inputValue(), "standard");
    assert.deepEqual(responses.filter(r => ["/api/repo-config", "/api/check"].includes(r.path) && r.status >= 400), []);
    assert.deepEqual(responses.filter(response => response.status >= 500), []);
    assert.deepEqual(errors, []);
    const expectedRefusal = (response: typeof responses[number]) => response.status === 403 && (["/api/team-rollout", "/api/experience"].includes(response.path) || [alpha.id, beta.id].some(id => response.path === `/api/projects/${id}/conventions`)) || response.status === 409 && response.path === "/api/projects/counts" || response.status === 409 && (response.method === "GET" && response.path === "/api/stream" || response.method === "POST" && /^\/api\/stream\/[^/]+$/.test(response.path));
    assert.deepEqual(responses.filter(response => response.status >= 400 && !expectedRefusal(response)), [], "only named boot/policy-transition responses are expected at this source base");
    assert.deepEqual(consoleErrors.filter(message => { const status = Number(message.text.match(/^Failed to load resource: the server responded with a status of (\d+)/)?.[1]); if (!status || !message.url) return true; const url = new URL(message.url); return !responses.some(response => response.path === url.pathname && response.status === status && expectedRefusal(response)); }), []);
  } finally {
    await browser?.close(); if (server && server.exitCode === null && server.signalCode === null) { const stopped = new Promise<void>(resolve => server!.once("exit", () => resolve())); server.kill("SIGTERM"); const timer = setTimeout(() => server!.kill("SIGKILL"), 5000); try { await stopped; } finally { clearTimeout(timer); } }
    await ports.release(); await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, "server.log"), logs); await writeFile(join(evidence, "browser.json"), JSON.stringify({ errors, consoleErrors, responses, receipts }, null, 2)); await rm(dir, { recursive: true, force: true });
  }
});
