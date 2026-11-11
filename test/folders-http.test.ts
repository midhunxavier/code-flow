import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "codeflow-folders-http-home-"));
const token = "folders-http-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let child: ChildProcess, base: string, folder: string;

async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}

before(async () => {
  folder = join(realpathSync(mkdtempSync(join(tmpdir(), "codeflow-folders-http-"))), "Report");
  mkdirSync(folder);
  writeFileSync(join(folder, "draft.md"), "# Draft\n");
  const port = await new Promise<number>((resolve) => { const probe = createServer().listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => resolve(port)); }); });
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: root, env: { ...process.env, PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`, PORT: String(port), CODEFLOW_TOKEN: token, CODEFLOW_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout?.on("data", (d) => { output += d; }); child.stderr?.on("data", (d) => { output += d; });
  for (let i = 0; i < 150; i++) { if (await fetch(base + "/api/health", { headers }).then((r) => r.ok, () => false)) break; if (i === 149 || child.exitCode !== null) throw new Error(`Server did not start:\n${output}`); await new Promise((r) => setTimeout(r, 100)); }
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
});

test("a run started on a plain folder works on its mirror and lands in a project named after the folder", async () => {
  const roles = { planner: ["claude"], builder: ["codex"], reviewer: ["claude"] };
  const started = await api("/api/runs", { repo: folder, pattern: "pipeline", task: "Summarise the draft", roles, options: {} });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  let run = (await api(`/api/runs/${started.body.id}`)).body;
  const mirror = run.repo as string;
  assert.match(mirror, /[\\/]folders[\\/]f-[0-9a-f]{16}[\\/]source$/);
  assert.ok(realpathSync(mirror).startsWith(realpathSync(home)), "the mirror is in Code Flow's own data");
  assert.equal(existsSync(join(folder, ".git")), false, "the folder gets no .git");
  for (let i = 0; i < 200 && run.status === "running"; i++) { await new Promise((r) => setTimeout(r, 50)); run = (await api(`/api/runs/${started.body.id}`)).body; }
  const projects = (await api("/api/projects")).body as { id: string; name: string; repos: string[]; folders?: { mirror: string; path: string }[] }[];
  const project = projects.find((p) => p.id === started.body.project);
  assert.ok(project?.repos.includes(mirror));
  assert.equal(project?.name, "Report");
  assert.deepEqual(project?.folders, [{ mirror, path: folder }]);
  // Refusals come back as client errors that say why.
  const broad = await api("/api/runs", { repo: "/", pattern: "pipeline", task: "x", roles, options: {} });
  assert.equal(broad.status, 400);
  assert.match(broad.body.error, /too broad/);
  const created = await api("/api/projects", { name: "Notes", repos: [join(folder)] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.repos, [mirror], "a folder that already has a mirror joins as that mirror");
});
