import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import axe from "axe-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "qa-people-names-"))), home = join(fixture, "home");
const token = "qa-people-names", headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidence = process.env.CODEFLOW_QA_EVIDENCE_DIR;
let base: string, server: ChildProcess, browser: Browser, project: string, ownerName: string, logs = "";
const errors: string[] = [];
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`); return value;
}
before(async () => {
  mkdirSync(home); if (evidence) mkdirSync(evidence, { recursive: true });
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home } });
  const port = await new Promise<number>(resolve => { const listener = createServer().listen(0, "127.0.0.1", () => { const value = (listener.address() as AddressInfo).port; listener.close(() => resolve(value)); }); });
  assert.ok(port !== 4317 && port !== 4318); base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, CODEFLOW_HOME: home, CODEFLOW_TOKEN: token, PORT: String(port), PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` }, stdio: "pipe" });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", value => logs += String(value));
  for (let i = 0; ; i++) { if (await fetch(base + "/api/health", { headers }).then(r => r.ok, () => false)) break; assert.ok(i < 300, logs); await new Promise(resolve => setTimeout(resolve, 50)); }
  project = (await api("/api/projects", { name: "People names QA", repos: [] })).id;
  for (const [username, displayName] of [["alice", "Alice"], ["emilie", "Émilie Dupré"]]) {
    const { revision } = await api("/api/accounts");
    await api("/api/accounts", { revision, username, displayName, password: "QA fixture chosen password", roles: { [project]: "contributor" } });
  }
  const board = await api("/api/team/board?teamConnection=local"); ownerName = board.projects.find((entry: any) => entry.id === project).members.find((member: any) => member.userId === "owner").displayName;
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await exited; }
  if (evidence) { writeFileSync(join(evidence, "server.log"), logs); writeFileSync(join(evidence, "page-errors.json"), JSON.stringify(errors)); }
  rmSync(fixture, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.doesNotMatch(logs, /uncaughtException|unhandledRejection|ReferenceError|TypeError:/);
});
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) test(`people names match their labels and remain keyboard operable at ${viewport.width}px`, async () => {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${base}/?token=${token}&team=local#/project/${project}/people`);
    const people = page.getByRole("region", { name: "Project people", exact: true }); await people.getByRole("button", { name: "Alice", exact: true }).waitFor();
    await page.addScriptTag({ content: axe.source });
    const result = await page.evaluate(async () => (window as any).axe.run(".project-people", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }));
    if (evidence) { await page.screenshot({ path: join(evidence, `people-${viewport.width}.png`), animations: "disabled" }); writeFileSync(join(evidence, `axe-${viewport.width}.json`), JSON.stringify(result, null, 2)); }
    assert.deepEqual(result.violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })), []);
    for (const name of [`${ownerName} You`, "Alice", "Émilie Dupré"]) {
      const button = people.getByRole("button", { name, exact: true });
      await button.focus(); await page.keyboard.press("Enter"); assert.equal(await button.getAttribute("aria-expanded"), "true");
      const target = await button.getAttribute("aria-controls"); assert.ok(target); await page.locator(`[id="${target}"]`).getByRole("heading", { name: "Project permissions", exact: true }).waitFor();
      await page.keyboard.press("Space"); assert.equal(await button.getAttribute("aria-expanded"), "false"); assert.equal(await button.evaluate(element => element === document.activeElement), true);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await context.close(); }
});
