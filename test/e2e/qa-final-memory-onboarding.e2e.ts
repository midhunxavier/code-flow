import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { reserveQaPorts } from "../qa-port-block.js";
import { onboardingExamples, onboardingScopeExamples, literalMemoryPaths } from "../qa-final-memory-onboarding-fixture.js";

test("onboarding UI and guarded publication retain meaningful whitespace and omit only identical text", { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const scratch = await mkdtemp("/private/tmp/codeflow-onboarding-ui-");
  const home = join(scratch, "home"), repo = join(scratch, "repo"), osHome = join(scratch, "os-home");
  const evidence = join(root, "output/playwright/qa-final-memory-onboarding");
  const ports = await reserveQaPorts(2), base = `http://127.0.0.1:${ports.port}`, token = "onboarding-fixture";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base };
  let server: ChildProcess | undefined, browser: Browser | undefined, logs = "";
  const errors: string[] = [], badResponses: string[] = [];
  const api = async (path: string, body?: unknown): Promise<any> => {
    const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json();
  };
  try {
    for (const folder of [home, repo, osHome, evidence]) await mkdir(folder, { recursive: true });
    const shell = join(scratch, "bash"); await writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    execFileSync("git", ["init", "-qb", "_qa_"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "Onboarding fixture\n");
    await writeFile(join(repo, "config.txt"), "Configuration fixture\n");
    for (const path of literalMemoryPaths) await writeFile(join(repo, path), "Literal path fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
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
    const project = await api("/api/projects", { name: "Whitespace onboarding", repos: [repo] });
    const endpoint = `/api/projects/${project.id}/memory`;
    const entries = [];
    const longLiteral = "x".repeat(180);
    const scoped = onboardingScopeExamples.map(example => "applicability" in example && example.applicability?.kind === "branch" ? { ...example, applicability: { kind: "branch", branch: "_qa_" } } : example);
    const examples = [...onboardingExamples, ...scoped, { title: "I Long literal wraps", body: `Long literal: \`${longLiteral}\`.` }, { title: "J Literal path labels", body: "Keep these fixture names exact.", paths: literalMemoryPaths }, { title: "K Pinned branch label", body: "Keep this branch and commit exact.", applicability: { kind: "branch", branch: "_qa_", commit } }];
    for (const example of [...examples, { title: "Z Exact duplicate", body: onboardingExamples[0]!.body }]) entries.push(await api(endpoint + "/commands", { op: "create", repo, ...example }));
    const analysis = await api(endpoint + "/analysis?repo=" + encodeURIComponent(repo));
    const expected = entries.slice(0, examples.length).map(entry => ({ id: entry.id, revision: entry.revision }));
    assert.deepEqual(analysis.onboarding.sourceRefs, expected);
    assert.equal(analysis.onboarding.reasons.length, 1);
    assert.equal(analysis.onboarding.reasons[0].id, entries.at(-1).id);
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    await page.addInitScript(() => { localStorage.setItem("sideOpen", "0"); });
    await page.goto(base + `/?token=${token}#/settings/projects`);
    await page.getByLabel("Project", { exact: true }).selectOption(project.id);
    const memory = page.locator("details.project-memory"); await memory.locator(":scope > summary").click();
    await memory.getByText("Advanced memory tools", { exact: true }).click();
    await memory.getByText("Curated project onboarding", { exact: true }).click();
    const curated = memory.locator("details").filter({ has: page.locator("summary", { hasText: /^Curated project onboarding$/ }) });
    for (const example of examples) await curated.getByRole("heading", { name: example.title, exact: true }).waitFor();
    const code = await curated.locator(".md pre, .md code").allTextContents();
    await writeFile(join(evidence, "rendered-code.json"), JSON.stringify(code, null, 2));
    assert.ok(code.some(text => text.replace(/\n$/, "") === "if ready:\n    deploy()\nnotify()"), JSON.stringify(code));
    assert.ok(code.some(text => text.replace(/\n$/, "") === "if ready:\n    deploy()\n    notify()"), JSON.stringify(code));
    assert.ok(code.includes('"left right"')); assert.ok(code.includes('"left  right"'));
    for (const paths of [["README.md"], ["config.txt"], literalMemoryPaths]) assert.ok(code.includes(JSON.stringify(paths, null, 2)), JSON.stringify(code));
    assert.equal(await curated.locator(".md a").count(), 0, "path punctuation must not create Markdown links");
    assert.equal(await curated.locator(".md em").count(), 0, "branch underscores must not become emphasis");
    const layout = () => curated.locator(".md").evaluate(element => ({
      inline: [...element.querySelectorAll("code")].map(code => ({ text: code.textContent, width: code.getBoundingClientRect().width, lines: code.getClientRects().length, whiteSpace: getComputedStyle(code).whiteSpace })),
      fenced: [...element.querySelectorAll("pre")].map(pre => ({ text: pre.textContent, whiteSpace: getComputedStyle(pre).whiteSpace })),
      contentWidth: element.clientWidth, contentScrollWidth: element.scrollWidth,
      viewportWidth: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
    }));
    const desktop = await layout();
    const single = desktop.inline.find(code => code.text === '"left right"')!;
    const double = desktop.inline.find(code => code.text === '"left  right"')!;
    assert.ok(double.width > single.width + 3, JSON.stringify({ single, double }));
    assert.equal(double.whiteSpace, "pre-wrap");
    const fenced = desktop.fenced.map(code => code.text);
    assert.deepEqual(fenced, ["if ready:\n    deploy()\nnotify()", "if ready:\n    deploy()\n    notify()", JSON.stringify("Applies to branch _qa_."), JSON.stringify(["README.md"], null, 2), JSON.stringify(["config.txt"], null, 2), JSON.stringify(literalMemoryPaths, null, 2), JSON.stringify(`Applies to branch _qa_ at ${commit}.`)]);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await layout(), wrapped = narrow.inline.find(code => code.text === longLiteral)!;
    assert.ok(wrapped.lines > 1, JSON.stringify(wrapped));
    assert.ok(narrow.contentScrollWidth <= narrow.contentWidth + 1, JSON.stringify(narrow));
    assert.ok(narrow.documentWidth <= narrow.viewportWidth + 1, JSON.stringify(narrow));
    assert.deepEqual(narrow.fenced, desktop.fenced, "fenced code content and whitespace styling stay unchanged");
    await writeFile(join(evidence, "code-layout.json"), JSON.stringify({ desktop, narrow }, null, 2));
    await curated.locator(".md").screenshot({ path: join(evidence, "preview-narrow.png") });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await curated.locator(".md").screenshot({ path: join(evidence, "preview.png") });
    const publishing = page.waitForRequest(request => request.url().endsWith("/memory/analysis/publish") && request.method() === "POST");
    const published = page.waitForResponse(response => response.url().endsWith("/memory/analysis/publish") && response.request().method() === "POST");
    await curated.getByRole("button", { name: "Save onboarding as project knowledge", exact: true }).click();
    assert.deepEqual((await publishing).postDataJSON().expectedSources, expected);
    const response = await published; assert.equal(response.status(), 201);
    const saved = await response.json(); assert.deepEqual(saved.derivedFrom, [...expected].sort((a, b) => a.id.localeCompare(b.id)));
    for (const example of onboardingExamples) assert.ok(saved.body.includes(example.body));
    for (const paths of [["README.md"], ["config.txt"], literalMemoryPaths]) assert.ok(saved.body.includes("Applies to paths:\n\n```json\n" + JSON.stringify(paths, null, 2) + "\n```"));
    assert.ok(saved.body.includes('Applies to branch _qa_.'));
    assert.ok(saved.body.includes(`Applies to branch _qa_ at ${commit}.`));
    assert.equal(saved.body.split(onboardingExamples[0]!.body).length - 1, 1);
    assert.deepEqual((await api(endpoint)).find((entry: any) => entry.id === saved.id).body, saved.body);
    await writeFile(join(evidence, "publication.json"), JSON.stringify({ analysis, submitted: { expectedSources: expected }, saved }, null, 2));
    await page.reload();
    await page.getByLabel("Project", { exact: true }).selectOption(project.id);
    await memory.locator(":scope > summary").click();
    await memory.getByText(saved.title, { exact: true }).first().waitFor();
    await page.screenshot({ path: join(evidence, "saved-after-reload.png"), fullPage: true });
  } finally {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) { const done = new Promise<void>(resolve => server!.once("exit", () => resolve())); server.kill("SIGTERM"); await done; }
    await ports.release(); await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "server.log"), logs);
    await writeFile(join(evidence, "browser-errors.json"), JSON.stringify({ errors, badResponses }, null, 2));
    await rm(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(badResponses, []);
});
