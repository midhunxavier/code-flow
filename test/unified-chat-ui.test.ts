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
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(home, "state"), CODEFLOW_TOKEN: token, PORT: new URL(base).port, SHELL: "/bin/sh", PATH: `${join(home, "bin")}:${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_NO_BROWSER: "0", SSH_CONNECTION: "", CODEFLOW_SSH_HOST: "", DISPLAY: ":fixture", CODEFLOW_BROWSER_CAPTURE: join(home, "opened-url"), CODEFLOW_RETRY_DELAYS_MS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr])
        stream?.on("data", c => logs += c);
    await until(() => { if (server.exitCode !== null)
        throw new Error(`Server exited during startup:\n${logs.slice(-6000)}`); return fetch(`${base}/api/health`, { headers }).then(r => r.ok, () => false); }, Boolean, "server startup", 60000);
}
before(async () => {
    home = await mkdtemp(join(tmpdir(), "codeflow-chat-ui-"));
    await mkdir(join(home, "bin"));
    for (const command of ["open", "xdg-open"]) await writeFile(join(home, "bin", command), '#!/bin/sh\nprintf "%s" "$1" > "$CODEFLOW_BROWSER_CAPTURE"\n', { mode: 0o755 });
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
async function openTaskDetails(p: Page) {
    if (!await p.getByRole("tab", { name: "Task", exact: true }).isVisible()) await p.getByRole("button", { name: "Side panel", exact: true }).click();
    await p.getByRole("tab", { name: "Task", exact: true }).click();
    return p.getByRole("tabpanel", { name: "Task", exact: true });
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
        await openTaskDetails(p);
        await p.getByRole("button", { name: "Adjust approach", exact: true }).click();
        const drawer = p.getByRole("tabpanel", { name: "Task", exact: true });
        await drawer.locator("fieldset").filter({ hasText: "planner · independent participant" }).getByLabel("Effort", { exact: true }).selectOption("low");
        await drawer.getByRole("button", { name: "Save revised approach" }).click();
        await until(() => api(`/api/chats/${ready.id}`), s => s.tasks[0].proposal.definition.participants[0].effort === "low", "model effort saved");
        await p.getByRole("button", { name: "Close side panel", exact: true }).click();
        const planned = await startTask(p, ready.id, taskId);
        assert.equal(planned.tasks[0].task.executions.length, 1);
        assert.equal(planned.tasks[0].execution.outcome, "agreed_plan");
        await p.getByRole("heading", { name: "Plan agreed", exact: true }).waitFor();
        await p.locator(".chat-deliverable").getByRole("region", { name: "Final result", exact: true }).getByText(/Fixture login plan/).waitFor();
        await p.locator(".chat-deliverable").getByRole("button", { name: "Evidence and changes", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByText(/Fixture login plan/).waitFor();
        await p.getByLabel("Task output", { exact: true }).getByRole("button", { name: "Approach", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByText("Accepted for this execution", { exact: false }).waitFor();
        await p.getByLabel("Task output", { exact: true }).getByRole("button", { name: "Preview", exact: true }).click();
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
        await p.locator(".chat-deliverable").last().getByRole("button", { name: "Evidence and changes", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByRole("button", { name: "Reviews", exact: true }).click();
        await p.getByLabel("Task output", { exact: true }).getByLabel("Task result", { exact: true }).waitFor();
        // Read both rectangles in one frame after the responsive layout settles.
        // Compact controls may wrap in either order.
        await p.waitForFunction(() => {
            const model = document.querySelector(".unified-chat .chat-model-summary")?.getBoundingClientRect();
            const permission = document.querySelector(".unified-chat .chat-permissions > button")?.getBoundingClientRect();
            return !!model?.width && !!permission?.width && (model.right <= permission.left + 1 || permission.right <= model.left + 1 || model.bottom <= permission.top + 1 || permission.bottom <= model.top + 1);
        });
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
        await openTaskDetails(p);
        await drawer.getByText("Advanced · execution history and receipts", { exact: true }).first().waitFor();
        await drawer.getByRole("heading", { name: "Agents", exact: true }).waitFor();
        await p.getByRole("button", { name: "Close side panel", exact: true }).click();
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
        await openTaskDetails(p);
        await p.getByRole("button", { name: "Refresh source", exact: true }).click();
        await p.getByRole("button", { name: "Close side panel", exact: true }).click();
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
        await openTaskDetails(p);
        await p.getByRole("tabpanel", { name: "Task", exact: true }).getByRole("button", { name: "Ask in chat", exact: true }).click();
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
    const trigger = p.getByRole("button", { name: /^Message settings:/ }); await trigger.click();
    const picker = p.getByRole("dialog", { name: "Message settings", exact: true }); await picker.waitFor();
    await picker.getByText("Team lead", { exact: true }).waitFor();
    assert.doesNotMatch(await picker.innerText(), /Changes apply to new messages|The lead prepares approaches/);
    assert.ok((await picker.boundingBox())!.height < 200);
    assert.equal(await p.getByRole("tabpanel", { name: "Task", exact: true }).isVisible(), false);
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
    // The whole approach is readable in the thread before starting, and the side panel opens it there without closing.
    const proposed = p.getByRole("region", { name: "Proposed approach", exact: true });
    await proposed.getByRole("heading", { name: "Steps", exact: true }).waitFor();
    await proposed.getByText("Awaiting your authorization", { exact: false }).waitFor();
    assert.equal(await proposed.getByRole("button", { name: "Start planning", exact: true }).isEnabled(), true);
    const panel = await openTaskDetails(p);
    await panel.getByRole("button", { name: "Show approach in chat", exact: true }).click();
    await until(() => proposed.evaluate(el => { const scroller = el.closest(".task-chat-scroll")!, box = scroller.getBoundingClientRect(), top = el.getBoundingClientRect().top, atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1; return top >= box.top - 1 && (top < box.top + 40 || atEnd); }), Boolean, "approach scrolled into view");
    assert.equal(await panel.isVisible(), true, "the side panel stays open");
    await p.screenshot({ path: join(root, "output/playwright/workspace-output-desktop.png"), fullPage: true });
    await p.setViewportSize({ width: 360, height: 844 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    // On a phone-width screen the panel covers the chat, so showing the approach closes it.
    await panel.getByRole("button", { name: "Show approach in chat", exact: true }).click();
    await p.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await proposed.getByRole("heading", { name: "Steps", exact: true }).waitFor();
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
    const search = p.getByRole("searchbox", { name: "Search chats (press / to focus)" }); await search.fill("Searchable architecture");
    await row().getByText(/Searchable architecture discussion/).waitFor(); await row().getByRole("button", { name: /Architecture notes/ }).first().click();
    await p.getByText("Viewing earlier messages", { exact: false }).waitFor(); await search.fill("");
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Archive chat", exact: true }).click();
    await until(() => p.locator(`button[data-chat="${sent.id}"]`).count(), n => n === 0, "chat hidden from active history");
    await p.getByRole("button", { name: /^Application menu:/ }).click();
    await p.getByRole("menuitem", { name: /^Show archived chats/ }).click(); await row().waitFor();
    await row().hover(); await options().click(); await p.getByRole("menuitem", { name: "Restore chat", exact: true }).click();
    await until(() => api(`/api/chats/${sent.id}`), s => !s.chat.archived, "chat restored");
    await p.getByRole("button", { name: /^Application menu:/ }).click(); await p.getByRole("menuitem", { name: /^Hide archived chats/ }).click(); await row().waitFor();
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
    // The page restores the scroll position on the frame after the earlier messages render.
    await until(async () => Math.abs((await anchor.boundingBox())!.y - before), moved => moved < 5, "prepending history preserves the visible message", 5000);
    assert.ok(await p.locator(".chat-event").count() <= 150);
    await p.getByRole("button", { name: "Back to latest", exact: true }).click(); await p.getByText("Historical message 2100", { exact: true }).waitFor();
    await p.getByRole("searchbox", { name: "Search chats (press / to focus)" }).fill("Archived needle");
    await p.locator(`button[data-chat="${created.id}"]`).click(); await p.getByText("Archived needle: accessible keyboard focus", { exact: true }).waitFor();
    assert.ok(await p.locator(".chat-event").count() <= 150);
  } finally { await context.close(); }
});
test("start without a repository, then attach one in the same chat", { timeout: 90000 }, async () => {
  const { context, page: p } = await page();
  try {
    await p.getByLabel("Project", { exact: true }).selectOption("");
    const discussed = await sendMessage(p, "Discuss login accessibility without inspecting code.");
    assert.equal(discussed.state.chat.repo, ""); assert.equal(discussed.state.tasks.length, 0);
    await openTaskDetails(p);
    const drawer = p.getByRole("tabpanel", { name: "Task", exact: true }); await drawer.getByLabel("Project", { exact: true }).selectOption(project.id); await drawer.getByLabel("Repository", { exact: true }).selectOption(repo);
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
        await p.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        await p.getByRole("button", { name: "Team", exact: true }).click();
        assert.equal(await p.getByRole("button", { name: "Schedule task", exact: true }).getAttribute("aria-pressed"), "true");
        assert.equal(await p.getByLabel("Project", { exact: true }).inputValue(), project.id);
        assert.equal(await p.getByRole("button", { name: /Daily review|Event checks|Issue queue/ }).count(), 0);
        await p.screenshot({path:join(root,"output/playwright/automation-home-refined.png")});
        await p.setViewportSize({width:390,height:844});
        assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await p.screenshot({path:join(root,"output/playwright/automation-home-refined-mobile.png")});
        await p.setViewportSize({width:1400,height:1000});
        await p.getByRole("textbox", { name: "Message", exact: true }).fill("WEB_TASK_PLAN Plan the repository improvements every weekday. Plan only. Use Claude and Codex at high effort.");
        await p.getByRole("button", { name: "Send", exact: true }).click();
        await p.waitForURL(/#\/chat\/[a-f0-9]+$/);
        const id = p.url().split("#/chat/")[1]!;
        const ready = await until(() => api(`/api/chats/${id}`), s => !s.turn && s.tasks.length > 0, "automation approach prepared");
        const setup = p.getByRole("dialog", { name: "Schedule task", exact: true });
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

test("project settings owns shared defaults and advanced run defaults", { timeout: 60000 }, async () => {
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
        await p.getByText("Advanced · run defaults and repository configuration",{exact:true}).click();
        assert.equal(await p.getByRole("button",{name:/workflow/i}).count(),0,"the workflow run opens from chat, not from project settings");
        await p.setViewportSize({ width: 320, height: 568 });
        const defaults = p.getByRole("region", { name: "Project run defaults" });
        const check = defaults.getByRole("textbox", { name: "Default check command" });
        await check.waitFor();
        const bounds = await check.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320, "repository defaults fit a narrow phone");
        assert.equal(await defaults.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
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
        await p.goto(`${base}/#/settings/automations`);
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


test("chat composer previews and undoes prompt rewrites without submitting work; context and navigation stay compact", { timeout: 60000 }, async () => {
    const { context, page: p } = await page();
    const original = "Create a login form. Use Claude Haiku and Codex Luna at high effort. Do not deploy.";
    const improved = "Goal: Create a login form.\nTeam: Claude Haiku and Codex Luna, both at high effort.\nConstraint: Do not deploy.";
    const mutations: string[] = []; let reject = false;
    p.on("request", request => { if(request.method()==="POST" && /\/api\/(chats|runs)(\/|$)/.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
    await p.route("**/api/improve-prompt", route => {
        const body = route.request().postDataJSON(); assert.equal(body.text,original); assert.equal(body.mode,"quick");
        return route.fulfill({ status:reject ? 503 : 200, contentType:"application/json",body:JSON.stringify(reject ? {error:"Rewrite provider is unavailable"} : {prompt:improved,summary:"Organized the goal, team and constraints.",agent:"claude"}) });
    });
    try {
        const message=p.getByRole("textbox",{name:"Message",exact:true});
        const improve=p.getByRole("button",{name:"Improve prompt",exact:true});
        assert.equal(await improve.isVisible(),true); assert.equal(await improve.isDisabled(),true);
        assert.equal(await p.getByText("Enter to send · Shift + Enter for a new line",{exact:true}).count(),0);
        const row=p.getByLabel("Chat project and repository",{exact:true});
        assert.ok((await row.boundingBox())!.y < (await message.boundingBox())!.y);
        assert.equal(await p.getByRole("button",{name:/^SSH connections:/}).count(),1);
        assert.equal(await p.locator(".connection-status.connected").count(),0);
        assert.doesNotMatch(await p.locator(".rail-history").innerText(),/tasks? loaded/);
        assert.equal(await p.getByRole("button",{name:"Archived chats",exact:true}).count(),0);
        const toggle=p.getByRole("button",{name:"Projects",exact:true});
        await toggle.click(); assert.equal(await toggle.getAttribute("aria-expanded"),"false");
        await p.reload(); await toggle.waitFor(); assert.equal(await toggle.getAttribute("aria-expanded"),"false");
        assert.equal(await p.locator("#rail-project-groups").isVisible(),false);
        await toggle.click(); assert.equal(await p.locator("#rail-project-groups").isVisible(),true);
        await message.fill(original);
        await p.getByRole("button",{name:"Improve prompt",exact:true}).click();
        const dialog=p.getByRole("dialog",{name:"Improve your prompt",exact:true});
        await dialog.getByLabel("Suggested prompt",{exact:true}).waitFor();
        assert.equal(await message.inputValue(),original,"preview preserves the draft");
        await p.screenshot({path:join(root,"output/playwright/chat-improve-preview.png")});
        await dialog.getByRole("button",{name:"Use this prompt",exact:true}).click();
        assert.equal(await message.inputValue(),improved);
        await p.getByRole("button",{name:"Undo rewrite",exact:true}).click(); assert.equal(await message.inputValue(),original);
        reject=true;
        await p.getByRole("button",{name:"Improve prompt",exact:true}).click();
        await dialog.getByRole("alert").waitFor();
        await dialog.getByRole("button",{name:"Keep original",exact:true}).click();
        assert.equal(await message.inputValue(),original); assert.deepEqual(mutations,[]);
        await p.screenshot({path:join(root,"output/playwright/chat-composer-refined.png")});
        await p.setViewportSize({width:390,height:844});
        assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        assert.ok((await row.boundingBox())!.y < (await message.boundingBox())!.y);
        await p.screenshot({path:join(root,"output/playwright/chat-composer-refined-mobile.png")});
    } finally { await context.close(); }
});


test("new-work links open the project's chat and one link opens the workflow run", {timeout:60000}, async () => {
    const {context, page:p} = await page();
    try {
        const contextRow=p.getByLabel("Chat project and repository",{exact:true});
        for (const hash of [`#/project/${project.id}/new`, "#/new/unassigned"]) {
            await p.evaluate(value => { location.hash = value; }, hash);
            await p.waitForURL(url => url.hash === (hash.startsWith("#/project") ? `#/project/${project.id}/chat` : "#/chat/new"));
            await p.getByRole("textbox",{name:"Message",exact:true}).waitFor();
            assert.equal(await contextRow.getByLabel("Project",{exact:true}).inputValue(), hash.startsWith("#/project") ? project.id : "");
            assert.equal(await p.getByRole("textbox",{name:"Task",exact:true}).count(),0,"the run form is not the start screen here");
        }
        await p.evaluate(id => { location.hash = `#/project/${id}/chat`; }, project.id);
        await contextRow.getByRole("button",{name:"Open workflow run",exact:true}).click();
        await p.waitForURL(url => url.hash === `#/project/${project.id}/workflow`);
        await p.getByRole("textbox",{name:"Task",exact:true}).waitFor();
        assert.equal(await p.locator(".composer .eyebrow").innerText(),"Workflow run");
        assert.equal(await p.getByRole("navigation",{name:"Where you are"}).locator('[aria-current="page"]').innerText(),"Workflow run");
        assert.equal(await p.locator("details.advanced-controls details.settings").count(),0,"Advanced is the only options disclosure");
        assert.equal(await p.getByRole("button",{name:"Advanced options",exact:true}).getAttribute("aria-expanded"),"false");
        await p.getByRole("button",{name:"Advanced options",exact:true}).click();
        for (const name of ["Workflow","Acceptance criteria","Checks","Permissions","Branches and limits","Agent isolation","Context inspector","Run details"]) await p.locator(".advanced-controls").getByRole("heading",{name,exact:true}).waitFor();
        await p.keyboard.press("Meta+k");
        const commands=p.getByRole("combobox",{name:"Find a command, project or run"});
        await commands.fill("open workflow run");
        await p.getByRole("option",{name:/Open workflow run/}).waitFor();
        await p.keyboard.press("Escape");
    } finally { await context.close(); }
});
test("project selection inherits a single repository and preserves explicit multi-repository choices across reloads", {timeout:90000}, async () => {
    const first = join(await realpath(home), "service"), second = join(await realpath(home), "website");
    for (const folder of [first,second]) execFileSync("git", ["clone", "--quiet", repo, folder]);
    const multi = await api("/api/projects", {name:"Multiple repositories", repos:[first,second]});
    const empty = await api("/api/projects", {name:"Discussion project", repos:[]});
    const {context, page:p} = await page();
    try {
        const contextRow=p.getByLabel("Chat project and repository",{exact:true});
        assert.equal(await contextRow.getByLabel("Repository",{exact:true}).count(),0);
        const chooseProject=contextRow.getByLabel("Project",{exact:true});
        await p.getByRole("textbox",{name:"Message",exact:true}).fill("CHAT_AGENT Keep this project draft");
        await chooseProject.selectOption(multi.id);
        await p.waitForURL(new RegExp(`/project/${multi.id}/chat$`));
        const chooseRepo=contextRow.getByLabel("Repository",{exact:true});
        await chooseRepo.waitFor(); assert.equal(await chooseRepo.inputValue(),"");
        await p.getByRole("textbox",{name:"Message",exact:true}).fill("CHAT_AGENT Inspect the selected repository");
        assert.equal(await p.getByRole("button",{name:"Send",exact:true}).isDisabled(),true);
        await chooseRepo.selectOption(second); await p.reload();
        await chooseRepo.waitFor(); assert.equal(await chooseRepo.inputValue(),second);
        assert.equal(await p.getByRole("textbox",{name:"Message",exact:true}).inputValue(),"CHAT_AGENT Inspect the selected repository");
        const sent=await sendMessage(p,"CHAT_AGENT Inspect the selected repository");
        assert.equal(sent.state.chat.repo,second); assert.equal(sent.state.chat.project,multi.id);
        await p.goto(`${base}/#/project/${project.id}/chat`);
        await chooseProject.waitFor();
        assert.equal(await p.getByRole("textbox",{name:"Message",exact:true}).inputValue(),"CHAT_AGENT Keep this project draft");
        await chooseProject.selectOption(empty.id); assert.equal(await contextRow.getByLabel("Repository",{exact:true}).count(),0);
        await p.getByRole("button",{name:"Add repository",exact:true}).waitFor();
        await chooseProject.selectOption(""); await p.reload(); await chooseProject.waitFor();
        assert.equal(await chooseProject.inputValue(),""); assert.equal(await contextRow.getByLabel("Repository",{exact:true}).count(),0);
        await chooseProject.selectOption(project.id);
        const single=await sendMessage(p,"CHAT_AGENT Use the inherited repository");
        assert.equal(single.state.chat.repo,repo); assert.equal(single.state.chat.project,project.id);
        await p.goto(`${base}/#/automations`);
        await p.getByRole("button", { name: "Schedule task", exact: true }).waitFor();
        assert.equal(await p.locator(".automations, .automation-legacy, .automation-list-heading").count(),0);
        await p.goto(`${base}/#/settings/automations`);
        await p.locator(".automations").waitFor();
        assert.equal(await p.getByText("Advanced scheduling tools",{exact:true}).count(), 0);
        await p.goto(`${base}/#/project/${multi.id}/automation`);
        await chooseRepo.waitFor();
        await chooseRepo.selectOption("");
        await p.getByRole("textbox",{name:"Message",exact:true}).fill("Review each morning");
        assert.equal(await p.getByRole("button",{name:"Send",exact:true}).isDisabled(),true);
        await chooseRepo.selectOption(second);
        await until(() => p.getByRole("button",{name:"Send",exact:true}).isEnabled(), Boolean, "scheduled chat inherits repository source");
        assert.equal(await p.getByRole("button", {name:"Schedule task",exact:true}).getAttribute("aria-pressed"), "true");
    } finally { await context.close(); }
});

test("CLI workspace: real MCP proposal opens an authenticated chat, browser approval and native approval stay in sync", { timeout: 120000 }, async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli-teams/cli.ts", "mcp", "--project-root", repo], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(home, "state") }, stdio: ["pipe", "pipe", "pipe"] });
    let seq = 0, buffer = "", elicited = 0, approvalMessage = "", answerForms = true;
    const forms: any[] = [], notices: any[] = [];
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const send = (m: object) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    child.stdout!.on("data", chunk => {
        buffer += chunk; let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
            const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (m.method === "elicitation/create") { elicited++; approvalMessage = m.params.message; forms.push(m); if (answerForms) send({ id: m.id, result: { action: "accept", content: { approve: true } } }); continue; }
            if (m.method) { notices.push(m); continue; }
            const waiter = pending.get(m.id); if (waiter) { pending.delete(m.id); clearTimeout(waiter.timer); m.error ? waiter.reject(new Error(m.error.message)) : waiter.resolve(m.result); }
        }
    });
    const request = (method: string, params: object) => new Promise<any>((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timeout`)); }, 30000); pending.set(id, { resolve, reject, timer }); send({ id, method, params }); });
    const call = async (name: string, args: object) => { const r = (await request("tools/call", { name: `codeflow_${name}`, arguments: args })).structuredContent; assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
    const candidate = { scope: "plan", participants: [{ id: "author", provider: "claude", model: "haiku", effort: "high" }, { id: "reviewer", provider: "codex", effort: "high" }], completion: ["A reviewed login plan"], steps: [
        { id: "draft", type: "task", operation: "propose", participant: "author", instructions: "Write the login plan" },
        { id: "review", type: "task", operation: "review_plan", participant: "reviewer", instructions: "Review the plan", inputs: ["draft"] },
        { id: "gate", type: "gate", policy: "agreement", target: "draft", reviews: ["review"] },
        { id: "result", type: "finish", outcome: "agreed_plan", inputs: ["draft", "gate"] },
    ] };
    const context = await browser.newContext(), p = await context.newPage();
    try {
        await request("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } } });
        const checkpoint = { id: "inspect-draft", type: "user_decision", question: "Review the saved draft before the next worker?", options: ["Continue review", "Stop for changes"], inputs: ["draft"], continueOn: "Continue review" };
        const firstCandidate = { ...candidate, steps: [candidate.steps[0], checkpoint, ...candidate.steps.slice(1)] };
        const proposal = await call("propose_run", { operationId: "cli-ui-plan", task: "Plan a login form from CLI", candidate: firstCandidate });
        const again = await call("propose_run", { operationId: "cli-ui-plan", task: "Plan a login form from CLI", candidate: firstCandidate });
        assert.equal(proposal.proposalId, again.proposalId); assert.equal(proposal.workspace.chatId, again.workspace.chatId);
        assert.equal(proposal.approvalMethod, "native_form");
        const opened = await call("open_task", { id: proposal.proposalId }); assert.equal(opened.opened, true);
        assert.equal(new URL(opened.workspace.url).port, new URL(base).port);
        assert.doesNotMatch(JSON.stringify(opened), /cli-workspace\/|token=|bootstrap/);
        const handoff = await readFile(join(home, "opened-url"), "utf8");
        const rejected = await fetch(handoff, { headers: { origin: "https://untrusted.invalid" }, redirect: "manual" }); assert.equal(rejected.status, 403);
        await p.goto(handoff);
        await p.getByRole("button", { name: "Start planning", exact: true }).waitFor();
        assert.equal(p.url(), opened.workspace.url);
        assert.equal((await fetch(handoff, { redirect: "manual" })).status, 410, "ticket cannot be replayed");
        await p.locator(`button[data-chat="${proposal.workspace.chatId}"]`).waitFor();
        assert.equal(await p.locator(`button[data-chat="${proposal.workspace.chatId}"]`).count(), 1);
        await p.getByRole("button", { name: "Start planning", exact: true }).click();
        const activity = p.getByRole("region", { name: "Team activity" }).first();
        const outputs = activity.getByRole("list", { name: "Completed outputs" });
        await outputs.getByText(/Fixture login plan/).waitFor();
        await outputs.getByRole("button", { name: "Plan from author", exact: true }).click();
        const openedOutput = outputs.getByRole("region", { name: "Plan from author" });
        await openedOutput.getByText(/accessible labels, validation, keyboard focus/).waitFor();
        assert.equal((await api(`/api/chats/${proposal.workspace.chatId}`)).tasks[0].execution.status, "running");
        await activity.screenshot({ path: join(root, "output/playwright/cli-team-intermediate-output.png") });
        await p.getByRole("button", { name: "Continue review", exact: true }).click();
        const done = await until(() => api(`/api/chats/${proposal.workspace.chatId}`), s => s.tasks[0]?.execution?.status === "done", "CLI task completed after reviewing its intermediate output");
        assert.equal(done.tasks[0].execution.outcome, "agreed_plan");
        await outputs.getByText("Review from reviewer", { exact: true }).waitFor();
        await p.getByRole("region", { name: "Final result" }).getByText(/Fixture login plan/).waitFor();
        // Approach, reviews and result switch in place inside the task.
        const sections = activity.getByRole("group", { name: "Task sections", exact: true });
        await sections.getByRole("button", { name: /^Reviews/ }).click();
        await activity.getByRole("list", { name: "Reviews", exact: true }).getByText("Review from reviewer", { exact: true }).waitFor();
        await activity.getByText(/1 review · 1 approved/).waitFor();
        await sections.getByRole("button", { name: "Approach", exact: true }).click();
        await activity.getByText("Accepted for this execution", { exact: false }).waitFor();
        await sections.getByRole("button", { name: "Result", exact: true }).click();
        await activity.getByRole("region", { name: "Task result", exact: true }).getByText(/Fixture login plan/).waitFor();
        await sections.getByRole("button", { name: "Progress", exact: true }).click();
        await outputs.waitFor();
        assert.ok(done.tasks[0].execution.participation.every((a: any) => a.assignments.some((s: any) => s.invocations > 0)), "both fixture providers participated");
        const resumed = await call("start_run", { operationId: "recover-ui-start", proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
        assert.equal(resumed.runId, done.tasks[0].execution.id); assert.equal(elicited, 0, "browser approval is already authoritative");
        const next = await call("propose_run", { operationId: "cli-ui-next", task: "Review the login plan again", candidate, context: { chatId: proposal.workspace.chatId } });
        assert.equal(next.workspace.chatId, proposal.workspace.chatId);
        await p.reload(); await p.getByRole("button", { name: "Start planning", exact: true }).waitFor();
        const native = await call("start_run", { operationId: "native-start-ui", proposalId: next.proposalId, expectedRevision: next.revision, proposalHash: next.proposalHash });
        assert.equal(elicited, 1);
        assert.match(approvalMessage, /^Plan only, no file changes · .* · up to \d+ calls?, \d+ min\nAccept starts it here\. Or open the approval link, sign in if needed, and press Start:\nhttp:\/\/localhost:\d+\/cli-workspace\/[a-f0-9]{32}\n\nTask: [\s\S]*\n\nDecline starts nothing\.$/);
        await until(() => api(`/api/chats/${proposal.workspace.chatId}`), s => s.tasks[1]?.execution?.outcome === "agreed_plan", "native-approved run visible in browser");
        const status = await call("get_run", { runId: native.runId }); assert.equal(status.workspace.chatId, proposal.workspace.chatId);
        assert.equal(status.conversation.latestProposal.runId, native.runId);
        await p.screenshot({ path: join(root, "output/playwright/cli-workspace-synced.png"), fullPage: true });

        // Start from the browser instead: the dialog's link opens the plan, and Start is pressed there.
        answerForms = false;
        const third = await call("propose_run", { operationId: "cli-ui-third", task: "Review the login plan a third time", candidate, context: { chatId: proposal.workspace.chatId } });
        const pendingStart = request("tools/call", { name: "codeflow_start_run", arguments: { operationId: "browser-start-ui", proposalId: third.proposalId, expectedRevision: third.revision, proposalHash: third.proposalHash } });
        await until(async () => forms.length, n => n === 2, "approval dialog with a browser link");
        const dialog = forms[1], approvalLink = dialog.params.message.split("\n")[2];
        assert.match(approvalLink, /^http:\/\/localhost:\d+\/cli-workspace\/[a-f0-9]{32}$/);
        // Anything holding the CLI bootstrap secret can ask for this link, so it must never sign a browser in.
        const linked = await fetch(approvalLink, { redirect: "manual" });
        assert.equal(linked.status, 303); assert.equal(linked.headers.get("set-cookie"), null, "the approval link does not sign a browser in");
        const plan = linked.headers.get("location")!; assert.match(plan, /^\/\?team=local#\/chat\/[a-f0-9]{32}$/);
        const fresh = await browser.newContext(), signedIn = await fresh.newPage();
        try {
            await signedIn.goto(`${base}/?token=${token}`); await signedIn.goto(`${base}${plan}`);
            await signedIn.getByRole("button", { name: "Start planning", exact: true }).click();
            const started = (await pendingStart).structuredContent;
            assert.equal(started.ok, true, JSON.stringify(started));
            assert.ok(notices.some(n => n.method === "notifications/cancelled" && n.params.requestId === dialog.id), "the Claude dialog is closed after a browser start");
            assert.equal((await fetch(approvalLink, { redirect: "manual" })).status, 410, "the approval link is single-use");
            const synced = await until(() => api(`/api/chats/${proposal.workspace.chatId}`), s => s.tasks[2]?.execution?.id === started.data.runId, "browser-started run is the CLI's run");
            assert.equal(synced.tasks.filter((t: any) => t.execution?.id === started.data.runId).length, 1, "one run, not two");
        } finally { await fresh.close(); }
    } finally {
        await context.close(); child.stdin!.end();
        await until(async () => child.exitCode, x => x !== null, "MCP shutdown", 15000).catch(() => child.kill());
        for (const waiter of pending.values()) clearTimeout(waiter.timer);
    }
});

test("CLI workspace: tool-only host gets browser approval and the same chat survives an owner restart", { timeout: 90000 }, async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli-teams/cli.ts", "mcp", "--project-root", repo], { cwd: root, env: { ...process.env, CODEFLOW_HOME: join(home, "state") }, stdio: ["pipe", "pipe", "pipe"] });
    const responses: any[] = []; let buffer = "";
    child.stdout!.on("data", chunk => { buffer += chunk; let end: number; while ((end = buffer.indexOf("\n")) >= 0) { responses.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    const send = (m: object) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    let workspace: any;
    try {
        send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } });
        await until(async () => responses.find(r => r.id === 1), Boolean, "tool-only initialization");
        send({ id: 2, method: "tools/call", params: { name: "codeflow_propose_run", arguments: { operationId: "tool-only-proposal", task: "CLI-only approval fallback", candidate: { scope: "plan", participants: [{ id: "planner", provider: "codex" }], completion: ["A plan"], steps: [{ id: "draft", type: "task", operation: "propose", participant: "planner", instructions: "Write a plan" }, { id: "result", type: "finish", outcome: "plan_ready", inputs: ["draft"] }] } } } });
        const reply: any = await until(async () => responses.find(r => r.id === 2), Boolean, "tool-only proposal");
        const value = reply.result.structuredContent; assert.equal(value.ok, true, JSON.stringify(value));
        assert.equal(value.data.approvalMethod, "browser"); workspace = value.data.workspace;
        assert.match(value.data.nextAction, /Code Flow/);
        await rm(join(home, "opened-url"), { force: true });
        const remoteCmd = execFileSync(process.execPath, [join(root, "bin/codeflow.mjs"), "open", value.data.proposalId], { cwd: repo, env: { ...process.env, CODEFLOW_HOME: join(home, "state"), SSH_CONNECTION: "fixture" }, encoding: "utf8" });
        assert.match(remoteCmd, /Open in Code Flow:/); assert.doesNotMatch(remoteCmd, /Opened in Code Flow:/);
        await assert.rejects(readFile(join(home, "opened-url")), { code: "ENOENT" });
        const cmd = execFileSync(process.execPath, [join(root, "bin/codeflow.mjs"), "open", value.data.proposalId], { cwd: repo, env: { ...process.env, CODEFLOW_HOME: join(home, "state") }, encoding: "utf8" });
        assert.ok(cmd.includes(workspace.url)); assert.doesNotMatch(cmd, /cli-workspace\/|token=/);
    } finally { child.stdin!.end(); await until(async () => child.exitCode, x => x !== null, "tool-only MCP shutdown", 15000).catch(() => child.kill()); }
    const before = await api(`/api/chats/${workspace.chatId}`);
    server.kill("SIGTERM"); await until(async () => server.exitCode, x => x !== null, "owner shutdown", 30000);
    await startServer();
    const restored = await api(`/api/chats/${workspace.chatId}`);
    assert.equal(restored.chat.id, before.chat.id); assert.equal(restored.chat.events.length, before.chat.events.length);
    assert.equal(restored.tasks[0].proposal.hash, before.tasks[0].proposal.hash);
    const context = await browser.newContext(), p = await context.newPage();
    try {
        await p.goto(`${base}/?token=${token}#/chat/${workspace.chatId}`);
        await p.getByRole("button", { name: "Start planning", exact: true }).waitFor();
        await startTask(p, workspace.chatId, workspace.taskId);
        await p.getByRole("heading", { name: "Plan ready", exact: true }).waitFor();
    } finally { await context.close(); }
});

test("touch phone composers keep Enter as a line break", { timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const p = await context.newPage();
  try {
    await p.addInitScript(() => localStorage.setItem("sideOpen", "0"));
    await p.goto(`${base}/?token=${token}#/project/${project.id}/chat`);
    const message = p.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("First line");
    await message.press("Enter");
    await message.pressSequentially("Second line");
    assert.equal(await message.inputValue(), "First line\nSecond line");
    await p.getByRole("button", { name: "Side panel", exact: true }).click();
    await p.getByRole("tab", { name: "Chat", exact: true }).click();
    const sideMessage = p.locator(".side").getByRole("textbox", { name: "Message", exact: true });
    await sideMessage.fill("First line");
    await sideMessage.press("Enter");
    await sideMessage.pressSequentially("Second line");
    assert.equal(await sideMessage.inputValue(), "First line\nSecond line");
    assert.equal(await p.locator(".side").getByRole("button", { name: "Send", exact: true }).getAttribute("title"), "Send message");
    assert.ok(await p.locator(".side-tab").first().evaluate(element => element.getBoundingClientRect().height >= 44));
  } finally { await context.close(); }
});
