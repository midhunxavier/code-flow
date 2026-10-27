import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const source = await readFile(new URL("../integrations/desktop/main.cjs", import.meta.url), "utf8");
const turn = () => new Promise(resolve => setImmediate(resolve));
async function desktop(t: any, delayedDialog = false) {
  const home = await mkdtemp(join(tmpdir(), "codeflow-desktop-qa-")); t.after(() => rm(home, { recursive: true, force: true }));
  const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.connected = true; child.disconnect = () => queueMicrotask(() => child.emit("exit", 0));
  let isQuitting = false, willQuit = 0, resolveDialog!: () => void, windows = 0;
  const dialogs: any[] = [], app: any = new EventEmitter(); Object.assign(app, { setName() {}, setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit() { if (isQuitting) return; let prevented = false; app.emit("before-quit", { preventDefault() { prevented = true; } }); isQuitting = !prevented; if (isQuitting) setImmediate(() => { if (isQuitting && !willQuit) { willQuit++; app.emit("will-quit"); } }); } });
  const electron = { app, BrowserWindow: class { constructor() { windows++; throw new Error("Unexpected dead-backend window"); } }, dialog: { showMessageBox: async (_w: unknown, options: unknown) => { dialogs.push(options); if (delayedDialog) await new Promise<void>(resolve => resolveDialog = resolve); return { response: 0 }; } } };
  const context = vm.createContext({ require: (name: string) => name === "electron" ? electron : name === "./updates.cjs" ? require("../integrations/desktop/updates.cjs") : name === "node:child_process" ? { fork: () => { setImmediate(() => { child.stderr.emit("data", "ExperimentalWarning: SQLite startup\n"); child.stdout.emit("data", "startup token=secret-token\n"); child.emit("message", { type: "codeflow-ready", url: "http://localhost:4467/?token=secret-token" }); }); return child; } } : require(name), __dirname: home, process: { env: { CODEFLOW_HOME: home, CODEFLOW_DESKTOP_TEST: "1", CODEFLOW_TOKEN: "secret-token", PORT: "4467", PATH: process.env.PATH }, platform: "darwin", on() {} }, fetch: async () => ({ ok: true, json: async () => [] }), URL, AbortSignal, setTimeout, clearTimeout, setImmediate });
  vm.runInContext(source + "\nglobalThis.qa = { startBackend, createWindow, quit };", context);
  await context.qa.startBackend();
  return { app, child, dialogs, qa: context.qa, released: () => resolveDialog?.(), willQuit: () => willQuit, windows: () => windows };
}

test("desktop crash Quit leaves before-quit dispatch and reports signal without startup diagnostics", async t => {
  const f = await desktop(t); f.child.emit("exit", null, "SIGKILL"); for (let i = 0; i < 5; i++) await turn();
  assert.equal(f.willQuit(), 1); assert.equal(f.dialogs.length, 1); assert.match(f.dialogs[0].detail, /stopped by SIGKILL/); assert.doesNotMatch(f.dialogs[0].detail, /SQLite|startup|secret-token|Last output/);
});
test("desktop manual quit during crash dialog exits and reopening cannot load a dead URL", async t => {
  const f = await desktop(t, true); f.child.stderr.emit("data", "fatal after-ready secret-token\n"); f.child.emit("exit", 7, null);
  assert.match(f.dialogs[0].detail, /exited with code 7/); assert.match(f.dialogs[0].detail, /Last output from the service:\nfatal after-ready \[redacted\]/);
  f.app.emit("second-instance"); for (let i = 0; i < 5; i++) await turn(); assert.equal(f.windows(), 0); assert.equal(f.willQuit(), 1);
  f.app.quit(); f.released(); await turn(); assert.equal(f.willQuit(), 1);
});
test("desktop idle quit waits for backend shutdown and exits normally", async t => {
  const f = await desktop(t); f.app.quit(); for (let i = 0; i < 5; i++) await turn(); assert.equal(f.willQuit(), 1); assert.equal(f.dialogs.length, 0);
});
