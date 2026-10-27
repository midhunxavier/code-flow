import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
const root = fileURLToPath(new URL("../..", import.meta.url)), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const executable = join(root, `output/macos/${process.arch}/Code Flow.app/Contents/MacOS/Code Flow`);
for (const mode of ["dialog", "manual", "idle"] as const) test(`packaged desktop ${mode} quit exits and relaunch starts a healthy backend`, { skip: process.platform !== "darwin" || process.env.CODEFLOW_QA_DESKTOP !== "1", timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-clients-desktop-")), home = join(dir, "state");
  const env = { ...process.env, CODEFLOW_DESKTOP_TEST: "1", CODEFLOW_HOME: home, CODEFLOW_DESKTOP_DATA: join(dir, "ui"), CODEFLOW_TOKEN: "qa-clients-desktop", PATH: `${root}/test/fake-bin:${process.env.PATH}` };
  const children: ReturnType<Awaited<ReturnType<typeof electron.launch>>["process"]>[] = []; let backendPid: number | undefined;
  try {
    const app = await electron.launch({ executablePath: executable, args: ["--disable-gpu", "--use-mock-keychain"], env, timeout: 30_000 }); const processHandle = app.process(); children.push(processHandle);
    const page = await app.firstWindow(); await page.getByRole("main").waitFor({ timeout: 30_000 });
    assert.ok(!["4317", "4318"].includes(new URL(page.url()).port));
    backendPid = JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid;
    await app.evaluate(({ dialog, app }, mode) => {
      (globalThis as any).qaDialogs = [];
      dialog.showMessageBox = async (...args: any[]) => { const options = args.at(-1); (globalThis as any).qaDialogs.push(options); if (mode === "manual") await new Promise(r => setTimeout(r, 5000)); else await new Promise(r => setTimeout(r, 300)); return { response: 0, checkboxChecked: false }; };
      if (mode === "idle") setTimeout(() => app.quit(), 100);
    }, mode);
    if (mode !== "idle") {
      process.kill(backendPid!, "SIGKILL");
      let detail = "";
      for (let i = 0; i < 100 && !detail; i++) { detail = await app.evaluate(() => (globalThis as any).qaDialogs[0]?.detail || ""); if (!detail) await pause(20); }
      assert.match(detail, /stopped by SIGKILL/); assert.doesNotMatch(detail, /ExperimentalWarning|code-flow running|qa-clients-desktop/);
      if (process.env.CODEFLOW_QA_EVIDENCE_DIR) await writeFile(join(process.env.CODEFLOW_QA_EVIDENCE_DIR, `desktop-${mode}-dialog.txt`), detail);
      if (mode === "manual") await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    }
    for (let i = 0; i < 150 && processHandle.exitCode === null && processHandle.signalCode === null; i++) await pause(50);
    assert.equal(processHandle.exitCode, 0, "Quit must exit instead of leaving a windowless Electron process"); backendPid = undefined;
    const again = await electron.launch({ executablePath: executable, args: ["--disable-gpu", "--use-mock-keychain"], env, timeout: 30_000 }); children.push(again.process());
    const next = await again.firstWindow(); await next.getByRole("main").waitFor({ timeout: 30_000 });
    backendPid = JSON.parse(await readFile(join(home, "server.lock"), "utf8")).pid;
    assert.equal((await fetch(new URL("/api/health", next.url()), { headers: { authorization: "Bearer qa-clients-desktop" } })).status, 200);
    await again.close(); backendPid = undefined;
  } finally {
    for (const p of children) { if (p.exitCode === null && p.signalCode === null) { p.kill("SIGTERM"); await pause(500); if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); } }
    if (backendPid) try { process.kill(backendPid, "SIGTERM"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
