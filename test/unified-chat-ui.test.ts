import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
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
    await mkdir(repo); repo = await realpath(repo);
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
    const start = p.getByRole("button", { name: /^Start (planning|implementation|review)$/ });
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
        await p.locator(".chat-deliverable").getByRole("button", { name: "View plan", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByText(/Fixture login plan/).waitFor();
        await p.getByRole("button", { name: "Approach", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByText("Accepted for this execution", { exact: false }).waitFor();
        await p.getByRole("button", { name: "Preview", exact: true }).click();
        await p.getByText(/No running preview for this task/).waitFor();
        await p.getByRole("button", { name: "Close task output" }).click();
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
        await p.getByRole("button", { name: "Agent", exact: true }).click();
        await p.locator(".chat-deliverable").last().getByRole("button", { name: "View changes", exact: true }).click();
        await p.getByRole("button", { name: "Reviews", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByLabel("Task result", { exact: true }).waitFor();
        const modelBox = await p.getByRole("button", { name: "Message settings", exact: true }).boundingBox(), permissionsBox = await p.locator(".unified-chat .chat-permissions > button").boundingBox();
        assert.ok(modelBox && permissionsBox && (modelBox.x + modelBox.width <= permissionsBox.x + 1 || modelBox.y + modelBox.height <= permissionsBox.y + 1), "model and permission controls do not overlap beside the output");
        await p.getByRole("button", { name: "Close task output" }).click();
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
        await drawer.getByText("Advanced · execution history and receipts", { exact: true }).first().waitFor();
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
        await p.getByRole("button", { name: /^Start (planning|implementation|review)$/ }).click();
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
        await p.locator(`button[data-chat="${completedTask}"]`).waitFor();
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

test("message settings are anchored, keyboard accessible and distinguish lead from workers", { timeout: 90000 }, async () => {
  const { context, page: p } = await page();
  try {
    await p.getByRole("button", { name: "Team", exact: true }).click();
    const trigger = p.getByRole("button", { name: "Message settings", exact: true }); await trigger.click();
    const picker = p.getByRole("dialog", { name: "Message settings", exact: true }); await picker.waitFor();
    await picker.getByText("Team lead", { exact: true }).waitFor();
    assert.equal(await p.getByRole("dialog", { name: "Task details", exact: true }).isVisible(), false);
    await picker.getByRole("button", { name: /Default effort/ }).click(); await p.getByRole("menuitem", { name: "high", exact: true }).click();
    assert.match(await trigger.innerText(), /high/i); await p.keyboard.press("Escape"); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await p.setViewportSize({ width: 360, height: 844 }); await trigger.click();
    const bounds = await picker.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await p.screenshot({ path: join(root, "output/playwright/workspace-settings-mobile.png"), fullPage: true });
    await picker.getByRole("button", { name: "Close message settings" }).click();
  } finally { await context.close(); }
});
test("project context has an explicit scope and new turns pin the saved revision", { timeout: 90000 }, async () => {
  const { context, page: p } = await page();
  try {
    await p.getByRole("button", { name: "Add files or context" }).click(); await p.getByRole("menuitem", { name: "Project context", exact: true }).click();
    const editor = p.getByRole("dialog", { name: "Project context", exact: true });
    await editor.getByRole("textbox", { name: "Project instructions" }).fill("All controls must support keyboard navigation.");
    await editor.getByLabel("Attach project files", { exact: true }).setInputFiles({ name: "shared-context.txt", mimeType: "text/plain", buffer: Buffer.from("Shared acceptance criteria.") });
    await editor.getByText("shared-context.txt · New", { exact: true }).waitFor(); await editor.getByRole("button", { name: "Save project context" }).click();
    await until(() => editor.isVisible(), value => !value, "context saved");
    await p.getByRole("button", { name: "Team", exact: true }).click(); const ready = await sendMessage(p, "WEB_TASK_PLAN Plan an accessible form.");
    assert.equal(ready.state.chat.events.find((e: any) => e.kind === "user").projectContext.revision, 1);
    assert.match(ready.state.tasks[0].proposal.context.notes, /keyboard navigation/);
    await p.getByRole("button", { name: "View approach", exact: true }).click();
    await p.getByLabel("Task output", { exact: true }).getByText("Awaiting your authorization", { exact: false }).waitFor();
    await p.screenshot({ path: join(root, "output/playwright/workspace-output-desktop.png"), fullPage: true });
    await p.setViewportSize({ width: 360, height: 844 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await p.getByRole("button", { name: "Close task output" }).click(); await p.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  } finally { await context.close(); }
});
test("chat menus rename, pin, archive and restore; search finds message contents", { timeout: 90000 }, async () => {
  const { context, page: p } = await page();
  try {
    const sent = await sendMessage(p, "CHAT_AGENT Searchable architecture discussion");
    const row = () => p.locator(`button[data-chat="${sent.id}"]`).locator(".."); await row().waitFor();
    const options = () => row().getByRole("button", { name: /^Chat options for/ });
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const rename = p.getByRole("dialog", { name: "Rename chat", exact: true }); await rename.getByRole("textbox", { name: "Chat title" }).fill("Architecture notes"); await rename.getByRole("button", { name: "Save", exact: true }).click();
    await p.getByRole("heading", { name: "Architecture notes", exact: true }).waitFor();
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await until(() => api(`/api/chats/${sent.id}`), s => s.chat.pinned, "chat pinned");
    const search = p.getByRole("searchbox", { name: "Search runs (press / to focus)" }); await search.fill("Searchable architecture");
    await row().getByText(/Searchable architecture discussion/).waitFor(); await row().getByRole("button", { name: /Architecture notes/ }).first().click();
    await p.getByText("Viewing earlier messages", { exact: false }).waitFor(); await search.fill("");
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Archive chat", exact: true }).click();
    await until(() => p.locator(`button[data-chat="${sent.id}"]`).count(), n => n === 0, "chat hidden from active history");
    await p.getByRole("button", { name: "Archived chats", exact: true }).click(); await row().waitFor();
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Restore chat", exact: true }).click();
    await until(() => api(`/api/chats/${sent.id}`), s => !s.chat.archived, "chat restored");
    await p.getByRole("button", { name: "Back to active chats", exact: true }).click(); await row().waitFor();
  } finally { await context.close(); }
});
test("long history loads in bounded pages, preserves the visible message and searches beyond the latest page", { timeout: 120000 }, async () => {
  const created = await api("/api/chats", { operationId: "long-history-fixture", project: project.id, repo, defaults: { mode: "agent", provider: "claude", trust: "standard", tools: false } });
  server.kill("SIGTERM"); await until(async () => server.exitCode, v => v !== null, "fixture shutdown");
  const path = join(home, "state/runs/conversations.journal.jsonl"), journal = await readFile(path, "utf8"), entries = journal.trim().split("\n").map(l => JSON.parse(l));
  const metadata = entries.filter(e => e.key === `chat:${created.id}`).at(-1).value, events = Array.from({ length: 2100 }, (_, i) => ({ id: `history-${i + 1}`, sequence: i + 1, at: Date.now() + i, kind: i % 2 ? "answer" : "user", body: i === 16 ? "Archived needle: accessible keyboard focus" : `Historical message ${i + 1}` }));
  await writeFile(path, journal + events.map(e => JSON.stringify({ key: `event:${created.id}:${e.sequence}`, value: e, v: 1 })).join("\n") + "\n" + JSON.stringify({ key: `chat:${created.id}`, value: { ...metadata, events: [], eventCount: events.length, title: "Long history fixture" }, v: 1 }) + "\n");
  await startServer(); const state = await api(`/api/chats/${created.id}`); assert.equal(state.history.total, 2100); assert.equal(state.chat.events.length, 50);
  const { context, page: p } = await page();
  try {
    await p.goto(`${base}/#/chat/${created.id}`); const scroller = p.locator(".task-chat-scroll"); await p.getByText("Historical message 2100", { exact: true }).waitFor();
    await scroller.evaluate(el => el.scrollTop = 0); const anchor = p.locator('[data-chat-sequence="2051"]'); const before = (await anchor.boundingBox())!.y;
    await p.getByRole("button", { name: "Load earlier messages", exact: true }).click(); await p.getByText("Historical message 2001", { exact: true }).waitFor();
    assert.ok(Math.abs((await anchor.boundingBox())!.y - before) < 5, "prepending history preserves the visible message");
    assert.ok(await p.locator(".chat-event").count() <= 150);
    await p.getByRole("button", { name: "Back to latest", exact: true }).click(); await p.getByText("Historical message 2100", { exact: true }).waitFor();
    await p.getByRole("searchbox", { name: "Search runs (press / to focus)" }).fill("Archived needle");
    await p.locator(`button[data-chat="${created.id}"]`).click(); await p.getByText("Archived needle: accessible keyboard focus", { exact: true }).waitFor();
    assert.ok(await p.locator(".chat-event").count() <= 150);
  } finally { await context.close(); }
});
test("start without a repository, then attach one in the same chat", { timeout: 90000 }, async () => {
  const { context, page: p } = await page();
  try {
    await p.getByLabel("Repository", { exact: true }).selectOption(""); await p.getByLabel("Project", { exact: true }).selectOption("");
    const discussed = await sendMessage(p, "Discuss login accessibility without inspecting code.");
    assert.equal(discussed.state.chat.repo, ""); assert.equal(discussed.state.tasks.length, 0);
    await p.getByRole("button", { name: "Task details", exact: true }).click();
    const drawer = p.getByRole("dialog", { name: "Task details", exact: true }); await drawer.getByLabel("Project", { exact: true }).selectOption(project.id); await drawer.getByLabel("Repository", { exact: true }).selectOption(repo);
    await until(() => drawer.getByRole("button", { name: "Attach repository", exact: true }).isEnabled(), Boolean, "repository is ready");
    await drawer.getByRole("button", { name: "Attach repository", exact: true }).click();
    await until(() => api(`/api/chats/${discussed.id}`), state => state.chat.repo === repo, "repository attached");
    assert.equal(p.url().split("#/chat/")[1], discussed.id);
  } finally { await context.close(); }
});

test("task-first automation reviews, tests and enables the exact team without approving the original task", { timeout: 120000 }, async () => {
    const { context, page: p } = await page();
    try {
        assert.equal(await p.getByRole("button", { name: "Task details", exact: true }).count(), 0, "empty chats have no task inspector");
        assert.equal(await p.getByRole("button", { name: "Existing workflows", exact: true }).count(), 0);
        await p.goto(`${base}/#/project/${project.id}/automation`);
        await p.getByRole("heading", { name: "What would you like to automate?" }).waitFor();
        await p.getByRole("textbox", { name: "Automation task" }).fill("WEB_TASK_PLAN Plan the repository improvements every weekday. Plan only. Use Claude and Codex at high effort.");
        await p.getByRole("button", { name: "Create automation", exact: true }).click();
        await p.waitForURL(/#\/chat\/[a-f0-9]+$/);
        const id = p.url().split("#/chat/")[1]!;
        const ready = await until(() => api(`/api/chats/${id}`), s => !s.turn && s.tasks.length > 0, "automation approach prepared");
        await p.getByRole("button", { name: "Automate this", exact: true }).click();
        const setup = p.getByRole("dialog", { name: "Do this again", exact: true });
        await setup.getByText("Fresh committed HEAD for each occurrence", { exact: true }).waitFor();
        await setup.getByRole("button", { name: "Test now", exact: true }).click();
        await setup.getByRole("region", { name: "Automation test evidence" }).waitFor();
        const list = await api("/api/automations"), saved = list.find((a:any) => a.run.chatRecipe?.chatId === id);
        assert.ok(saved); assert.equal(saved.enabled, false);
        await until(() => api(`/api/automations/${saved.id}/test-evidence`), s => s.snapshot?.execution?.status === "done", "automation test finished");
        await until(() => setup.getByRole("button", { name: "Enable automation", exact: true }).isEnabled(), Boolean, "test allowance released");
        await p.screenshot({ path: join(root,"output/playwright/automation-setup-desktop.png"), fullPage:true });
        await p.setViewportSize({width:390,height:844}); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth+2));
        await p.screenshot({path:join(root,"output/playwright/automation-setup-mobile.png"),fullPage:true});
        await setup.getByRole("button", { name: "Enable automation", exact: true }).click();
        await until(() => api("/api/automations"), rows => rows.find((a:any) => a.id === saved.id)?.enabled, "automation enabled");
        const chat = await api(`/api/chats/${id}`);
        assert.equal(chat.tasks.find((t:any) => t.task.id === ready.tasks[0].task.id).execution,undefined);
        assert.equal(chat.chat.taskIds.length,2);
        await api(`/api/automations/${saved.id}`,{enabled:false});
    } finally { await context.close(); }
});

test("project settings owns shared defaults and advanced saved workflows", { timeout: 60000 }, async () => {
    const { context, page: p } = await page();
    try {
        await p.goto(`${base}/#/project/${project.id}/settings`);
        await p.getByRole("heading",{name:"Defaults",exact:true}).waitFor();
        await p.getByRole("button",{name:"Edit project defaults",exact:true}).click();
        const dialog=p.getByRole("dialog",{name:"Project context",exact:true});
        await dialog.getByLabel("Check command",{exact:true}).fill("node --test app.test.mjs");
        await dialog.getByLabel("Managed calls",{exact:true}).fill("8");
        await dialog.getByRole("button",{name:"Save project context",exact:true}).click();
        await until(() => api(`/api/chats/context?project=${project.id}&repo=${encodeURIComponent(repo)}`),c=>c.defaults?.maxCalls===8,"shared defaults saved");
        assert.equal(await p.getByRole("button",{name:"Saved workflows",exact:true}).isVisible(),false);
        await p.getByText("Advanced · saved workflows and repository configuration",{exact:true}).click();
        assert.equal(await p.getByRole("button",{name:"Saved workflows",exact:true}).isVisible(),true);
    } finally { await context.close(); }
});

test("chat webhook setup stays disabled during testing and authenticated events preserve the reviewed team", { timeout: 90000 }, async () => {
    const created = await api("/api/chats", { operationId: crypto.randomUUID(), purpose: "automation", project: project.id, repo, source: "head", defaults: { mode: "team", provider: "claude", trust: "standard", tools: false } });
    await api(`/api/chats/${created.id}/actions`, { operationId: crypto.randomUUID(), action: "send", expectedVersion: created.version, message: "WEB_TASK_PLAN Plan the requested improvements when a webhook arrives. Plan only." });
    const ready = await until(() => api(`/api/chats/${created.id}`), s => !s.turn && s.tasks[0]?.proposal, "webhook approach ready");
    const task = ready.tasks[0], proposal = task.proposal;
    const request = { operationId: crypto.randomUUID(), name: "Webhook team", enabled: false, webhook: true, fromChat: { chatId: created.id, taskId: task.task.id, proposalHash: proposal.hash } };
    const saved = await api("/api/automations",request), repeated = await api("/api/automations",request);
    assert.equal(saved.id,repeated.id);
    const deliver = () => fetch(`${base}${saved.hookPath}`, { method:"POST",headers:{authorization:`Bearer ${saved.token}`,"content-type":"application/json"},body:JSON.stringify({details:"A repository event requires review"}) });
    assert.equal((await deliver()).status,409,"disabled webhook cannot dispatch");
    const testId=crypto.randomUUID(), tested=await api(`/api/automations/${saved.id}/test`,{operationId:testId,revision:saved.revision});
    const duplicate=await api(`/api/automations/${saved.id}/test`,{operationId:testId,revision:saved.revision}); assert.equal(tested.id,duplicate.id);
    await until(()=>api(`/api/runs/${tested.id}`), r=>r.status==="done","test settled");
    assert.equal((await api("/api/automations")).find((a:any)=>a.id===saved.id).enabled,false);
    await api(`/api/automations/${saved.id}`,{enabled:true,revision:saved.revision});
    assert.equal((await deliver()).status,202);
    const fired = await until(()=>api("/api/automations"), list=>list.find((a:any)=>a.id===saved.id)?.lastRunId!==tested.id,"webhook run admitted");
    const runId=fired.find((a:any)=>a.id===saved.id).lastRunId;
    const run=await until(()=>api(`/api/runs/${runId}`), r=>r.status==="done","webhook run settled");
    assert.equal(run.inheritedSourceTrust,"untrusted");
    // Each recurring execution pins resolved models; provenance changes from provider default to task.
    const resolved = (participants: any[]) => participants.map(({ id, provider, model, effort }) => ({ id, provider, model, effort }));
    assert.deepEqual(resolved(run.cliTeam.definition.participants),resolved(proposal.definition.participants));
    assert.match(run.task,/text sent with the webhook/);
    await api(`/api/automations/${saved.id}`,{enabled:false});
    const once = await api("/api/automations", { ...request, operationId: crypto.randomUUID(), name: "One-time team", webhook: false, onceAt: Date.now()+86400000 });
    const { context, page: p } = await page();
    try {
        await p.goto(`${base}/#/automations`);
        const row = p.locator(".auto-row").filter({has:p.getByText("One-time team",{exact:true})});
        await row.getByRole("button",{name:"Edit",exact:true}).click();
        const when = new Date(Date.now()+2*86400000);
        const local = new Date(when.getTime()-when.getTimezoneOffset()*60000).toISOString().slice(0,16);
        await row.locator('input[type="datetime-local"]').fill(local);
        await row.getByRole("button",{name:"Save time",exact:true}).click();
        const changed = await until(()=>api("/api/automations"),list=>list.find((a:any)=>a.id===once.id)?.revision>once.revision,"one-time edit saved");
        const current = changed.find((a:any)=>a.id===once.id);
        assert.equal(current.onceAt,new Date(local).getTime()); assert.equal(current.enabled,false);
    } finally { await context.close(); }
});
