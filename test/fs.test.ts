import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectories } from "../src/fs.js";

test("lists subfolders, marks git repos, hides dotfolders and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeflow-fs-"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "Alpha", ".git"), { recursive: true });
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "x");
  symlinkSync(join(root, "beta"), join(root, "link-to-beta"));
  symlinkSync(join(root, "file.txt"), join(root, "link-to-file"));

  const listing = await listDirectories(root);
  assert.equal(listing.path, root);
  assert.equal(listing.isRepo, false);
  assert.deepEqual(
    listing.entries.map((e) => [e.name, e.isRepo]),
    [["Alpha", true], ["beta", false], ["link-to-beta", false]],
  );

  const withHidden = await listDirectories(root, true);
  assert.ok(withHidden.entries.some((e) => e.name === ".hidden"));

  assert.equal((await listDirectories(join(root, "Alpha"))).isRepo, true);
  assert.equal((await listDirectories("/")).parent, null);
});

test("rejects missing folders and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeflow-fs-"));
  writeFileSync(join(root, "file.txt"), "x");
  await assert.rejects(listDirectories(join(root, "nope")), { code: "ENOENT" });
  await assert.rejects(listDirectories(join(root, "file.txt")), /not a directory/);
});
