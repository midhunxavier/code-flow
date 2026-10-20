import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as netServer, type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
const root = fileURLToPath(new URL("../..", import.meta.url));
let home: string,
  base: string,
  server: ChildProcess,
  browser: Browser,
  page: Page,
  staticServer: Server,
  staticBase: string;
const headers = {
  authorization: "Bearer docs-e2e",
  "content-type": "application/json",
};
const errors: string[] = [];
before(async () => {
  home = await mkdtemp(join(tmpdir(), "cf-docs-e2e-"));
  execFileSync(process.execPath, ["scripts/build-ui.mjs"], { cwd: root });
  const port = await new Promise<number>((resolve) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      CODEFLOW_HOME: home,
      CODEFLOW_TOKEN: "docs-e2e",
      PATH: `${join(root, "test/fake-bin")}:${process.env.PATH}`,
      FAKE_SLEEP_MS: "500",
    },
    stdio: "pipe",
  });
  let output = "";
  server.stdout?.on("data", (c) => (output += c));
  server.stderr?.on("data", (c) => (output += c));
  for (let n = 0; n < 150; n++) {
    if (
      await fetch(base + "/api/health", { headers }).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (n === 149 || server.exitCode !== null) throw Error(output);
    await new Promise((r) => setTimeout(r, 100));
  }
  staticServer = createServer(async (req, res) => {
    const name = (req.url || "").replace(/^\/project\//, "") || "index.html";
    if (!/^[a-z\d-]+\.(?:html|css|js|json)$/.test(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(join(root, "dist/docs", name));
      res.writeHead(200, {
        "content-type": name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : name.endsWith(".json")
              ? "application/json"
              : "text/html",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) =>
    staticServer.listen(0, "127.0.0.1", resolve),
  );
  staticBase = `http://127.0.0.1:${(staticServer.address() as AddressInfo).port}/project/`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
});
after(async () => {
  await browser?.close();
  staticServer?.closeAllConnections();
  await new Promise<void>((resolve) =>
    staticServer ? staticServer.close(() => resolve()) : resolve(),
  );
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (home) await rm(home, { recursive: true, force: true });
});

test("help requires owner authentication and same-origin requests; docs are readable without credentials", async () => {
  assert.equal((await fetch(base + "/docs/")).status, 200);
  assert.equal((await fetch(base + "/api/docs-help")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/docs-help", {
        method: "POST",
        headers: { ...headers, origin: "https://untrusted.example" },
        body: JSON.stringify({ agent: "claude", question: "Hello" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/docs-help", {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: "acp:kilo", question: "Hello" }),
      })
    ).status,
    400,
  );
  assert.equal((await fetch(base + "/docs/no-such-file.html")).status, 404);
});
test("local docs search, CLI answers, follow-ups and cancellation work", async () => {
  await page.goto(base + "/?token=docs-e2e");
  await page.goto(base + "/docs/");
  await page.getByRole("button", { name: /Search documentation/ }).click();
  await page.getByRole("searchbox").fill("SSH projects");
  await page
    .locator("#search-results")
    .getByRole("link", { name: "SSH projects", exact: false })
    .first()
    .click();
  await page.waitForURL("**/ssh-projects.html");
  await page
    .getByRole("button", { name: "Ask code-flow", exact: true })
    .click();
  await page.getByLabel("Use your CLI").selectOption("claude");
  await page.getByLabel("Your question").fill("How do I start?");
  await page.getByRole("button", { name: "Send ↗" }).click();
  await page.locator("#help-messages .answer").waitFor();
  assert.match(
    await page.locator("#help-messages .answer").innerText(),
    /Start run/,
  );
  assert.ok(await page.locator("#help-messages .sources a").count());
  await page.getByLabel("Your question").fill("And what next?");
  await page.getByRole("button", { name: "Send ↗" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByText("Stopped. You can ask again.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close help" }).click();
  assert.equal(await page.locator("dialog[open]").count(), 0);
});
test("static project subpaths work without API calls, with keyboard search and local-help explanation", async () => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(staticBase);
  await page
    .getByRole("button", { name: "Ask code-flow", exact: true })
    .click();
  await page
    .getByText(/The assistant runs in your local code-flow app/)
    .waitFor();
  assert.equal(await page.locator("#help-form:visible").count(), 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByRole("searchbox").fill("verification");
  await page.locator("#search-results a").first().click();
  assert.ok(page.url().startsWith(staticBase));
  assert.ok(!requests.some((url) => url.includes("/api/")));
});
test("desktop and mobile documentation pass accessibility checks in both themes", async () => {
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(staticBase);
      await page.evaluate(
        (theme) => localStorage.setItem("theme", theme),
        theme,
      );
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      if (width === 390) {
        await page
          .getByRole("button", { name: "Toggle documentation navigation" })
          .click();
        await page
          .getByRole("navigation", { name: "Documentation", exact: true })
          .getByRole("link", { name: "Getting started", exact: true })
          .click();
        await page.waitForURL("**/getting-started.html");
      }
      await page.addScriptTag({ content: axe.source });
      const result = await page.evaluate(
        async () =>
          await (window as any).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
      );
      assert.deepEqual(
        result.violations.map((v: any) => ({
          id: v.id,
          nodes: v.nodes.map((n: any) => n.target),
        })),
        [],
      );
    }
  assert.deepEqual(errors, []);
});
