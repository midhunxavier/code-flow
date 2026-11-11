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



