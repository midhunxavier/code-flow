// Capture the actual application with disposable data and fake CLIs only.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { buildDocs } from "./build-docs.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "codeflow-docs-demo-")),
);
const repo = join(directory, "example-app");
let server, browser;
try {
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(
    join(repo, "README.md"),
    "# Example app\n\nA small demonstration repository for Code Flow documentation.\n",
  );
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "example-app", scripts: { test: "node --test" } }),
  );
  await writeFile(
    join(repo, "search.test.mjs"),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('search handles an empty query',()=>assert.deepEqual(''.split(' ').filter(Boolean),[]));\n",
  );
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Docs demo",
      "-c",
      "user.email=demo@example.invalid",
      "commit",
      "-qm",
      "Initial example",
    ],
    { cwd: repo },
  );
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`,
    token = "docs-screenshot-fixture";
  const env = {
    ...process.env,
    PORT: String(port),
    CODEFLOW_HOME: join(directory, "home"),
    CODEFLOW_TOKEN: token,
    CODEFLOW_CODEX_TRANSPORT: "exec",
    PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
  };
  const binaries = execFileSync("which", ["claude", "codex", "agy"], {
    env,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  if (binaries.some((path) => !path.startsWith(join(root, "test/fake-bin/"))))
    throw Error("Refusing screenshots without fake agents");
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env,
    stdio: "pipe",
  });
  let output = "";
  server.stdout.on("data", (c) => (output += c));
  server.stderr.on("data", (c) => (output += c));
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      headers,
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  };
  for (let n = 0; n < 150; n++) {
    if (
      await api("/api/health").then(
        () => true,
        () => false,
      )
    )
      break;
    if (n === 149 || server.exitCode !== null) throw Error(output);
    await new Promise((r) => setTimeout(r, 100));
  }
  const task = "Add an empty search state with a clear-filters action.";
  const started = await api("/api/runs", {
    repo,
    task,
    pattern: "pipeline",
    roles: { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] },
    loop: {
      check: "npm test",
      prove: false,
      planApproval: false,
      maxSteps: 12,
      maxMinutes: 2,
    },
  });
  let run;
  for (let n = 0; n < 200; n++) {
    run = await api(`/api/runs/${started.id}`);
    if (run.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (run.status !== "done")
    throw Error(`Demo run did not complete: ${run.status} ${run.error || ""}`);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(
    ({ repo, task }) => {
      localStorage.setItem("repo", repo);
      localStorage.setItem("sideOpen", "0");
      localStorage.setItem("pattern", "pipeline");
      localStorage.setItem("task", task);
    },
    { repo, task },
  );
  await page.goto(`${base}/?token=${token}`);
  await mkdir(join(root, "docs/images"), { recursive: true });
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(root, "docs/images", name + ".png"),
      animations: "disabled",
    });
  };
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => localStorage.setItem("theme", theme), theme);
    await page.goto(base + "/#/");
    await page.reload();
    await page.locator(".taskbox textarea").fill(task);
    await page.locator(".composer-summary").waitFor();
    await page
      .getByText(/Loading repository configuration/)
      .waitFor({ state: "hidden" });
    await page.locator(".task-start:not([disabled])").waitFor();
    await capture(`composer-${theme}`);
    await page.goto(base + `/#/run/${run.id}`);
    await page.getByRole("region", { name: "Next action" }).waitFor();
    await page.getByText(/Loading commit/).waitFor({ state: "hidden" });
    await capture(`run-${theme}`);
    // The work disclosure is a real UI control; capture its expanded evidence.
    const work = page.locator("details.work");
    if ((await work.getAttribute("open")) === null)
      await work.locator(":scope > summary").click();
    await work
      .getByRole("button", { name: /^Implement plan:/ })
      .first()
      .click();
    await page.locator(".transcript").waitFor();
    await page
      .getByText("Loading transcript…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.locator(".transcript").scrollIntoViewIfNeeded();
    await capture(`transcript-${theme}`);
  }
  await buildDocs();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => localStorage.setItem("theme", theme), theme);
    await page.goto(base + "/docs/");
    await page
      .getByRole("heading", { name: "Your agents. A clear path forward." })
      .waitFor();
    await capture(`docs-${theme}`);
  }
  console.log(
    "Captured composer, run, transcript and documentation in docs/images (demo data).",
  );
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
