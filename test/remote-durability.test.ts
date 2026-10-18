import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durableWorkerDirectory, syncWorkerDirectory } from "../src/remote-workers/durability.js";

test("first worker claim persists new store ancestors before acknowledgement, and rejects symbolic store roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "cf-worker-durability-")), destination = join(root, "home", "private", "requests");
  try {
    const synced: string[] = []; await durableWorkerDirectory(destination, async (path) => { await syncWorkerDirectory(path); synced.push(path); });
    assert.deepEqual(synced, [destination, join(root, "home", "private"), join(root, "home"), root]);
    synced.length = 0; await durableWorkerDirectory(destination, async (path) => { await syncWorkerDirectory(path); synced.push(path); }); assert.deepEqual(synced, [destination, join(root, "home", "private")]);
    await symlink(destination, join(root, "alias")); await assert.rejects(durableWorkerDirectory(join(root, "alias")), /regular directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
