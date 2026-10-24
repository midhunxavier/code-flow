import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FILTERED_WORKSPACE_LIMITS, inspectFilteredWorkspace, monitorFilteredWorkspace } from "../src/filtered-task-limits.js";

async function fixture<T>(work: (root: string) => Promise<T>) { const root = await mkdtemp(join(tmpdir(), "cf-filtered-limits-")); try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); } }
test("live workspace inspection excludes immutable synthetic Git but bounds sparse logical output and directory entries", async () => fixture(async (root) => {
  await mkdir(join(root, ".git")); const git = await open(join(root, ".git", "large-object"), "wx"); await git.truncate(FILTERED_WORKSPACE_LIMITS.logicalBytes + 1); await git.close(); await writeFile(join(root, "ok.txt"), "safe"); assert.equal((await inspectFilteredWorkspace(root)).logicalBytes, 4);
  const file = await open(join(root, "oversized"), "wx"); await file.truncate(FILTERED_WORKSPACE_LIMITS.logicalBytes + 1); await file.close(); await assert.rejects(inspectFilteredWorkspace(root), /bytes exceed/); await rm(join(root, "oversized"));
  for (let offset = 0; offset < FILTERED_WORKSPACE_LIMITS.entries; offset += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(root, `entry-${offset + index}`), "")));
  await assert.rejects(inspectFilteredWorkspace(root), /entry count exceeds/);
}));
test("symbolic and hard links are refused without exposing target paths or following cycles", async () => fixture(async (root) => {
  const target = join(root, "private-target"); await mkdir(target); await writeFile(join(target, "PRIVATE-FILENAME"), "secret"); await symlink(target, join(root, "link")); await assert.rejects(inspectFilteredWorkspace(root), (error: Error) => /symbolic/.test(error.message) && !error.message.includes("PRIVATE-FILENAME") && !error.message.includes(target)); await rm(join(root, "link"));
  await writeFile(join(root, "original"), "same inode"); await link(join(root, "original"), join(root, "alias")); await assert.rejects(inspectFilteredWorkspace(root), /hard-linked/);
}));
test("live monitor reports an excess once, stops scheduling after abort and settles its current inspection", async () => fixture(async (root) => {
  const controller = new AbortController(); let calls = 0, resolve!: () => void; const exceeded = new Promise<void>((done) => resolve = done);
  const monitor = monitorFilteredWorkspace(root, { signal: controller.signal, intervalMs: 20, onExceeded: () => { calls++; controller.abort(); resolve(); } });
  const file = await open(join(root, "growing"), "wx"); await file.truncate(FILTERED_WORKSPACE_LIMITS.logicalBytes + 1); await file.close();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The production monitor intentionally unrefs its timer; the test's watchdog owns this wait.
    await Promise.race([exceeded, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Live limit did not fire")), 3000); })]);
  } finally { if (timeout) clearTimeout(timeout); controller.abort(); await monitor.stop(); }
  await new Promise((done) => setTimeout(done, 50)); assert.equal(calls, 1);
}));
