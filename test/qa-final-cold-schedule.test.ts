import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pattern } from "../src/engine.js";

const home = mkdtempSync(join(tmpdir(), "qa-cold-schedule-home-"));
process.env.CODEFLOW_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));
const { RunManager } = await import("../src/engine.js");
const pattern: Pattern = { id: "cold-fixture", name: "Cold fixture", summary: "", description: "", roles: [], options: [], run: async () => "Done" };
const barrier = () => { let release!: () => void; const wait = new Promise<void>(resolve => release = resolve); return { wait, release }; };

for (const closing of [false, true]) test(`archived cache coalesces updates during a write${closing ? " and shutdown awaits the replacement" : ""}`, async () => {
  const repo = mkdtempSync(join(tmpdir(), "qa-cold-schedule-repo-")), manager = new RunManager(id => id === pattern.id ? pattern : undefined);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"]);
  const entered = barrier(), held = barrier(), store = (manager as any).coldRuns, save = store.save.bind(store);
  let saves = 0;
  store.save = async (...args: unknown[]) => { if (++saves === 1) { entered.release(); await held.wait; } return save(...args); };
  try {
    const run = await manager.start({ repo, pattern, task: "Archive fixture", roles: {}, options: {}, loop: { copy: [], setup: "", check: "" } });
    const deadline = Date.now() + 5000;
    while ((manager as any).active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.status, "done");
    await manager.archive(run.id, { cleanup: false }); await entered.wait;
    for (const summary of ["First update", "Latest update"]) { run.summary = summary; manager.emitRun(run); }
    const shutdown = closing ? manager.shutdown() : undefined;
    held.release();
    if (shutdown) await shutdown;
    const settled = Date.now() + 5000;
    while (manager.inspectStorage().pending && Date.now() < settled) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.inspectStorage().pending, 0);
    assert.equal(manager.list().find(item => item.id === run.id)?.cold, true, "the last update must not leave an archived run permanently hot");
    assert.equal(manager.get(run.id)?.summary, "Latest update");
    assert.equal(saves, 2, "updates during one save coalesce into one replacement save");
  } finally { held.release(); await manager.shutdown(); rmSync(repo, { recursive: true, force: true }); }
});
