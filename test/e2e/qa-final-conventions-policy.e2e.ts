import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Request } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";

test("conventions respect selected project policy at boot and preserve a local draft through pause, recovery and CAS", { timeout: 120000 }, async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), "codeflow-conventions-policy-"));
  const home = join(scratch, "home"), osHome = join(scratch, "os-home");
  const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR || join(root, "output/playwright/qa-final-conventions-policy");
  const ports = await reserveQaPorts(2), base = `http://127.0.0.1:${ports.port}`, token = "conventions-policy-fixture";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
  let server: ChildProcess | undefined, browser: Browser | undefined, logs = "";
  const finiteRequests = new Set<Request>(), activityConflicts: string[] = [];
  const pageErrors: string[] = [], consoleErrors: { text: string; url: string }[] = [], refused: { path: string; method: string; status: number }[] = [], asked: string[] = [];
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> => {
    const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json();
  };
  try {
    for (const folder of [home, osHome, evidence]) await mkdir(folder, { recursive: true });
    const repos = [join(scratch, "alpha"), join(scratch, "beta")];
    for (const repo of repos) {
      await mkdir(repo); execFileSync("git", ["init", "-qb", "main"], { cwd: repo });
      await writeFile(join(repo, "README.md"), "Conventions policy fixture\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
    }
    const shell = join(scratch, "bash"); await writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEFLOW_|FAKE_)/.test(key)));
    const env = { ...inherited, CODEFLOW_HOME: home, HOME: osHome, SHELL: shell, BASH_ENV: "", ENV: "", CODEFLOW_TOKEN: token, PORT: String(ports.port), CODEFLOW_REMOTE_PORT: String(ports.port + 1), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` };
    execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env });
    await ports.release();
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env, stdio: "pipe" });
    server.stdout?.on("data", chunk => logs += chunk); server.stderr?.on("data", chunk => logs += chunk);
    const deadline = Date.now() + 20000;
    while (!await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) {
      assert.ok(Date.now() < deadline, logs); await new Promise(resolve => setTimeout(resolve, 100));
    }
    const alpha = await api("/api/projects", { name: "Restricted Alpha", repos: [repos[0]] });
    const beta = await api("/api/projects", { name: "Unrestricted Beta", repos: [repos[1]] });
    const conventions = `/api/projects/${alpha.id}/conventions`, policyAlpha = `/api/projects/${alpha.id}/filesystem-policy`;
    const original = await api(conventions, { revision: 0, text: "Saved original guidance" }, "PUT");
    await api(policyAlpha, { revision: 0, read: { allow: ["."], deny: ["secret"] }, write: { allow: ["."], deny: [] } }, "PUT");
    // Project conventions follow the selected project policy; unrelated conventions stay available.
    assert.equal((await fetch(base + conventions, { headers })).status, 403);
    assert.equal((await fetch(base + `/api/projects/${beta.id}/conventions`, { headers })).status, 200);
    browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 30000 });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(12000);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["/api/stream", "/api/events"].includes(path) && request.resourceType() !== "eventsource") finiteRequests.add(request);
    });
    page.on("requestfinished", request => finiteRequests.delete(request));
    page.on("requestfailed", request => finiteRequests.delete(request));
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url }); });
    page.on("request", request => { if (new URL(request.url()).pathname.includes("/conventions")) asked.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    page.on("response", response => { if (response.status() >= 400) refused.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
    await page.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
    let releaseAgents!: () => void, sawAgents!: () => void;
    const agentsGate = new Promise<void>(resolve => releaseAgents = resolve), agentsSeen = new Promise<void>(resolve => sawAgents = resolve);
    await page.route("**/api/agents", async route => { sawAgents(); await agentsGate; await route.continue(); });
    await page.goto(base + `/?token=${token}#/settings/projects`);
    await agentsSeen;
    assert.equal(await page.getByRole("region", { name: "Versioned project conventions" }).count(), 0, "settings cannot mount before boot resolves provider policy");
    assert.deepEqual(asked, []);
    releaseAgents();
    await page.getByLabel("Project", { exact: true }).selectOption(alpha.id);
    const panel = page.getByRole("region", { name: "Versioned project conventions", exact: true });
    const policy = page.getByRole("region", { name: "Project filesystem policy", exact: true });
    await panel.getByText(/Private conventions are paused: project “Restricted Alpha”/).waitFor();
    assert.equal(await panel.getByLabel("Private conventions draft", { exact: true }).count(), 0);
    assert.equal(await panel.getByRole("button", { name: "Retry loading conventions" }).count(), 0);
    assert.deepEqual(asked, [], "restricted selected project must not request private conventions");
    await panel.screenshot({ path: join(evidence, "restricted-project.png") });
    await page.getByLabel("Project", { exact: true }).selectOption(beta.id);
    await panel.getByLabel("Private conventions draft", { exact: true }).waitFor();
    assert.deepEqual(asked, [`GET /api/projects/${beta.id}/conventions`], "an unrelated restriction must not block this project's private guidance");
    assert.equal(await panel.locator(".policy-pause").count(), 0, "unrestricted project must not claim its conventions are paused");
    await page.getByLabel("Project", { exact: true }).selectOption(alpha.id);
    await panel.getByText(/Private conventions are paused: project “Restricted Alpha”/).waitFor();
    await panel.getByRole("link", { name: "Review the filesystem policy", exact: true }).click();
    await page.waitForFunction(id => (document.querySelector("#settings-project") as HTMLSelectElement)?.value === id, alpha.id);
    await policy.getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await panel.getByLabel("Private conventions draft", { exact: true }).waitFor();
    const draft = panel.getByLabel("Private conventions draft", { exact: true });
    await draft.waitFor(); assert.equal(await draft.inputValue(), original.text);
    const unsaved = "Keep this local draft\n  and its meaningful spaces.";
    await draft.fill(unsaved); await panel.getByLabel("Revision note", { exact: true }).fill("Local revision note");
    const beforePause = asked.length;
    await policy.getByLabel("Read deny paths", { exact: true }).fill("secret");
    await policy.getByRole("button", { name: "Apply policy", exact: true }).click();
    await page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Apply restriction", exact: true }).click();
    await panel.getByText(/Private conventions are paused: project “Restricted Alpha”/).waitFor();
    await panel.getByText("Your unsaved draft is kept in this tab. Remove the filesystem restrictions to continue editing.", { exact: true }).waitFor();
    assert.equal(await draft.count(), 0); assert.deepEqual(asked.slice(beforePause), [], "pause sends no private read or mutation");
    await panel.screenshot({ path: join(evidence, "draft-preserved-while-paused.png") });
    await policy.getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await draft.waitFor(); assert.equal(await draft.inputValue(), unsaved);
    assert.equal(await panel.getByLabel("Revision note", { exact: true }).inputValue(), "Local revision note");
    assert.deepEqual(asked.slice(beforePause), [], "recovery must not reload over an existing local draft");
    const concurrent = await api(conventions, { revision: 1, text: "Concurrent revision from another tab" }, "PUT");
    await panel.getByRole("button", { name: "Save private revision", exact: true }).click();
    await panel.getByText("Your draft is preserved. Review the latest saved guidance before applying it.", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), unsaved, "the saved CAS revision survives the policy pause too");
    assert.equal((await api(conventions)).text, concurrent.text);
    await panel.getByRole("button", { name: "Compare latest revision", exact: true }).click();
    await panel.getByText("Concurrent revision from another tab", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "Use latest revision as base and keep my draft", exact: true }).click();
    assert.equal(await draft.inputValue(), unsaved);
    await panel.getByRole("button", { name: "Save private revision", exact: true }).click();
    await panel.getByText(/Saved revision 3 ·/).waitFor();
    assert.equal((await api(conventions)).text, unsaved + "\n");
    assert.deepEqual((await api(policyAlpha)).read.deny, []);
    await panel.screenshot({ path: join(evidence, "recovered-and-saved.png") });
    // Two restrictions must keep the Review link on the selected dirty project, not the first restricted project.
    await page.getByLabel("Project", { exact: true }).selectOption(beta.id);
    await draft.waitFor(); await draft.fill("Beta draft must survive its own Review link");
    const alphaPolicy = await api(policyAlpha);
    // The conventions editor can be ready before the newly selected repository's defaults
    // requests finish. Respect that finite activity and retain the same CAS revision/body.
    const policyDeadline = Date.now() + 10000;
    for (;;) {
      while (finiteRequests.size) {
        assert.ok(Date.now() < policyDeadline, `Application requests did not finish: ${[...finiteRequests].map(request => request.url()).join(", ")}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const response = await fetch(base + policyAlpha, { method: "PUT", headers, body: JSON.stringify({ revision: alphaPolicy.revision, read: { allow: ["."], deny: ["secret"] }, write: { allow: ["."], deny: [] } }) });
      const result = await response.json();
      if (response.status === 409 && result.error === "Wait for active application operations to finish before changing filesystem policy") {
        activityConflicts.push(result.error);
        assert.ok(Date.now() < policyDeadline, "Application activity did not settle before the policy deadline");
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      assert.equal(response.status, 200, JSON.stringify(result));
      break;
    }
    const beforeBoth = asked.length;
    await policy.getByLabel("Read deny paths", { exact: true }).fill("secret");
    await policy.getByRole("button", { name: "Apply policy", exact: true }).click();
    await page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Apply restriction", exact: true }).click();
    await panel.getByText(/Private conventions are paused: project “Unrestricted Beta”/).waitFor();
    await panel.getByRole("link", { name: "Review the filesystem policy", exact: true }).click();
    assert.equal(await page.getByLabel("Project", { exact: true }).inputValue(), beta.id);
    await panel.getByText("Your unsaved draft is kept in this tab. Remove the filesystem restrictions to continue editing.", { exact: true }).waitFor();
    await policy.getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await page.locator("dialog.confirmation-dialog").getByRole("button", { name: "Remove restrictions", exact: true }).click();
    await draft.waitFor(); assert.equal(await draft.inputValue(), "Beta draft must survive its own Review link");
    assert.equal(await panel.locator(".policy-pause").count(), 0);
    assert.deepEqual(asked.slice(beforeBoth), [], "Review and recovery keep the selected document and draft even while another project remains restricted");
    await panel.screenshot({ path: join(evidence, "selected-project-review-preserves-draft.png") });
    // Other Settings consumers are recorded separately for the parallel defaults-policy repair.
    // This regression never accepts a refused conventions read or an unexpected conventions mutation.
    assert.deepEqual(refused.filter(item => item.path.includes("/conventions")), [{ path: conventions, method: "PUT", status: 409 }]);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise<void>(resolve => server!.once("exit", () => resolve())); server.kill("SIGTERM");
      const timer = setTimeout(() => server!.kill("SIGKILL"), 5000); try { await stopped; } finally { clearTimeout(timer); }
    }
    await ports.release(); await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "server.log"), logs);
    await writeFile(join(evidence, "browser.json"), JSON.stringify({ asked, refused, pageErrors, consoleErrors, activityConflicts }, null, 2));
    await rm(scratch, { recursive: true, force: true });
  }
});
