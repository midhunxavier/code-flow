import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRepoImage } from "../src/repo-tree.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq9sAAAAASUVORK5CYII=", "base64");
test("repository image previews preserve raster bytes and refuse active content, escaped paths and oversized reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflow-image-")), repo = join(root, "repo");
  try {
    await mkdir(repo); await writeFile(join(repo, "screen.png"), png);
    assert.deepEqual(await readRepoImage(repo, "screen.png"), { mimeType: "image/png", data: png.toString("base64") });
    await writeFile(join(repo, "fake.png"), '<html><script>alert(1)</script></html>');
    await assert.rejects(readRepoImage(repo, "fake.png"), /supports PNG/);
    await writeFile(join(repo, "large.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(readRepoImage(repo, "large.png"), /8 MB/);
    await writeFile(join(root, "outside.png"), png); await symlink(join(root, "outside.png"), join(repo, "escape.png"));
    await assert.rejects(readRepoImage(repo, "escape.png"), /outside the repository/);
    await assert.rejects(readRepoImage(repo, "../outside.png"), /inside the repository/);
    await assert.rejects(readRepoImage(repo, "/screen.png"), /inside the repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
