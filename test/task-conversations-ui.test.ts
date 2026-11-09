import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("..", import.meta.url)), token = "task-conversation-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let home: string, repo: string, base: string, server: ChildProcess, browser: Browser, project: {
    id: string;
}, logs = "", completedTask = "";
const errors: string[] = [];
async function api(path: string, body?: object) { const response = await fetch(base + path, { headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json() as any; assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`); return data; }
async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, description: string, timeout = 45000) { const end = Date.now() + timeout; let value: T; do {
    value = await read();
    if (check(value))
        return value;
    await new Promise(r => setTimeout(r, 100));
} while (Date.now() < end); throw new Error(`${description}: ${JSON.stringify(value!)}`); }
async function page() { const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); await context.addInitScript(() => localStorage.setItem("sideOpen", "0")); const page = await context.newPage(); page.setDefaultTimeout(25000); page.on("pageerror", e => errors.push(e.message)); await page.goto(`${base}/?token=${token}#/project/${project.id}/new`); await page.getByLabel("Task", { exact: true }).waitFor(); return { context, page }; }
async function prepare(page: Page, request: string) { await page.evaluate(() => { location.hash = "#/task/new"; }); await page.getByLabel("What would you like to do?").fill(request); await page.getByRole("button", { name: "Prepare approach", exact: true }).click(); await page.waitForURL(/#\/task\/(?!new)[a-f0-9]+/); const id = page.url().split("#/task/")[1]!; return { id, ready: () => until(() => api(`/api/task-conversations/${id}`), s => !!s.proposal || !!s.task.question || !!s.task.error, "approach ready") }; }
async function startServer() {
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, PORT: new URL(base).port, SHELL: "/bin/sh", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_RETRY_DELAYS_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr])
        stream?.on("data", c => logs += c);
    await until(() => { if (server.exitCode !== null)
        throw new Error(`Server exited during startup:\n${logs.slice(-6000)}`); return fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false); }, Boolean, "server startup", 60000);
}
before(async () => {
    home = await mkdtemp(join(tmpdir(), "codeflow-task-ui-"));
    repo = join(home, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await writeFile(join(repo, "app.mjs"), "export const value = 1;\n");
    await writeFile(join(repo, "app.test.mjs"), "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './app.mjs';test('value',()=>assert.equal(value,2));\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"], { cwd: repo });
    const port = await new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
    assert.ok(![4317, 4318].includes(port));
    base = `http://127.0.0.1:${port}`;
    execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, stdio: "pipe" });
    await startServer();
    project = await api("/api/projects", { name: "Conversational task fixture", repos: [repo] });
    browser = await chromium.launch({ channel: "chrome", headless: true });
    await mkdir(join(root, "output/playwright"), { recursive: true });
}, { timeout: 120000 });
after(async () => { await browser?.close(); if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await until(async () => server.exitCode, value => value !== null, "server shutdown", 30000);
} if (home)
    await rm(home, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.doesNotMatch(logs, /UnhandledPromiseRejection|uncaught exception/i); });
test("web users prepare, edit participants, approve once, reload results, and retain the legacy draft", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        await p.getByLabel("Task", { exact: true }).fill("Keep my existing workflow draft");
        const task = await prepare(p, "WEB_TASK_PLAN Plan a login form. Plan only."), ready = await task.ready();
        assert.ok(ready.proposal, ready.task.error);
        assert.equal(ready.task.executions.length, 0);
        assert.equal(ready.preparationUsage.calls, 1);
        await p.getByRole("button", { name: "Edit approach", exact: true }).click();
        const planner = p.locator("fieldset").filter({ hasText: "planner · independent participant" });
        try {
            await planner.getByLabel("Effort", { exact: true }).selectOption("low");
        }
        catch (error) {
            await p.screenshot({ path: join(root, "output/playwright/task-editor-failure.png"), fullPage: true });
            throw new Error(`${error}\nFields: ${JSON.stringify(await p.locator("fieldset").allTextContents())}`);
        }
        await p.getByRole("button", { name: "Save revised approach" }).click();
        await p.getByText("Participant model, effort, or assignments changed.", { exact: true }).waitFor();
        const start = p.getByRole("button", { name: "Start task", exact: true });
        await start.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
        const done = await until(() => api(`/api/task-conversations/${task.id}`), s => s.execution?.status === "done", "planning completion");
        completedTask = task.id;
        assert.equal(done.task.executions.length, 1);
        assert.equal(done.execution.outcome, "agreed_plan");
        assert.equal(done.proposal.definition.participants[0].effort, "low");
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        await p.getByLabel("Task result").getByText(/Fixture login plan/).waitFor();
        assert.equal(await p.getByText(/codeflow approve/).count(), 0);
        await p.reload();
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        await p.getByLabel("Task result").getByText(/Fixture login plan/).waitFor();
        const reply = p.getByRole("textbox", { name: "Continue this task", exact: true });
        const replyBox = await reply.boundingBox();
        assert.ok(replyBox && replyBox.y >= 0 && replyBox.y + replyBox.height <= 1000, "Reply stays inside the viewport");
        await p.locator(".task-chat-scroll").evaluate(el => { el.scrollTop = 0; });
        assert.equal((await reply.boundingBox())?.y, replyBox.y, "Scrolling history does not move the reply box");
        await reply.fill("What remains");
        await reply.press("Shift+Enter");
        assert.match(await reply.inputValue(), /\n/);
        await reply.fill("What remains unresolved?");
        await reply.press("Enter");
        await p.getByLabel("Follow-up messages").getByText(/Execution: done/).waitFor();
        const chatBox = await p.locator(".task-chat-scroll").boundingBox();
        assert.ok(chatBox);
        await until(() => p.getByLabel("Follow-up messages").boundingBox(), box => !!box && box.y + box.height <= chatBox.y + chatBox.height + 2, "Sending a reply brings its response into view");
        await until(() => reply.inputValue(), value => value === "", "The reply box clears once the reply is sent");
        const afterReply = await api(`/api/task-conversations/${task.id}`);
        assert.equal(afterReply.preparationUsage.calls, 1, "A status question does not prepare another approach");
        assert.equal(afterReply.task.executions.length, 1);
        assert.ok(await p.locator(".task-chat-thread").evaluate(el => {
            const result = el.querySelector(".task-final"), followUp = el.querySelector('[aria-label="Follow-up messages"]');
            return !!result && !!followUp && !!(result.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), "Follow-up messages follow the result they discuss");
        await p.getByRole("button", { name: "Task details", exact: true }).click();
        const details = p.getByRole("dialog", { name: "Task details", exact: true });
        await details.getByRole("region", { name: "Agent participation", exact: true }).getByText(/codex ·/).waitFor();
        await details.getByText("Previous executions and worktrees", { exact: true }).waitFor();
        await details.getByText("Approach history", { exact: true }).waitFor();
        await p.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        assert.ok(await p.getByRole("button", { name: "Task details", exact: true }).evaluate(el => el === document.activeElement));
        await p.screenshot({ path: join(root, "output/playwright/task-conversation-plan.png"), fullPage: true });
        await p.setViewportSize({ width: 390, height: 844 });
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
        const mobileReply = await reply.boundingBox();
        assert.ok(mobileReply && mobileReply.y >= 0 && mobileReply.y + mobileReply.height <= 844);
        await p.getByRole("button", { name: "Task details", exact: true }).click();
        await details.getByText("Previous executions and worktrees", { exact: true }).waitFor();
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
        await details.getByRole("button", { name: "Close task details", exact: true }).click();
        await p.screenshot({ path: join(root, "output/playwright/task-conversation-mobile.png"), fullPage: true });
        await p.setViewportSize({ width: 1400, height: 1000 });
        await p.getByRole("button", { name: "Back to existing workflows", exact: true }).click();
        await p.getByLabel("Task", { exact: true }).waitFor();
        assert.equal(await p.getByLabel("Task", { exact: true }).inputValue(), "Keep my existing workflow draft");
    }
    finally {
        await context.close();
    }
});
test("the web implementation flow verifies actual worktree changes and preserves source files and index", { timeout: 120000 }, async () => {
    await writeFile(join(repo, "notes.txt"), "Selected source context\n");
    await writeFile(join(repo, "private.txt"), "Unselected source file\n");
    const index = await readFile(join(repo, ".git/index"));
    const { context, page: p } = await page();
    try {
        await p.evaluate(() => { location.hash = "#/task/new"; });
        await p.getByLabel("What would you like to do?").fill("WEB_TASK_BUILD Fix the fixture value and verify it with another agent.");
        await p.getByText(/Source: working copy/).click();
        await p.getByRole("checkbox", { name: "notes.txt", exact: true }).check();
        await p.getByRole("button", { name: "Prepare approach", exact: true }).click();
        await p.waitForURL(/#\/task\/(?!new)[a-f0-9]+/);
        const id = p.url().split("#/task/")[1]!;
        const ready = await until(() => api(`/api/task-conversations/${id}`), s => !!s.proposal || !!s.task.error, "implementation approach");
        assert.ok(ready.proposal, ready.task.error);
        assert.deepEqual(ready.proposal.source.untracked, ["notes.txt"]);
        await p.getByRole("button", { name: "Start task", exact: true }).click();
        const done = await until(() => api(`/api/task-conversations/${id}`), s => s.execution?.status !== "running" && !!s.execution, "verified implementation");
        assert.equal(done.execution.outcome, "verified_changes", JSON.stringify(done.execution));
        await p.getByRole("heading", { name: "Changes verified", exact: true }).waitFor();
        const wt = done.execution.worktrees[0].path;
        assert.match(await readFile(join(wt, "app.mjs"), "utf8"), /2/);
        assert.match(await readFile(join(repo, "app.mjs"), "utf8"), /1/);
        assert.deepEqual(await readFile(join(repo, ".git/index")), index);
        assert.match(await readFile(join(repo, "private.txt"), "utf8"), /Unselected/);
        await p.screenshot({ path: join(root, "output/playwright/task-conversation-verified.png"), fullPage: true });
    }
    finally {
        await context.close();
    }
});
test("clarification remains in the task conversation and shares the preparation allowance", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        const task = await prepare(p, "WEB_TASK_QUESTION Plan a login form. Plan only."), first = await task.ready();
        assert.ok(first.task.question);
        assert.equal(first.proposal, undefined);
        await p.getByRole("button", { name: "Use the existing layout", exact: true }).click();
        const next = await until(() => api(`/api/task-conversations/${task.id}`), s => !!s.proposal || !!s.task.error, "clarified approach");
        assert.ok(next.proposal, next.task.error);
        assert.equal(next.preparationUsage.calls, 2);
        assert.ok(next.task.messages.some((m: any) => m.body === "Use the existing layout"));
        assert.equal(next.task.executions.length, 0);
    }
    finally {
        await context.close();
    }
});
test("a requested design checkpoint displays its exact plan and rejection stops code editing", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        const task = await prepare(p, "WEB_TASK_BUILD Implement the value change, but show me the design before coding."), ready = await task.ready();
        assert.ok(ready.proposal, ready.task.error);
        await p.getByRole("button", { name: "Start task", exact: true }).click();
        await p.getByLabel("Decision evidence", { exact: true }).getByText(/Fixture login plan/).waitFor();
        const waiting = await api(`/api/task-conversations/${task.id}`);
        assert.equal(waiting.execution.questions.length, 1);
        assert.match(await readFile(join(waiting.execution.worktrees[0].path, "app.mjs"), "utf8"), /1/);
        await p.getByRole("button", { name: "Revise the design", exact: true }).click();
        const stopped = await until(() => api(`/api/task-conversations/${task.id}`), s => s.execution?.status !== "running", "checkpoint rejection");
        assert.equal(stopped.execution.outcome, "blocked");
        assert.match(await readFile(join(stopped.execution.worktrees[0].path, "app.mjs"), "utf8"), /1/);
    }
    finally {
        await context.close();
    }
});
test("owner restart restores conversation revisions, execution, usage and the complete result", { timeout: 120000 }, async () => {
    assert.ok(completedTask);
    const before = await api(`/api/task-conversations/${completedTask}`);
    server.kill("SIGTERM");
    await until(async () => server.exitCode, value => value !== null, "owner shutdown", 30000);
    await startServer();
    const restored = await api(`/api/task-conversations/${completedTask}`);
    assert.equal(restored.execution.id, before.execution.id);
    assert.equal(restored.preparationUsage.calls, before.preparationUsage.calls);
    assert.deepEqual(restored.task.approaches, before.task.approaches);
    assert.notEqual(restored.generation, before.generation);
    const artifact = restored.execution.artifacts.find((a: any) => a.kind === "result");
    const result = await api(`/api/task-conversations/${completedTask}/artifacts?runId=${restored.execution.id}&artifactId=${artifact.id}&sha256=${artifact.sha256}`);
    assert.match(result.body, /Fixture login plan/);
});
