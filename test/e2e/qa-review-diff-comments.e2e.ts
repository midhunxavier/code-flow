// Review diffs and the comments sent from them, in the browser: files with non-ASCII or " b/" names
// show lines to comment on, a diff with none says why, a draft follows its code when the branch
// moves, a recipient is never shown as chosen before it is, and an Agent chat keeps its provider.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Run } from "../../src/engine.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const token = "qa-review-diff-comments-e2e";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let server: ChildProcess, browser: Browser, page: Page, base: string, directory: string, repo: string;
const errors: string[] = [];
const gitIn = (cwd: string) => (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, encoding: "utf8" }).trim();
const writeIn = (cwd: string) => async (path: string, text: string | Buffer) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), text); };
async function api<T = Run>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const finished = (id: string) => until(() => api(`/api/runs/${id}`), run => run.status !== "running", 60_000);
const solo = async (agent: string, task: string) => {
  const run = await finished((await api("/api/runs", { repo, pattern: "solo", task, roles: { agent: [agent] }, loop: { check: "true", maxMinutes: 1, maxSteps: 4 } })).id);
  assert.equal(run.status, "done", run.error);
  return run;
};
const review = (run: Run, branch = run.worktrees[0]!.branch) => page.goto(`${base}/#/review/${run.id}/${encodeURIComponent(branch)}`);

before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-qa-review-e2e-")));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const write = writeIn(repo), git = gitIn(repo);
  await write("README.md", "# Fixture\n> from npm (requires uv)\nUsage\nNotes\nOld line five\nMore\n");
  await write("CODE_OF_CONDUCT.md", "Be kind.\n");
  git("add", "."); git("commit", "-qm", "initial");
  const port = await new Promise<number>(resolve => {
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
  server.stdout?.on("data", chunk => { output += chunk; }); server.stderr?.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then(response => response.ok, () => false)) break;
    if (attempt === 149 || server.exitCode !== null) throw new Error(`Server failed to start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await api("/api/projects", { name: "Review fixture", repos: [repo] });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(path => { localStorage.setItem("repo", path); if (localStorage.getItem("sideOpen") === null) localStorage.setItem("sideOpen", "0"); }, repo);
  await page.goto(`${base}/?token=${token}`);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("every changed file shows lines to comment on, and a diff with none says why", { timeout: 60_000 }, async () => {
  const run = await solo("claude", "Add notes with unusual names");
  const tree = run.worktrees[0]!;
  const git = gitIn(tree.path), write = writeIn(tree.path);
  await write("café notes.md", "line of café\n");
  await write("a b/c.txt", "line of a b/c\n");
  await write("empty.txt", "");
  await write("blob.bin", Buffer.from([0, 1, 2]));
  git("mv", "CODE_OF_CONDUCT.md", "CODE_OF_CONDUCT-renamed.md");
  git("add", "café notes.md", "a b/c.txt", "empty.txt", "blob.bin"); git("commit", "-qm", "fixture files");
  await write("notas-café.md", "working line\n");
  await review(run);
  const diff = page.locator(".review-diff");
  const open = (name: string) => page.locator(".review-files button.rf", { hasText: name }).click();
  for (const name of ["café notes.md", "a b/c.txt", "notas-café.md"]) {
    await open(name);
    await diff.locator(".diff-file-head", { hasText: name }).waitFor();
    assert.equal(await diff.locator("tr.dl.add[tabindex]").count(), 1, `${name} has its added line`);
  }
  await open("café notes.md");
  await diff.locator("tr.dl.add").click();
  await page.getByLabel("Comment on line 1", { exact: true }).fill("Name this file in ASCII");
  await page.getByRole("button", { name: /Add comment/ }).click();
  await diff.locator(".comment-row", { hasText: "Name this file in ASCII" }).waitFor();
  for (const [name, note] of [["CODE_OF_CONDUCT-renamed.md", "Renamed from CODE_OF_CONDUCT.md with no content changes."], ["empty.txt", "Empty file added."], ["blob.bin", "Binary file — no text diff."]] as const) {
    await open(name);
    await diff.locator(".tree-empty", { hasText: note }).waitFor();
    assert.match(await diff.locator(".diff-file-head").innerText(), new RegExp(name.replace(/\./g, "\\.")));
    assert.equal(await diff.locator("table.diff").isVisible(), false);
  }
  assert.match(await diff.locator(".diff-file-head").innerText(), /blob\.bin/);
  await open("CODE_OF_CONDUCT-renamed.md");
  assert.equal(await diff.locator(".diff-file-head").innerText(), "CODE_OF_CONDUCT.md → CODE_OF_CONDUCT-renamed.md");
  assert.deepEqual(errors, []);
});

test("a draft comment follows its code after the branch moves, and one whose code is gone is listed apart", { timeout: 60_000 }, async () => {
  const run = await solo("claude", "Tidy the readme");
  const tree = run.worktrees[0]!;
  const git = gitIn(tree.path), write = writeIn(tree.path);
  const readme = () => readFile(join(tree.path, "README.md"), "utf8");
  await write("README.md", (await readme()).replace("Old line five", "New line five")); git("commit", "-qam", "edit line five");
  await review(run);
  await page.locator(".review-files button.rf", { hasText: "README.md" }).click();
  const diff = page.locator(".review-diff");
  for (const [code, text] of [["> from npm", "Please mention pip install here"], ["Usage", "Explain usage in more detail"]] as const) {
    await diff.locator("tr.dl.ctx", { hasText: code }).click();
    await diff.locator("textarea").fill(text);
    await diff.locator("textarea").press("Control+Enter");
    await diff.locator(".comment-row", { hasText: text }).waitFor();
  }
  // Someone else's commit: three lines on top, and the "Usage" line reworded.
  await write("README.md", "inserted A\ninserted B\ninserted C\n" + (await readme()).replace("Usage\n", "Usage guide\n")); git("commit", "-qam", "external update");
  await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
  await diff.locator("tr.dl", { hasText: "inserted B" }).waitFor();
  const rows = await diff.locator("tbody tr").evaluateAll(trs => trs.map(tr => tr.classList.contains("comment-row") ? `comment: ${(tr as HTMLElement).innerText.trim()}` : (tr as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
  const at = rows.findIndex(row => row.includes("Please mention pip install here"));
  assert.match(rows[at - 1]!, /^2 5 > from npm \(requires uv\)$/, rows.join("\n"));
  assert.ok(!rows[rows.findIndex(row => row.includes("inserted B")) + 1]!.startsWith("comment"), "never under the line that took its number");
  const elsewhere = diff.locator(".comments-elsewhere");
  await elsewhere.getByText("Explain usage in more detail").waitFor();
  assert.match(await elsewhere.innerText(), /Line 3: Usage/);
  const sent = page.waitForRequest(request => request.url().endsWith(`/api/runs/${run.id}/followups`) && request.method() === "POST");
  await page.getByRole("button", { name: "Send 2 comments", exact: true }).click();
  const body = (await sent).postDataJSON();
  assert.equal(body.agent, "claude");
  assert.match(body.message, /^1\. README\.md:5 — `> from npm \(requires uv\)`\n {3}Please mention pip install here\n/);
  assert.match(body.message, /2\. README\.md \(was line 3; that code has changed or is no longer in the diff\) — `Usage`/);
  assert.doesNotMatch(body.message, /README\.md:2/);
  await page.waitForURL(url => url.hash === `#/run/${run.id}`);
  assert.equal((await until(() => api(`/api/runs/${run.id}`), run => run.status !== "running" && !!run.followUps[0] && run.followUps[0].status !== "pending", 60_000)).followUps[0]!.status, "done");
  assert.deepEqual(errors, []);
});

test("with no known writer the recipient is a placeholder, so picking the first agent counts", { timeout: 60_000 }, async () => {
  const run = await finished((await api("/api/runs", { repo, pattern: "council", task: "Review the readme", roles: { reviewers: ["claude", "codex"], chair: ["claude"] } })).id);
  assert.equal(run.status, "done", run.error);
  await review(run);
  await page.getByLabel("Overall comment", { exact: true }).fill("Please tighten the loop bound");
  const picker = page.getByRole("combobox", { name: "Agent", exact: true });
  await until(() => picker.evaluate(select => (select as HTMLSelectElement).selectedOptions[0]?.textContent), text => text === "Choose an agent…");
  assert.equal(await picker.inputValue(), "");
  const send = page.getByRole("button", { name: "Send 1 comment", exact: true });
  assert.equal(await send.isDisabled(), true);
  // A keyboard pick of the first agent (no synthetic events): it changes the selection, so it counts.
  await picker.focus();
  await page.keyboard.type("Claude");
  await until(() => send.isEnabled(), enabled => enabled);
  assert.equal(await picker.inputValue(), "claude");
  assert.deepEqual(errors, []);
});

test("an Agent chat's comments go to its provider at once; a team run's wait for its writer or ask", { timeout: 120_000 }, async () => {
  const chat = await solo("codex", "Add a note file");
  // The Review page names the chat's provider instead of offering others.
  await review(chat);
  await page.getByLabel("Overall comment", { exact: true }).fill("Describe the project in the note");
  await page.locator(".review-send .agent-fixed", { hasText: "Codex" }).waitFor();
  assert.equal(await page.locator(".review-send select").count(), 0);
  // The Changes tab, while the full run is held back: the provider is known from the summary.
  const panel = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  panel.on("pageerror", error => errors.push(error.message));
  await panel.addInitScript(path => { localStorage.setItem("repo", path); localStorage.setItem("sideOpen", "1"); localStorage.setItem("sideTab", "changes"); }, repo);
  const draft = async (run: Run) => {
    await panel.goto(`${base}/?token=${token}#/run/${run.id}`);
    await panel.locator(".changes .rf").first().click();
    await panel.locator(".changes-diff tr.dl.add").first().click();
    await panel.locator(".changes-diff textarea").fill("Rename this file");
    await panel.locator(".changes-diff textarea").press("Control+Enter");
    await panel.locator(".changes-send").waitFor();
  };
  let release!: () => void;
  const hold = (run: Run, fail = false) => {
    const held = new Promise<void>(resolve => { release = resolve; });
    return panel.route(new RegExp(`/api/runs/${run.id}$`), async route => {
      if (route.request().method() !== "GET") return route.continue();
      if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily unavailable" }) });
      await held; await route.continue().catch(() => {});
    });
  };
  const send = panel.locator(".changes-send .btn.primary");
  const picker = panel.locator(".changes-send select");
  try {
    await draft(chat);
    await hold(chat);
    await panel.reload();
    await panel.locator(".changes-send .agent-fixed", { hasText: "Codex" }).waitFor();
    assert.equal(await send.isEnabled(), true);
    const sent = panel.waitForResponse(response => response.url().endsWith(`/api/runs/${chat.id}/followups`) && response.request().method() === "POST");
    await send.click();
    const response = await sent;
    assert.equal(response.status(), 200, await response.text());
    assert.equal(response.request().postDataJSON().agent, "codex");
    release(); await panel.unrouteAll({ behavior: "wait" });
    const revised = await until(() => api(`/api/runs/${chat.id}`), run => run.status !== "running" && !!run.followUps[0] && run.followUps[0].status !== "pending", 60_000);
    assert.deepEqual(revised.followUps.map(f => [f.kind, f.agent, f.status]), [["comments", "codex", "done"]]);

    // A team run: nobody is chosen until its steps say who wrote the branch.
    const team = await finished((await api("/api/runs", { repo, pattern: "pipeline", task: "Improve the readme", roles: { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] }, loop: { check: "true", maxMinutes: 2, maxSteps: 8 } })).id);
    assert.equal(team.status, "done", team.error);
    await draft(team);
    await hold(team);
    await panel.reload();
    await panel.locator(".changes-send").waitFor();
    assert.equal(await picker.evaluate(select => (select as HTMLSelectElement).selectedOptions[0]?.textContent), "Loading recipient…");
    assert.equal(await send.isDisabled(), true);
    release(); await panel.unrouteAll({ behavior: "wait" });
    await until(() => picker.inputValue(), value => value === "codex");
    assert.equal(await send.isEnabled(), true);
    // It can't load: say so, and wait for a choice.
    await hold(team, true);
    await panel.reload();
    await panel.locator(".changes-send", { hasText: "Couldn't load who wrote this" }).waitFor();
    assert.equal(await picker.inputValue(), "");
    assert.equal(await send.isDisabled(), true);
    await picker.selectOption("claude");
    assert.equal(await send.isEnabled(), true);
  } finally { release?.(); await panel.unrouteAll({ behavior: "ignoreErrors" }); await panel.close(); }
  assert.deepEqual(errors, []);
});
