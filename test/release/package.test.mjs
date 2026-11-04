import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test("packaging excludes in-progress UI and documentation rebuild files", { timeout: 120_000 }, async () => {
  const paths = ["public/index.release-qa.tmp", "public/assets/main-release-qa.js.tmp", "public/docs/installation.html.release-qa.tmp"];
  try {
    for (const path of paths) await writeFile(join(root, path), "incomplete rebuild output");
    execFileSync(process.execPath, ["scripts/package-npm.mjs"], { cwd: root, stdio: "pipe" });
    for (const path of paths) await assert.rejects(access(join(root, "dist/npm", path)), { code: "ENOENT" });
  } finally {
    await Promise.all(paths.map(path => rm(join(root, path), { force: true })));
  }
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
    assert.ok(packed.files.some((file) => file.path === "dist/training-worker.json"));
    assert.ok(!packed.files.some((file) => /(?:node_modules\/|test\/|\.ts$|\.env$|\.tmp$)/.test(file.path)));
    execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
    const installed = join(install, "node_modules", pkg.name);
    const trainingBundle = execFileSync(process.execPath, ["--input-type=module", "-e", "const {loadBundle}=await import(process.argv[1]);const bundle=await loadBundle();console.log(JSON.stringify(Object.keys(bundle.files)))", pathToFileURL(join(installed, "src/ml/transport.js")).href], { cwd: directory, encoding: "utf8" });
    assert.ok(JSON.parse(trainingBundle).includes("holdout.py"), "installed ML runtime loads its verified worker and recipe bundle outside the checkout");
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

test("packed conversational teams install, bootstrap one owner, execute through MCP and return the actual plan", { timeout: 120_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codeflow-package-cli-"))), repo = join(directory, "repo"), home = join(directory, "state"), install = join(directory, "install");
  let child, ownerPid;
  try {
    await mkdir(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "Fixture login project\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"], { cwd: repo });
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "./dist/npm", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root, encoding: "utf8" }));
    assert.ok(packed.files.some(f => f.path === "integrations/cli-teams/SKILL.md"));
    execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, packed.filename)], { cwd: directory, stdio: "pipe" });
    const bin = join(install, "node_modules/.bin/codeflow");
    const env = { ...process.env, HOME: directory, CODEX_HOME: join(directory, ".codex"), CODEFLOW_HOME: home, PATH: [join(install, "node_modules/.bin"), join(root, "test/fake-bin"), process.env.PATH].join(delimiter) };
    const initialized = JSON.parse(execFileSync(bin, ["init", "--providers", "claude,codex", "--json"], { cwd: repo, env, encoding: "utf8" }));
    assert.ok(initialized.changes.some(c => c.path === ".agents/skills/codeflow/SKILL.md"));
    const humanSetup = execFileSync(bin, ["init", "--providers", "claude,codex"], { cwd: repo, env, encoding: "utf8" });
    assert.match(humanSetup, /No configuration changes needed/);
    assert.doesNotMatch(humanSetup, /mcpServers|## Prepare/);
    const diagnosis = JSON.parse(execFileSync(bin, ["doctor", "--catalog", "--json"], { cwd: repo, env, encoding: "utf8" }));
    assert.ok(diagnosis.providers.every(p => p.catalog?.state === "available"));
    assert.ok(diagnosis.providers.every(p => /Not verified/.test(p.authentication)));
    assert.equal(JSON.parse(execFileSync(bin, ["init", "--providers", "claude,codex", "--json"], { cwd: repo, env, encoding: "utf8" })).changes.length, 0);
    assert.throws(() => execFileSync(bin, ["approve", "fixture", "--revision", "1"], { cwd: repo, env, stdio: "pipe" }), /interactive terminal/);
    const managed = JSON.parse(execFileSync(bin, ["updates", "enable", "--json"], { cwd: repo, env, encoding: "utf8" }));
    execFileSync(bin, ["updates", "disable"], { cwd: repo, env, stdio: "pipe" }); // Fixture tests never poll the real registry.
    execFileSync(bin, ["init", "--providers", "claude,codex"], { cwd: repo, env, stdio: "pipe" });
    const projectMcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8")).mcpServers.codeflow;
    assert.equal(projectMcp.args[0], join(home, "integration-runtime", "launcher.mjs"));
    assert.match(await readFile(join(repo, ".codex/config.toml"), "utf8"), /integration-runtime/);
    const desktopHosts = process.platform === "darwin" ? "claude-desktop,codex-app" : "codex-app";
    const desktopArgs = ["--hosts", desktopHosts, "--project-root", repo, "--json"];
    const desktopSetup = JSON.parse(execFileSync(bin, ["desktop", "setup", ...desktopArgs], { cwd: directory, env, encoding: "utf8" }));
    assert.equal(desktopSetup.changes.length, desktopHosts.split(",").length);
    const desktopStatus = JSON.parse(execFileSync(bin, ["desktop", "doctor", ...desktopArgs], { cwd: directory, env, encoding: "utf8" }));
    assert.ok(desktopStatus.connections.every(c => c.state === "configured"));
    const desktopCommand = desktopStatus.connections.find(c => c.host === "codex-app").command;
    child = spawn(desktopCommand.command, desktopCommand.args, { cwd: directory, env: { ...env, ...desktopCommand.env }, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map(), approvals = []; let next = 0, buffered = "", stderr = "";
    child.stderr.on("data", c => stderr += c);
    child.stdout.on("data", chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { assert.fail(`MCP stdout contains a non-JSON message`); }
        if (message.method === "elicitation/create") {
          // The fixture native host supplies a human form response, not a tool argument.
          approvals.push(message.params);
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { approve: true } } }) + "\n"); continue;
        }
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out; ${stderr.slice(-1000)}`)); }, 35000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const call = async (name, args = {}) => {
      const result = await rpc("tools/call", { name: `codeflow_${name}`, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent.data;
    };
    assert.equal((await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "package-test", version: "1" } })).serverInfo.name, "code-flow");
    assert.equal((await rpc("tools/list", {})).tools.length, 12);
    ownerPid = JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid;
    const candidate = { scope: "plan", participants: [{ id: "author", provider: "claude" }, { id: "reviewer", provider: "codex" }], completion: ["The plan has independent review"], steps: [
      { id: "draft", type: "task", operation: "propose", participant: "author", instructions: "Draft the login plan" },
      { id: "review", type: "task", operation: "review_plan", participant: "reviewer", instructions: "Review the plan", inputs: ["draft"] },
      { id: "gate", type: "gate", policy: "agreement", target: "draft", reviews: ["review"] },
      { id: "result", type: "finish", outcome: "agreed_plan", inputs: ["draft", "gate"] },
    ] };
    const proposal = await call("propose_run", { operationId: "package-propose", task: "CODEFLOW_CONVERSATIONAL_TEST: plan a login form", candidate });
    assert.equal(proposal.approvalMethod, "native_form");
    const { runId } = await call("start_run", { operationId: "package-start", proposalId: proposal.proposalId, expectedRevision: proposal.revision, proposalHash: proposal.proposalHash });
    const nextInstall = join(directory, "next-release");
    await cp(join(install, "node_modules", "@midhunxavier/code-flow"), nextInstall, { recursive: true });
    const nextPackage = JSON.parse(await readFile(join(nextInstall, "package.json"), "utf8")); nextPackage.version = "0.1.0-preview.9999";
    await writeFile(join(nextInstall, "package.json"), JSON.stringify(nextPackage));
    execFileSync(process.execPath, [join(nextInstall, "bin/codeflow.mjs"), "updates", "enable", "--json"], { cwd: repo, env, stdio: "pipe" });
    execFileSync(bin, ["updates", "disable"], { cwd: repo, env, stdio: "pipe" });
    assert.equal(JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid, ownerPid, "staging never restarts the live owner");
    assert.equal(approvals.length, 1); assert.match(approvals[0].message, new RegExp(proposal.proposalHash));
    let run, cursor = 0;
    for (let i = 0; i < 20; i++) {
      run = await call("get_run", { runId, afterCursor: cursor, waitMs: 1000 }); cursor = run.afterCursor;
      if (run.status !== "running") break;
    }
    assert.equal(run.status, "done", JSON.stringify(run));
    const artifact = run.artifacts.find(a => a.kind === "result"); assert.ok(artifact);
    const result = await call("get_artifact", { runId, artifactId: artifact.id, sha256: artifact.sha256 }); assert.match(result.body, /Fixture login plan/);
    const status = JSON.parse(execFileSync(bin, ["status", runId, "--json"], { cwd: repo, env, encoding: "utf8" })); assert.equal(status.outcome, "agreed_plan");
    assert.match(execFileSync(bin, ["status", runId], { cwd: repo, env, encoding: "utf8" }), /Plan agreed/);
    assert.equal(status.host.attachCommand, undefined);
    const recent = JSON.parse(execFileSync(bin, ["status", "--json"], { cwd: repo, env, encoding: "utf8" }));
    assert.ok(recent.runs.some(r => r.runId === runId));
    assert.equal(JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid, ownerPid, "the terminal client reuses the same owner");
    const bridgeExited = once(child, "exit"); child.stdin.end(); await bridgeExited;
    let replacement;
    for (let i = 0; i < 500; i++) {
      replacement = await readFile(join(home, "cli-teams-runtime.json"), "utf8").then(JSON.parse, () => undefined);
      if (replacement?.pid !== ownerPid && replacement?.releaseRoot?.includes("preview.9999")) break;
      await pause(100);
    }
    assert.ok(replacement?.releaseRoot?.includes("preview.9999"), "idle managed owner automatically hands over after the final MCP session closes");
    assert.notEqual(replacement.pid, ownerPid); ownerPid = replacement.pid;
    const afterUpdate = JSON.parse(execFileSync(bin, ["status", runId, "--json"], { cwd: repo, env, encoding: "utf8" }));
    assert.equal(afterUpdate.outcome, "agreed_plan"); assert.equal(afterUpdate.status, "done");
    const desktopRemoved = JSON.parse(execFileSync(bin, ["desktop", "remove", ...desktopArgs], { cwd: directory, env, encoding: "utf8" }));
    assert.equal(desktopRemoved.changes.length, desktopHosts.split(",").length);
    execFileSync(bin, ["uninstall", "--project"], { cwd: repo, env, stdio: "pipe" });
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "Fixture login project\n");
    await access(join(home, "runs", `${runId}.journal.jsonl`)); await access(join(repo, ".codeflow/cli-teams.json"));
  } finally {
    if (child && child.exitCode === null) { const done = once(child, "exit"); child.stdin.end(); const exited = await Promise.race([done.then(() => true), pause(5000).then(() => false)]); if (!exited) { child.kill("SIGTERM"); await done; } }
    if (!ownerPid) ownerPid = await readFile(join(home, "server.lock"), "utf8").then(t => JSON.parse(t).pid, () => undefined);
    if (ownerPid) { try { process.kill(ownerPid, "SIGTERM"); } catch {} for (let i = 0; i < 100; i++) { try { process.kill(ownerPid, 0); } catch { break; } await pause(50); } }
    await rm(directory, { recursive: true, force: true });
  }
});
