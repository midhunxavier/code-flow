import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const arch = process.env.CODEFLOW_MACOS_ARCH ?? process.arch;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const value = s.address().port; s.close(() => resolve(value)); }); });

for (const signal of ["SIGTERM", "SIGKILL"]) test(`native macOS supervisor starts its bundled runtime and leaves no server after ${signal}`, { skip: process.platform !== "darwin" || arch !== process.arch, timeout: 60_000 }, async () => {
  const contents = join(root, `output/macos/${arch}/Code Flow.app/Contents`);
  const executable = join(contents, "MacOS/CodeFlow");
  await access(executable);
  execFileSync("codesign", ["--verify", "--deep", "--strict", join(contents, "..")]);
  assert.match(execFileSync(join(contents, "Resources/node/bin/node"), ["--version"], { encoding: "utf8" }), /^v22\./);
  const directory = await mkdtemp(join(tmpdir(), "codeflow-macos-"));
  const home = join(directory, "state");
  const opened = join(directory, "opened.json");
  const fake = join(directory, "bin");
  await mkdir(fake);
  const opener = join(fake, "open");
  await writeFile(opener, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)));\n`);
  await chmod(opener, 0o755);
  const login = join(fake, "login-shell");
  await writeFile(login, '#!/bin/sh\nprintf "\\nCODEFLOW_PATH=%s\\n" "$PATH"\n', { mode: 0o755 });
  const localPort = await port();
  const remotePort = await port();
  let child;
  let backendPid;
  let watchdog;
  try {
    child = spawn(executable, [], { cwd: directory, env: { ...process.env, PORT: String(localPort), CODEFLOW_REMOTE_PORT: String(remotePort), CODEFLOW_HOME: home, SHELL: login, PATH: `${fake}:${join(root, "test/fake-bin")}:${process.env.PATH}`, CODEFLOW_TOKEN: "macos-smoke-owner" }, stdio: ["ignore", "pipe", "pipe"] });
    watchdog = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let output = "";
    child.stdout.on("data", (data) => output += data);
    child.stderr.on("data", (data) => output += data);
    const exited = once(child, "exit");
    let url;
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) assert.fail(`Native app exited before opening the browser: ${output}`);
      try { [url] = JSON.parse(await readFile(opened, "utf8")); break; } catch {}
      await pause(100);
    }
    assert.equal(url, `http://localhost:${localPort}/?token=macos-smoke-owner`, output);
    const response = await fetch(`http://localhost:${localPort}/api/health`, { headers: { authorization: "Bearer macos-smoke-owner" } });
    assert.equal(response.status, 200);
    backendPid = JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid;
    child.kill(signal);
    const [code, exitedSignal] = await exited;
    if (signal === "SIGTERM") assert.equal(code, 0, output);
    else assert.equal(exitedSignal, "SIGKILL", output);
    for (let i = 0; i < 100; i++) {
      try { process.kill(backendPid, 0); } catch { break; }
      await pause(100);
    }
    assert.throws(() => process.kill(backendPid, 0), /ESRCH/);
    await assert.rejects(access(join(home, "server.lock")));
    backendPid = undefined;
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
    if (backendPid) { try { process.kill(backendPid, "SIGTERM"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});
