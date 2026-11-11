import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodeHostImport } from "../src/code-host-imports.js";

test("commits fetched by the removed code-host review workflow still cannot start ordinary runs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "code-host-imports-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main"); await writeFile(join(repo, "a.txt"), "a\n"); git("add", "."); git("commit", "-qm", "trusted");
    const trusted = git("rev-parse", "HEAD");
    git("checkout", "-qb", "incoming"); await writeFile(join(repo, "a.txt"), "b\n"); git("commit", "-qam", "fetched");
    const fetched = git("rev-parse", "HEAD");
    git("checkout", "-q", "main"); git("branch", "-qD", "incoming");
    git("update-ref", `refs/codeflow/untrusted-code/${fetched}`, trusted);
    assert.equal(await isCodeHostImport(repo, fetched), true);
    assert.equal(await isCodeHostImport(repo, "refs/codeflow/external/preview/source"), true);
    assert.equal(await isCodeHostImport(repo, "main"), false);
    assert.equal(await isCodeHostImport(repo, "missing-branch"), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
