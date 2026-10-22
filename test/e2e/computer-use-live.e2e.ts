import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));

test("native macOS computer tools click, type and finish an isolated full-display fixture", { skip: process.platform !== "darwin" || process.env.CODEFLOW_TEST_NATIVE_COMPUTER !== "1", timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-computer-e2e-"));
  process.env.CODEFLOW_HOME = join(directory, "state");
  const app = join(directory, "Codeflow Computer Fixture.app", "Contents"); await mkdir(join(app, "MacOS"), { recursive: true });
  await writeFile(join(app, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Codeflow Computer Fixture</string><key>CFBundleIdentifier</key><string>dev.codeflow.computer-fixture</string><key>CFBundleExecutable</key><string>CodeflowComputerFixture</string></dict></plist>');
  const binary = join(app, "MacOS", "CodeflowComputerFixture");
  execFileSync("/usr/bin/swiftc", [join(root, "test/fixtures/computer-use.swift"), "-o", binary], { timeout: 60000 });
  const result = join(directory, "result.txt"), child = spawn(binary, [result], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = await new Promise<any>((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("Native fixture did not become ready")), 10000);
    child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
    child.once("error", reject);
  });
  const { AgentComputer } = await import("../../src/agent-computer.js");
  const computer = new AgentComputer(), controller = new AbortController();
  const capture = async () => {
    const response = await computer.call("computer_screenshot", { app: ready.app }, controller.signal);
    return { metadata: JSON.parse(response.content[0].text), image: response.content[1].data };
  };
  try {
    const first = await capture();
    assert.equal(first.metadata.app, ready.app);
    await computer.call("computer_action", { action: "click", screenshot: first.metadata.screenshot, x: first.metadata.width * 140 / ready.width, y: first.metadata.height * 200 / ready.height }, controller.signal);
    const focused = await capture();
    await computer.call("computer_action", { action: "type", screenshot: focused.metadata.screenshot, text: "codeflow-native-ok" }, controller.signal);
    const typed = await capture();
    await mkdir(join(root, "output/playwright"), { recursive: true });
    await writeFile(join(root, "output/playwright/computer-fixture.png"), Buffer.from(typed.image, "base64"));
    await computer.call("computer_action", { action: "click", screenshot: typed.metadata.screenshot, x: typed.metadata.width * 600 / ready.width, y: typed.metadata.height * 200 / ready.height }, controller.signal);
    let value = ""; for (let n=0;n<50;n++) { value = await readFile(result,"utf8").catch(()=>""); if (value) break; await new Promise(resolve=>setTimeout(resolve,100)); }
    assert.equal(value, "codeflow-native-ok", await readFile(result + ".events", "utf8").catch(() => "No keyboard events received by fixture"));
  } finally { controller.abort(); child.kill("SIGTERM"); }
});
