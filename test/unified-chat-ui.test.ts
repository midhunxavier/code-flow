import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
const root = fileURLToPath(new URL("..", import.meta.url)), token = "unified-chat-browser-fixture", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
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
async function page() { const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); await context.addInitScript(() => localStorage.setItem("sideOpen", "0")); const page = await context.newPage(); page.setDefaultTimeout(25000); page.on("pageerror", e => errors.push(e.message)); await page.goto(`${base}/?token=${token}#/project/${project.id}/chat`); await page.getByRole("textbox", { name: "Message", exact: true }).waitFor(); return { context, page }; }
async function startServer() {
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, PORT: new URL(base).port, SHELL: "/bin/sh", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_RETRY_DELAYS_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr])
        stream?.on("data", c => logs += c);
    await until(() => { if (server.exitCode !== null)
        throw new Error(`Server exited during startup:\n${logs.slice(-6000)}`); return fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false); }, Boolean, "server startup", 60000);
}
before(async () => {
    home = await mkdtemp(join(tmpdir(), "codeflow-chat-ui-"));
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

async function sendMessage(p: Page, message: string) {
    await p.getByRole("textbox", { name: "Message", exact: true }).fill(message);
    const sent = p.waitForRequest(request => request.method() === "POST" && request.url().includes("/api/chats/") && request.url().endsWith("/actions") && request.postDataJSON()?.action === "send");
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const operationId = (await sent).postDataJSON().operationId;
    await p.waitForURL(/#\/chat\/(?!new)[a-f0-9]+/);
    const id = p.url().split("#/chat/")[1]!;
    const state = await until(() => api(`/api/chats/${id}`), s => !s.turn && s.chat.events.some((e: any) => e.id === operationId), "conversation turn settled");
    return { id, state };
}
async function startTask(p: Page, id: string, taskId: string) {
    const start = p.getByRole("button", { name: "Start task", exact: true });
    await until(() => start.isEnabled(), Boolean, "reviewed task can start");
    await start.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    return until(() => api(`/api/chats/${id}`), s => s.tasks.find((t: any) => t.task.id === taskId)?.execution?.status === "done", "task completion");
}
test("New chat defaults to Agent, preserves drafts and continues one normal provider session", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        assert.equal(await p.getByRole("button", { name: "Agent", exact: true }).getAttribute("aria-pressed"), "true");
        const message = p.getByRole("textbox", { name: "Message", exact: true });
        await message.fill("Keep this draft across mode changes");
        await p.getByRole("button", { name: "Team", exact: true }).click();
        await p.getByRole("button", { name: "Agent", exact: true }).click();
        assert.equal(await message.inputValue(), "Keep this draft across mode changes");
        await p.reload(); await message.waitFor();
        assert.equal(await message.inputValue(), "Keep this draft across mode changes");
        const first = await sendMessage(p, "CHAT_AGENT Explore this project");
        assert.equal(first.state.chat.taskIds.length, 0);
        assert.equal(first.state.chat.agentRuns.length, 1);
        await until(() => message.inputValue(), v => v === "", "draft cleared after acknowledgment");
        const next = await sendMessage(p, "CHAT_AGENT Explain the result");
        assert.equal(next.state.chat.agentRuns.length, 1);
        assert.equal(next.state.leadUsage.calls, 0);
        assert.equal(next.state.chat.events.filter((e: any) => e.kind === "answer").length, 2);
        await until(() => api(`/api/runs/${next.state.chat.agentRuns[0]}`), run => run.seen === true, "the latest native follow-up is marked read while its chat is visible");
        await p.screenshot({ path: join(root, "output/playwright/unified-chat-agent.png"), fullPage: true });
    } finally { await context.close(); }
});
test("Team discussion stays lightweight, then one chat plans, implements and retains both results", { timeout: 180000 }, async () => {
    const { context, page: p } = await page();
    try {
        await p.getByRole("button", { name: "Team", exact: true }).click();
        const discussion = await sendMessage(p, "CHAT_DISCUSS What would change if we used OAuth? Discuss model and effort tradeoffs.");
        assert.equal(discussion.state.chat.taskIds.length, 0);
        await p.getByText("OAuth would change the authentication boundary. This is a discussion; no task or worker execution was created.", { exact: true }).waitFor();
        await p.goto(`${base}/#/run/${discussion.state.chat.leadRuns.at(-1)}`);
        await p.getByRole("heading", { name: "Lead response", exact: true }).waitFor();
        await p.getByRole("region", { name: "Conversation lead response", exact: true }).getByText("OAuth would change the authentication boundary. This is a discussion; no task or worker execution was created.", { exact: true }).waitFor();
        assert.equal(await p.getByRole("textbox", { name: "Message", exact: true }).count(), 0, "private lead runs continue through their owning chat");
        await p.getByRole("link", { name: "Return to chat", exact: true }).click();
        await p.waitForURL(new RegExp(`#/chat/${discussion.id}$`));
        await p.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        const ready = await sendMessage(p, "WEB_TASK_PLAN Plan a login form. Plan only."), taskId = ready.state.chat.taskIds[0];
        assert.equal(ready.state.tasks[0].execution, undefined);
        await p.goto(`${base}/#/run/${ready.state.chat.leadRuns.at(-1)}`);
        await p.getByRole("heading", { name: "Proposed approach", exact: true }).waitFor();
        await p.getByRole("heading", { name: "Proposed participants", exact: true }).waitFor();
        assert.equal(await p.locator(".lead-raw pre").isVisible(), false, "protocol JSON stays collapsed");
        await p.getByRole("link", { name: "Review approach in chat", exact: true }).click();
        await p.waitForURL(new RegExp(`#/chat/${ready.id}$`));
        await p.getByRole("button", { name: "Adjust approach", exact: true }).click();
        const drawer = p.getByRole("dialog", { name: "Task details", exact: true });
        await drawer.locator("fieldset").filter({ hasText: "planner · independent participant" }).getByLabel("Effort", { exact: true }).selectOption("low");
        await drawer.getByRole("button", { name: "Save revised approach" }).click();
        await until(() => api(`/api/chats/${ready.id}`), s => s.tasks[0].proposal.definition.participants[0].effort === "low", "model effort saved");
        await drawer.getByRole("button", { name: "Close task details" }).click();
        const planned = await startTask(p, ready.id, taskId);
        assert.equal(planned.tasks[0].task.executions.length, 1);
        assert.equal(planned.tasks[0].execution.outcome, "agreed_plan");
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        await p.getByLabel("Task result", { exact: true }).getByText(/Fixture login plan/).waitFor();
        await p.reload();
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        assert.equal(await p.getByRole("button", { name: "Team", exact: true }).getAttribute("aria-pressed"), "true");
        const implementation = await sendMessage(p, "WEB_TASK_BUILD Implement the value change now");
        assert.equal(implementation.state.chat.taskIds.length, 2);
        assert.equal(implementation.state.tasks[1].proposal.context.continueRunId, planned.tasks[0].execution.id);
        const built = await startTask(p, ready.id, implementation.state.chat.taskIds[1]);
        assert.equal(built.tasks[1].execution.outcome, "verified_changes");
        await p.getByRole("heading", { name: "Changes verified", exact: true }).waitFor();
        assert.equal(await p.getByRole("heading", { name: "Plan agreed", exact: true }).count(), 1);
        assert.equal(await p.locator(`button[data-chat="${ready.id}"]`).count(), 1);
        assert.equal(await p.locator(`button[data-task="${built.tasks[1].execution.id}"]`).count(), 0);
        completedTask = ready.id;
        const reply = p.getByRole("textbox", { name: "Message", exact: true }), box = await reply.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 1000);
        await p.locator(".task-chat-scroll").evaluate(el => { el.scrollTop = 0; });
        assert.equal((await reply.boundingBox())?.y, box.y);
        await p.screenshot({ path: join(root, "output/playwright/unified-chat-team.png"), fullPage: true });
        await p.setViewportSize({ width: 360, height: 844 });
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
        const mobile = await reply.boundingBox(); assert.ok(mobile && mobile.y >= 0 && mobile.y + mobile.height <= 844);
        await p.getByRole("button", { name: "Task details", exact: true }).click();
        await drawer.getByText("Previous executions and worktrees", { exact: true }).first().waitFor();
        await drawer.getByText(/codex ·/).first().waitFor();
        await drawer.getByRole("button", { name: "Close task details" }).click();
        await p.screenshot({ path: join(root, "output/playwright/unified-chat-mobile.png"), fullPage: true });
    } finally { await context.close(); }
});
test("stale source cannot start and refreshing the approach preserves the chat", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        await p.getByRole("button", { name: "Team", exact: true }).click();
        const ready = await sendMessage(p, "WEB_TASK_PLAN Prepare a source-pinned plan. Plan only.");
        await writeFile(join(repo, "app.mjs"), "export const value = 4;\n");
        await p.getByRole("button", { name: "Start task", exact: true }).click();
        await p.getByRole("alert").filter({ hasText: /Repository changed/ }).waitFor();
        assert.equal((await api(`/api/chats/${ready.id}`)).tasks[0].execution, undefined);
        await p.getByRole("button", { name: "Refresh source", exact: true }).click();
        await until(() => api(`/api/chats/${ready.id}`), s => s.tasks[0].proposal.revision === 2, "source refreshed");
        const done = await startTask(p, ready.id, ready.state.chat.taskIds[0]);
        assert.equal(done.tasks[0].execution.outcome, "agreed_plan");
        assert.match(await readFile(join(repo, "app.mjs"), "utf8"), /4/);
    } finally { await writeFile(join(repo, "app.mjs"), "export const value = 1;\n"); await context.close(); }
});
test("a chat restores completed tasks after the server restarts", { timeout: 120000 }, async () => {
    assert.ok(completedTask);
    server.kill("SIGTERM"); await until(async () => server.exitCode, v => v !== null, "owner shutdown"); await startServer();
    const { context, page: p } = await page();
    try {
        await p.goto(`${base}/?token=${token}#/chat/${completedTask}`);
        await p.getByRole("heading", { name: "Changes verified", exact: true }).waitFor();
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        const state = await api(`/api/chats/${completedTask}`);
        assert.equal(state.chat.taskIds.length, 2);
        assert.equal(state.chat.events.filter((e: any) => e.kind === "result").length, 2);
        assert.equal(await p.locator(`button[data-chat="${completedTask}"]`).count(), 1);
    } finally { await context.close(); }
});

test("attachment bytes and explicit task targets survive draft reloads", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        await p.getByRole("textbox", { name: "Message", exact: true }).fill("Keep the file with this unsent message");
        const bytes = Buffer.alloc(800000, "a");
        await p.getByLabel("Attach files", { exact: true }).setInputFiles({ name: "large-context.txt", mimeType: "text/plain", buffer: bytes });
        await p.getByRole("button", { name: "Remove large-context.txt", exact: true }).waitFor();
        assert.ok(await p.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes("chat-draft:")).every(([, value]) => value.length < 10000)), "Attachment bytes stay out of localStorage");
        await p.reload();
        await p.getByRole("button", { name: "Remove large-context.txt", exact: true }).waitFor();
        const sent = await sendMessage(p, "CHAT_AGENT Use the attached context");
        assert.equal(sent.state.chat.files[0].bytes, bytes.length);
        await p.goto(`${base}/#/chat/${completedTask}`);
        await p.getByRole("button", { name: "Ask about this task", exact: true }).last().click();
        await p.getByRole("textbox", { name: "Message", exact: true }).fill("A question about this task");
        await p.reload();
        await p.getByText(/^Replying to:/).waitFor();
        assert.equal(await p.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "A question about this task");
        await p.getByRole("button", { name: "Switch to new work", exact: true }).click();
        assert.equal(await p.getByText(/^Replying to:/).count(), 0);
    } finally { await context.close(); }
});
