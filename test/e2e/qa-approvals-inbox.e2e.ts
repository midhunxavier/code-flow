// The approval inbox in the browser: the card stays on the request you read, a click acts on what
// was on screen, a card that replaced one answered elsewhere waits for you to say you've read it,
// the card leaves the composer's Send usable, every pending request can be reached, questions are
// fieldsets with pressable options, the run says it waits for you, and what code-flow declines
// unasked stays in view.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ApprovalRecord } from "../../src/approvals.js";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-approvals-inbox-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const start = (task: string, at = repo) => api<Run>("/api/runs", { pattern: "solo", repo: at, task, roles: { agent: ["codex"] }, approvals: { tools: true }, loop: { check: "", prove: false, maxMinutes: 2, maxSteps: 5 } });
const records = (run?: string) => api<ApprovalRecord[]>(`/api/approvals${run ? `?run=${run}` : ""}`);
const pending = async (run?: string) => (await records(run)).filter((record) => record.status === "pending");
/** Leaves nothing waiting for the next test, and lets every run finish. */
async function settle() {
  for (const record of await pending()) await fetch(base + `/api/approvals/${record.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "decline" }) });
  await until(() => api<Run[]>("/api/runs"), (runs) => runs.every((run) => run.status !== "running"));
}
async function openApp(target: Page, hash = "") {
  await target.goto(`${base}/?token=${token}#/${hash}`);
  await target.locator("main").waitFor();
}
async function makeRepo(path: string) {
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  await writeFile(join(path, "README.md"), "Approval inbox fixture\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: path });
}
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** What a click at the middle of this box would land on: the button itself, or whatever covers it. */
const landsOn = (target: Page, box: Box) => target.evaluate(({ x, y }) => {
  const element = document.elementFromPoint(x, y);
  const button = element?.closest("button");
  return element?.closest("aside.approval-inbox") ? "card" : button ? button.getAttribute("aria-label") || button.textContent!.trim() : element?.tagName ?? "nothing";
}, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function auditInbox(target: Page) {
  // Audit the settled card, not blended colors partway through its entrance animation.
  await target.locator("aside.approval-inbox").evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  await target.addScriptTag({ content: axe.source });
  const result = await target.evaluate(async () => (window as unknown as { axe: typeof axe }).axe.run("aside.approval-inbox", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
  assert.deepEqual(result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) })), []);
}

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-approvals-inbox-")));
  repo = join(directory, "repo");
  await makeRepo(repo);
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: join(directory, "home"), CODEFLOW_TOKEN: token, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break;
    if (attempt === 99 || server.exitCode !== null) throw new Error(`Approval inbox server did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
  page.setDefaultTimeout(10_000);
});

// Whatever a test leaves waiting would hold the next one's card (and its runs) up.
afterEach(settle);

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await rm(directory, { recursive: true, force: true });
});

test("a newer request never takes the card's place, and a click acts on the request that was on screen", { timeout: 45_000 }, async () => {
  const first = await start("ASK-APPROVAL first chat: clean the build folder");
  await until(() => pending(first.id), (records) => records.length === 1);
  await openApp(page);
  const card = page.getByRole("alert", { name: "Tool approval required" });
  const approve = card.getByRole("button", { name: "Approve once", exact: true });
  await card.getByText("ASK-APPROVAL first chat: clean the build folder", { exact: true }).waitFor(); // the card names its run
  await until(() => approve.isEnabled(), Boolean);
  const box = (await approve.boundingBox())!;

  const second = await start("ASK-APPROVAL second chat: also clean it");
  await until(() => pending(), (records) => records.length === 2);
  await card.getByText("1 of 2 pending", { exact: true }).waitFor();
  assert.match(await card.locator(".ai-folder").innerText(), new RegExp(first.id), "the card still shows the request being read");
  await auditInbox(page);
  // The cursor was already on Approve once: the click lands on the first chat's request.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(() => records(first.id), (records) => records[0]?.status !== "pending");
  assert.equal((await records(first.id))[0]!.status, "approved");
  assert.equal((await records(second.id))[0]!.status, "pending");
  await card.getByText("ASK-APPROVAL second chat: also clean it", { exact: true }).waitFor();
  assert.equal(await card.getByRole("status").count(), 0, "your own decision needs no notice");
});

test("a request answered in another window disarms the card that takes its place", { timeout: 45_000 }, async () => {
  const shown = await start("ASK-APPROVAL third chat");
  await until(() => pending(shown.id), (records) => records.length === 1);
  const other = await start("ASK-APPROVAL fourth chat");
  await until(() => pending(), (records) => records.length === 2);
  const second = await browser.newPage({ viewport: { width: 1440, height: 900 } }); // another device, signed in with the token
  await second.addInitScript((path) => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "0"); }, repo);
  try {
    await openApp(page); await openApp(second);
    const here = page.getByRole("alert", { name: "Tool approval required" });
    const there = second.getByRole("alert", { name: "Tool approval required" });
    // Both offer the request that expires first, whichever arrived last.
    for (const card of [here, there]) {
      await card.getByText("ASK-APPROVAL third chat", { exact: true }).waitFor();
      await until(() => card.getByRole("button", { name: "Approve once", exact: true }).isEnabled(), Boolean);
    }
    const approveThere = there.getByRole("button", { name: "Approve once", exact: true });
    const box = (await approveThere.boundingBox())!;
    let posts = 0;
    second.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/approvals/")) posts++; });
    const declined = Date.now();
    await here.getByRole("button", { name: "Decline", exact: true }).click();
    const notice = there.getByRole("status").filter({ hasText: "The request you were viewing was answered elsewhere, expired or was cancelled" });
    await notice.waitFor();
    assert.equal(await approveThere.isDisabled(), true, "the replacement isn't armed yet");
    await second.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // a click aimed at the card that left
    await there.getByText("ASK-APPROVAL fourth chat", { exact: true }).waitFor();
    await auditInbox(second);
    // Waiting is not reading: long after the swap, a click on the replacement still does nothing.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, declined + 2_500 - Date.now())));
    assert.equal(await approveThere.isDisabled(), true, "time alone doesn't arm a card that replaced one you were reading");
    assert.equal(await there.getByRole("button", { name: "Decline", exact: true }).isDisabled(), true);
    await second.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(posts, 0);
    assert.equal((await records(shown.id))[0]!.status, "declined");
    assert.equal((await records(other.id))[0]!.status, "pending");
    // Saying you've read it is what arms it.
    await there.getByRole("button", { name: "Decide on this one", exact: true }).click();
    await notice.waitFor({ state: "detached" });
    await until(() => approveThere.isEnabled(), Boolean);
    await approveThere.click();
    await until(() => records(other.id), (records) => records[0]?.status === "approved");
    assert.equal(posts, 1);
  } finally { await second.close(); }
});

test("the card leaves the New run composer's Send usable, and Hide folds it out of the way of a run's own Send", { timeout: 60_000 }, async () => {
  // A worktree path that wrapped onto four lines, and a task that wrapped onto three, made the card cover Send.
  const deep = join(directory, "a-folder-with-a-long-name-so-the-worktree-path-wraps", "and-another-one-nested-under-it-to-make-sure", "repo");
  await makeRepo(deep);
  const task = "ASK-APPROVAL seventh chat: clean the build folder, with a task long enough that its title would wrap onto a second and a third line";
  const run = await start(task, deep);
  const [record] = await until(() => pending(run.id), (records) => records.length === 1);
  assert.ok(record!.cwd!.length > 200, record!.cwd);
  await openApp(page);
  const card = page.getByRole("alert", { name: "Tool approval required" });
  const send = page.locator("button.task-start");
  await card.getByText(task, { exact: true }).waitFor();
  const sendBox = (await send.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  assert.equal(overlaps(cardBox, sendBox), false, `the card (top ${cardBox.y}) covers Send (${sendBox.y}–${sendBox.y + sendBox.height})`);
  assert.match(await landsOn(page, sendBox), /^(Send|Start run)$/);
  // The long task and folder take one line each; the full text is a hover away.
  const folder = card.locator(".ai-folder code");
  assert.equal(await folder.getAttribute("title"), record!.cwd);
  assert.equal(await folder.innerText(), record!.cwd, "the whole path stays in the page, only its start is clipped");
  assert.ok((await folder.boundingBox())!.height < 30, "the folder is one line");
  assert.ok((await card.locator(".ai-run").boundingBox())!.height < 30, "the task is one line");

  // On the run's page the card sits over the chat's own Send; Hide folds it into a pill clear of it.
  await openApp(page, `run/${run.id}`);
  await card.getByText(task, { exact: true }).waitFor();
  const message = page.getByPlaceholder(/^Message /);
  await message.fill("a note for later");
  const chatSend = page.getByRole("button", { name: "Send", exact: true });
  const chatBox = (await chatSend.boundingBox())!;
  assert.equal(await landsOn(page, chatBox), "card", "the open card is over the chat's Send at this size");
  const approve = card.getByRole("button", { name: "Approve once", exact: true });
  await until(() => approve.isEnabled(), Boolean);
  await card.getByRole("button", { name: "Hide request", exact: true }).click();
  assert.equal(await approve.isVisible(), false);
  assert.equal(overlaps((await card.boundingBox())!, chatBox), false);
  assert.equal(await landsOn(page, chatBox), "Send");
  await card.getByText("1 waiting", { exact: true }).waitFor();
  await auditInbox(page);
  assert.equal((await pending(run.id)).length, 1, "hiding decides nothing");
  // Shown again, its buttons are back where the pill was: they wait a moment before they work.
  await card.getByRole("button", { name: "Show request", exact: true }).click();
  assert.equal(await approve.isDisabled(), true);
  await until(() => approve.isEnabled(), Boolean);
});

test("a run's page offers its own request first, Next reaches the rest, and the run says it waits for you", { timeout: 45_000 }, async () => {
  const older = await start("ASK-APPROVAL fifth chat: older");
  await until(() => pending(older.id), (records) => records.length === 1);
  const newer = await start("ASK-APPROVAL sixth chat: newer");
  await until(() => pending(), (records) => records.length === 2);
  await openApp(page, `run/${newer.id}`);
  const card = page.getByRole("alert", { name: "Tool approval required" });
  await card.getByText("ASK-APPROVAL sixth chat: newer", { exact: true }).waitFor();
  const pill = page.locator(".run-kicker .status-pill");
  assert.equal(await pill.innerText(), "Waiting for you");
  await card.getByRole("button", { name: "Next request", exact: true }).click();
  await card.getByText("ASK-APPROVAL fifth chat: older", { exact: true }).waitFor();
  await card.getByText("2 of 2 pending", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Approve once", exact: true }).isEnabled(), true, "a request you moved to yourself works at once");
  await card.getByRole("button", { name: "Previous request", exact: true }).click();
  await card.getByText("ASK-APPROVAL sixth chat: newer", { exact: true }).waitFor();
  await settle();
  await until(() => pill.innerText(), (text) => text !== "Waiting for you");
});

test("a question's text never picks an option, and each option has its own name and pressed state", { timeout: 45_000 }, async () => {
  const run = await start("ASK-QUESTION pick a badge color");
  await openApp(page, `run/${run.id}`);
  const card = page.getByRole("alert", { name: "Agent question" });
  const group = card.getByRole("group", { name: "Badge color Which color should the badge use?" });
  await group.waitFor();
  assert.equal(await card.getByRole("button", { name: "Red", exact: true }).count(), 1);
  await card.getByText("Cool, matches the link palette", { exact: true }).waitFor();
  const answer = group.getByRole("textbox", { name: "Which color should the badge use?" });
  await answer.fill("Teal");
  await group.getByText("Which color should the badge use?", { exact: true }).click();
  assert.equal(await answer.inputValue(), "Teal", "clicking the question keeps a typed answer");
  await auditInbox(page);
  const blue = card.getByRole("button", { name: "Blue", exact: true });
  await blue.click();
  assert.deepEqual([await blue.getAttribute("aria-pressed"), await card.getByRole("button", { name: "Red", exact: true }).getAttribute("aria-pressed"), await answer.inputValue()], ["true", "false", "Blue"]);
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  const [record] = await until(() => records(run.id), (records) => records[0]?.status === "approved");
  assert.deepEqual(record!.answers, { color: "Blue" });
});

test("a request code-flow declines on its own stays in view after the turn, outside Show work", { timeout: 45_000 }, async () => {
  const run = await start("ASK-APPROVAL OUTSIDE-WORKTREE tidy a folder elsewhere");
  await until(() => api<Run>(`/api/runs/${run.id}`), (value) => value.status !== "running");
  assert.deepEqual(await records(run.id), [], "you were never asked");
  await openApp(page, `run/${run.id}`);
  const note = page.getByRole("note").filter({ hasText: "code-flow declined Codex's request" });
  await note.waitFor();
  assert.equal(await note.innerText(), "code-flow declined Codex's request to run `rm -rf build` without asking you: it would run outside this run's worktree");
  assert.equal(await page.getByRole("button", { name: /^Show work/ }).getAttribute("aria-expanded"), "false");
});

test("an approval refusal arriving after the card was replaced is still explained", { timeout: 45000 }, async () => {
  const first = await start("ASK-APPROVAL race first");
  const [request] = await until(() => pending(first.id), records => records.length === 1);
  const second = await start("ASK-APPROVAL race second");
  await until(() => pending(), records => records.length === 2);
  await openApp(page);
  const card = page.getByRole("alert", { name: "Tool approval required" });
  await card.getByText("ASK-APPROVAL race first", { exact: true }).waitFor();
  await until(() => card.getByRole("button", { name: "Approve once", exact: true }).isEnabled(), Boolean);
  await page.route(`**/api/approvals/${request!.id}`, async route => {
    await api(`/api/approvals/${request!.id}`, { decision: "decline" });
    await card.getByText("ASK-APPROVAL race second", { exact: true }).waitFor();
    await route.fulfill({ status: 409, json: { error: "This request was already answered" } });
  });
  try {
    await card.getByRole("button", { name: "Approve once", exact: true }).click();
    await page.getByText("Your approval decision was not applied: This request was already answered", { exact: true }).waitFor();
    await card.getByRole("status").filter({ hasText: "This is a different one" }).waitFor();
    assert.equal(await card.getByRole("button", { name: "Approve once", exact: true }).isDisabled(), true);
    assert.equal((await records(first.id))[0]?.status, "declined");
    assert.equal((await records(second.id))[0]?.status, "pending");
  } finally { await page.unroute(`**/api/approvals/${request!.id}`); }
});
