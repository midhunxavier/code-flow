import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodeHostStagingBudget } from "../src/code-host-git.js";

for (const nested of [false, true]) test(`staging tolerates a Git ${nested ? "directory" : "lock file"} disappearing during inspection`, async t => {
  const root = await mkdtemp(join(tmpdir(), "codeflow-staging-race-")); t.after(() => rm(root, { recursive: true, force: true }));
  const changing = join(root, nested ? "objects" : "packed-refs.lock");
  if (nested) { await mkdir(changing); await writeFile(join(changing, "temporary.pack"), "fixture"); } else await writeFile(changing, "fixture");
  await writeFile(join(root, "stable"), "kept"); let removed = false;
  await checkCodeHostStagingBudget(root, {
    readdir: async dir => { if (nested && dir === changing) { removed = true; await rm(changing, { recursive: true }); } return readdir(dir); },
    lstat: async file => { if (!nested && file === changing) { removed = true; await rm(changing); } return lstat(file); },
  });
  assert.equal(removed, true); await checkCodeHostStagingBudget(root);
});

test("staging still rejects missing roots, other I/O errors, symlinks and oversized files", async t => {
  const root = await mkdtemp(join(tmpdir(), "codeflow-staging-bounds-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "object"); await writeFile(file, "fixture");
  const denied = Object.assign(new Error("fixture access denied"), { code: "EACCES" });
  await assert.rejects(checkCodeHostStagingBudget(root, { readdir, lstat: async () => { throw denied; } }), error => error === denied);
  await assert.rejects(checkCodeHostStagingBudget(root, { readdir: async () => Array.from({ length: 20_001 }, (_, index) => String(index)), lstat: async () => ({ size: 0, isSymbolicLink: () => false, isDirectory: () => false }) }), /20,000/);
  await symlink(file, join(root, "link")); await assert.rejects(checkCodeHostStagingBudget(root), /Unsafe staging path/); await rm(join(root, "link"));
  await truncate(file, 256 * 1024 * 1024 + 1); await assert.rejects(checkCodeHostStagingBudget(root), /storage limits/);
  await rm(root, { recursive: true }); await assert.rejects(checkCodeHostStagingBudget(root), { code: "ENOENT" });
});
