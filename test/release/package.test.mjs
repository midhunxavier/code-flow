import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test("the packed npm install runs outside the checkout, opens its authenticated UI and shuts down cleanly", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-package-"));
  const install = join(directory, "install");
  const home = join(directory, "state");
  const fake = join(directory, "bin");
  let child;
  try {
    const pkg = JSON.parse(await readFile(join(root, "dist/npm/package.json"), "utf8"));
    assert.equal(pkg.dependencies, undefined, "runtime must not need a dependency install");
    assert.equal(pkg.scripts, undefined, "install must not build or run scripts");
    assert.match(pkg.version, /-preview\./);
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "./dist/npm", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }));
    assert.ok(packed.files.some((file) => file.path === "src/ssh-projects/bootstrap.mjs"));
    assert.ok(packed.files.some((file) => file.path === "src/code-intelligence-worker.mjs"));
    assert.ok(packed.files.some((file) => file.path === "dist/remote-host.json"));
    assert.ok(!packed.files.some((file) => /(?:node_modules\/|test\/|\.ts$|\.env$)/.test(file.path)));
    execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
    const installed = join(install, "node_modules", pkg.name);
    const bin = join(install, "node_modules/.bin/codeflow");
    assert.equal(execFileSync(bin, ["--version"], { cwd: directory, encoding: "utf8" }).trim(), pkg.version);
    assert.match(execFileSync(bin, ["--help"], { cwd: directory, encoding: "utf8" }), /--no-open/);
    assert.match(execFileSync(bin, ["client", "--help"], { cwd: directory, encoding: "utf8" }), /codeflow client status/);
    await mkdir(fake);
    // Exercise the real platform opener without changing the user's browser session.
    const opened = join(directory, "opened.json");
    const opener = join(fake, process.platform === "darwin" ? "open" : "xdg-open");
    await writeFile(opener, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(opener, 0o755);
    const port = await freePort();
    const remote = await freePort();
    const env = { ...process.env, PORT: String(port), CODEFLOW_REMOTE_PORT: String(remote), CODEFLOW_HOME: home, PATH: [fake, join(root, "test/fake-bin"), process.env.PATH].join(delimiter), CODEFLOW_TOKEN: "package-test-owner" };
    child = spawn(bin, [], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    const exited = once(child, "exit");
    let url;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) assert.fail(`Packaged server exited: ${output}`);
      try { [url] = JSON.parse(await readFile(opened, "utf8")); break; } catch {}
      await pause(100);
    }
    assert.equal(url, `http://localhost:${port}/?token=package-test-owner`, output);
    const signIn = await fetch(url, { redirect: "manual" });
    assert.equal(signIn.status, 302);
    const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const page = await fetch(new URL("/", url), { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<html/);
    const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset, url))).status, 200);
    const headers = { authorization: "Bearer package-test-owner" };
    const docs = await fetch(new URL("/docs/installation.html", url));
    assert.equal(docs.status, 200);
    const health = await fetch(new URL("/api/health", url), { headers });
    assert.equal(health.status, 200);
    const backendPid = JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid;
    // Runtime code with bare dependencies must also resolve outside the source tree.
    const repo = join(directory, "repo");
    await mkdir(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "example.ts"), "export function previewSymbol() { return 42; }\npreviewSymbol();\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Package Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: repo });
    const semantic = await fetch(new URL(`/api/workspace/search?repo=${encodeURIComponent(repo)}&q=previewSymbol&mode=semantic`, url), { headers });
    assert.equal(semantic.status, 200);
    assert.match(await semantic.text(), /previewSymbol/);
    const architecture = await fetch(new URL(`/api/workspace/dependencies?repo=${encodeURIComponent(repo)}`, url), { headers });
    assert.equal(architecture.status, 200);
    assert.match(await architecture.text(), /example\.ts/);
    for (const helper of ["src/ssh-projects/team-autostart.mjs", "src/ssh-projects/team-status.mjs", "src/ssh-projects/team-remove.mjs", "src/team-tool-client.mjs", "src/agent-tool-client.mjs", "scripts/computer-use.swift", "scripts/pty.py"]) await access(join(installed, helper));
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.throws(() => process.kill(backendPid, 0), /ESRCH/);
    await assert.rejects(access(join(home, "server.lock")));
    child = undefined;
    // Headless mode starts the same app without invoking the browser opener.
    await rm(opened);
    child = spawn(bin, ["--no-open"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    const headlessExit = once(child, "exit");
    for (let i = 0; i < 200 && !output.includes("  Open http"); i++) {
      if (child.exitCode !== null) assert.fail(output);
      await pause(100);
    }
    assert.match(output, /  Open http/);
    await assert.rejects(access(opened));
    child.kill("SIGINT");
    assert.equal((await headlessExit)[0], 0, output);
    child = undefined;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
    await rm(directory, { recursive: true, force: true });
  }
});
