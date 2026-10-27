import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import type { MemoryEntry } from "../../src/memory.js";
import type { MemoryAnalysis } from "../../src/memory-analysis.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const headers = { authorization: "Bearer memory-conflict-test", "content-type": "application/json" };
let server: ChildProcess;
let browser: Browser;
let page: Page;
let base: string;
let endpoint: string;
let repo: string;

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}

before(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "codeflow-memory-ui-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "Memory fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), CODEFLOW_HOME: await mkdtemp(join(tmpdir(), "codeflow-memory-ui-home-")), CODEFLOW_TOKEN: "memory-conflict-test", PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await fetch(base + "/api/health", { headers }).then((response) => response.ok, () => false)) break;
    if (attempt === 299 || server.exitCode !== null) throw new Error(`Memory UI server did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const project = await api("/api/projects", { name: "Memory UI", repos: [repo] });
  endpoint = `/api/projects/${project.id}/memory`;
  // Mount the production component with its real HTTP API so unrelated composer changes
  // cannot hide or destabilize the revision-recovery regression.
  const bundle = await build({
    stdin: { contents: `import {h,render} from "preact"; import {ProjectMemory} from "./ui/memory.tsx"; render(h(ProjectMemory, {projectId:${JSON.stringify(project.id)},repo:${JSON.stringify(repo)}}), document.body);`, resolveDir: root },
    bundle: true, write: false, format: "esm", jsx: "automatic", jsxImportSource: "preact", target: "es2022",
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ extraHTTPHeaders: headers });
  page.setDefaultTimeout(15_000);
  await page.route(base + "/memory-fixture", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><script type="module">${bundle.outputFiles![0]!.text.replace(/<\/script/gi, "<\\/script")}</script></body></html>` }));
});

after(async () => {
  await browser?.close();
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
  });
});

test("memory editor merges independent changes, resolves overlap, and preserves a deleted entry's draft", { timeout: 30_000 }, async () => {
  let entry = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Original title", body: "Original command" });
  await page.goto(base + "/memory-fixture");
  await page.getByText("Project memory", { exact: true }).click();
  let card = page.locator(".memory-card");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByLabel("Memory title", { exact: true }).fill("My draft title");
  entry = await api<MemoryEntry>(endpoint + "/commands", { op: "update", id: entry.id, expectedRevision: entry.revision, body: "Command from another window" });
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  await card.getByLabel("Resolve memory revision conflict", { exact: true }).waitFor();
  assert.equal(await card.getByLabel("Memory title", { exact: true }).inputValue(), "My draft title");
  await card.getByRole("button", { name: "Apply reviewed merge", exact: true }).click();
  assert.equal(await card.getByLabel("Memory knowledge", { exact: true }).inputValue(), "Command from another window");
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  await card.getByRole("button", { name: "Edit", exact: true }).waitFor();
  entry = (await api<MemoryEntry[]>(endpoint))[0]!;
  assert.equal(entry.title, "My draft title");
  assert.equal(entry.body, "Command from another window");

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByLabel("Memory knowledge", { exact: true }).fill("My conflicting command");
  entry = await api<MemoryEntry>(endpoint + "/commands", { op: "update", id: entry.id, expectedRevision: entry.revision, body: "Their conflicting command" });
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  const apply = card.getByRole("button", { name: "Apply reviewed merge", exact: true });
  await card.getByLabel("Resolve memory knowledge", { exact: true }).waitFor();
  assert.equal(await apply.isDisabled(), true, "overlapping edits require a deliberate choice");
  assert.equal(await card.getByLabel("Memory knowledge", { exact: true }).inputValue(), "My conflicting command");
  await card.getByLabel("Resolve memory knowledge", { exact: true }).selectOption("draft");
  await apply.click();
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  await card.getByRole("button", { name: "Edit", exact: true }).waitFor();
  entry = (await api<MemoryEntry[]>(endpoint))[0]!;
  assert.equal(entry.body, "My conflicting command");

  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByLabel("Memory knowledge", { exact: true }).fill("Preserved draft after deletion");
  await api(endpoint + "/commands", { op: "delete", id: entry.id, expectedRevision: entry.revision });
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  await card.getByRole("button", { name: "Keep draft as new knowledge", exact: true }).click();
  assert.equal(await card.getByLabel("Memory knowledge", { exact: true }).inputValue(), "Preserved draft after deletion");
  await card.getByRole("button", { name: "Save knowledge", exact: true }).click();
  card = page.locator(".memory-card");
  await card.getByRole("button", { name: "Edit", exact: true }).waitFor();
  const saved = await api<MemoryEntry[]>(endpoint);
  assert.equal(saved.length, 1);
  assert.notEqual(saved[0]!.id, entry.id);
  assert.equal(saved[0]!.body, "Preserved draft after deletion");
  assert.match(await page.locator(".project-memory").innerText(), /retain their own text and the source reference/);
});

test("memory analysis publishes canonical source revisions and deletion preview explains retained descendants", { timeout: 30_000 }, async () => {
  for (const existing of await api<MemoryEntry[]>(endpoint)) await api(endpoint + "/commands", { op: "delete", id: existing.id, expectedRevision: existing.revision });
  let source = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Setup database", body: "Configure bounded database connection retries with exponential backoff and jitter.", paths: ["README.md"] });
  const copy = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Setup duplicate", body: source.body, paths: source.paths });
  assert.deepEqual(copy.paths, source.paths);
  assert.deepEqual(copy.applicability, source.applicability);
  const initial = await api<MemoryAnalysis>(endpoint + "/analysis");
  source = await api<MemoryEntry>(endpoint + "/commands", { op: "update", id: source.id, expectedRevision: source.revision, title: "Setup database safely" });
  const stale = await fetch(base + endpoint + "/analysis/publish", { method: "POST", headers, body: JSON.stringify({ repo, expectedSources: initial.onboarding.sourceRefs }) });
  assert.equal(stale.status, 409, "a source edited after preview must be reviewed again");
  assert.equal((await api<MemoryEntry[]>(endpoint)).length, 2);
  await page.goto(base + "/memory-fixture");
  await page.getByText("Project memory", { exact: true }).click();
  await page.getByText("Advanced memory tools", { exact: true }).click();
  const panel = page.locator(".memory-analysis");
  await panel.getByText("Repeated wording · 1 pairs", { exact: true }).click();
  assert.match(await panel.innerText(), /Same text, ignoring whitespace/);
  await panel.getByText("Curated project onboarding", { exact: true }).click();
  const publish = panel.getByRole("button", { name: "Save onboarding as project knowledge", exact: true });
  const response = page.waitForResponse((response) => response.url().endsWith("/analysis/publish") && response.request().method() === "POST");
  await publish.click();
  assert.equal((await response).status(), 201);
  const saved = await api<MemoryEntry[]>(endpoint);
  const summary = saved.find((entry) => entry.tags.includes("onboarding-summary"))!;
  assert.ok(summary);
  assert.equal(summary.acceptedBy, "user");
  // Exact duplicates no longer enter curated guidance; provenance cites only the retained source.
  assert.deepEqual(summary.derivedFrom, [{ id: source.id, revision: source.revision }]);
  assert.match(summary.body, /Setup database safely/);
  assert.equal((await api<MemoryAnalysis>(endpoint + "/analysis")).onboarding.sourceRefs.length, 1, "published summary is not recursively summarized and exact text is included once");
  await panel.getByText("Source and derived-entry graph", { exact: true }).click();
  // Publication completes before the panel's asynchronous analysis refresh.
  // Inspect source edges only after the newly published node is rendered.
  await panel.getByRole("button", { name: new RegExp(`Revision ${summary.revision}.*${summary.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).waitFor();
  await panel.getByRole("button", { name: new RegExp(`^Setup database safely Revision ${source.revision}`) }).click();
  assert.match(await panel.getByRole("status").innerText(), /1 derived references/);
  const card = page.locator(`#memory-${source.id}`);
  await card.getByRole("button", { name: "Delete…", exact: true }).click();
  const impact = card.getByLabel("Memory deletion impact", { exact: true });
  await impact.getByText("1 directly derived entries; 1 downstream entries retain their text and provenance.", { exact: true }).waitFor();
  assert.match(await impact.innerText(), /Source run transcripts, provider conversations and backups have separate retention/);
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await card.waitFor({ state: "detached" });
  const remaining = await api<MemoryEntry[]>(endpoint);
  assert.equal(remaining.find((entry) => entry.id === summary.id)?.body, summary.body);
  assert.equal(remaining.some((entry) => entry.id === source.id), false);
});

test("memory semantic review compares overlapping policy and normalized settings with exact source evidence", { timeout: 30_000 }, async () => {
  for (const existing of await api<MemoryEntry[]>(endpoint)) await api(endpoint + "/commands", { op: "delete", id: existing.id, expectedRevision: existing.revision });
  const allow = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Guest requests permitted", body: "Always permit guest requests.", paths: ["README.md"] });
  const deny = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Guest requests forbidden", body: "Never allow guest requests.", paths: ["README.md"] });
  await api(endpoint + "/commands", { op: "create", repo, title: "Separate component policy", body: "Always allow guest requests.", paths: ["unrelated.ts"] });
  await api(endpoint + "/commands", { op: "create", repo, title: "Cache TTL minutes", body: "Set cache TTL to 5 minutes." });
  await api(endpoint + "/commands", { op: "create", repo, title: "Cache TTL explicit seconds", body: '```codeflow-claims\n[{"subject":"cache ttl","predicate":"setting","value":300,"unit":"seconds"}]\n```' });
  const report = await api<MemoryAnalysis>(endpoint + "/analysis"); assert.equal(report.claims.findings.filter((finding) => finding.kind === "contradiction").length, 1); assert.equal(report.claims.findings.filter((finding) => finding.kind === "equivalent").length, 1);
  const conflict = report.claims.findings.find((finding) => finding.kind === "contradiction")!; assert.deepEqual(new Set([conflict.a.id, conflict.b.id]), new Set([allow.id, deny.id]));
  await page.goto(base + "/memory-fixture"); await page.getByText("Project memory", { exact: true }).click(); await page.getByText("Advanced memory tools", { exact: true }).click(); const panel = page.locator(".memory-analysis");
  await panel.getByText("Semantic claim review · 1 conflicts · 1 equivalent pairs", { exact: true }).click(); const item = panel.getByRole("listitem").filter({ hasText: "Potential contradiction: allow · guest request" }); await item.getByText("Compare claim evidence", { exact: true }).click(); assert.match(await item.innerText(), /Always permit guest requests/); assert.match(await item.innerText(), /Never allow guest requests/);
  const target = item.getByRole("button", { name: "Guest requests permitted", exact: true }); await target.focus(); await page.keyboard.press("Enter"); assert.equal(await page.locator(`#memory-${allow.id}`).evaluate((element) => element === document.activeElement), true, "source navigation restores keyboard focus to the exact entry");
  await panel.getByText("Write explicit semantic facts", { exact: true }).click(); assert.match(await panel.innerText(), /codeflow-claims/); assert.match(await panel.innerText(), /unsupported prose/);
  const after = await api<MemoryEntry[]>(endpoint); assert.equal(after.length, 5); assert.equal(after.find((entry) => entry.id === allow.id)!.body, allow.body, "analysis and evidence navigation never merge or rewrite guidance");
});

test("knowledge graph filters connections, navigates to source memory and refreshes after deletion", { timeout: 30_000 }, async () => {
  const entry = await api<MemoryEntry>(endpoint + "/commands", { op: "create", repo, title: "Session contract", body: "Exercise the session contract", paths: ["src/session.ts"] });
  await page.goto(base + "/memory-fixture");
  await page.getByText("Project memory", { exact: true }).click();
  await page.getByText("Knowledge graph", { exact: true }).click();
  await page.addStyleTag({ content: await readFile(join(root, "ui/styles.css"), "utf8") });
  await page.setViewportSize({ width: 390, height: 844 });
  const connections = page.getByRole("region", { name: "Knowledge connections", exact: true });
  await connections.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the graph does not widen the page on a phone");
  assert.equal(await connections.evaluate((element) => element.scrollWidth > element.clientWidth), true, "the readable table scrolls within its own region");
  await page.getByLabel("Find knowledge connections").fill("src/session.ts");
  const row = page.getByRole("row").filter({ hasText: "src/session.ts" });
  await row.waitFor();
  assert.match(await row.innerText(), /applies to/);
  assert.match(await row.innerText(), /Revision 1 · Accepted/);
  await row.getByRole("link", { name: "Session contract", exact: true }).click();
  assert.equal(await page.locator(`#memory-${entry.id}`).evaluate((element) => element === document.activeElement), true);
  await api(endpoint + "/commands", { op: "delete", id: entry.id, expectedRevision: 1 });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("No matching connections.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("row").filter({ hasText: "src/session.ts" }).count(), 0);
});
