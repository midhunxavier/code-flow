import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readEditableFile, saveEditableFile, searchCode, dependencyGraph, WorkspaceConflictError } from "../src/workspace.js";
import { redactExport, redactText } from "../src/privacy.js";
import { inTemporaryWorktree } from "../src/readiness.js";

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "codeflow-workspace-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "main.ts"), "import { sum } from './sum.js';\nexport function main() { return sum(1, 2); }\n");
  await writeFile(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial"], { cwd: repo });
  return repo;
}

test("file editing preserves concurrent edits and rejects symbolic links and git internals", async () => {
  const repo = await fixture();
  try {
    const loaded = await readEditableFile(repo, "sum.ts");
    await writeFile(join(repo, "sum.ts"), "concurrent change\n");
    await assert.rejects(saveEditableFile(repo, "sum.ts", "draft\n", loaded.hash), WorkspaceConflictError);
    assert.equal(await readFile(join(repo, "sum.ts"), "utf8"), "concurrent change\n");
    const latest = await readEditableFile(repo, "sum.ts");
    await saveEditableFile(repo, "sum.ts", "accepted draft\n", latest.hash);
    assert.equal(await readFile(join(repo, "sum.ts"), "utf8"), "accepted draft\n");
    await symlink(join(repo, "sum.ts"), join(repo, "linked.ts"));
    await assert.rejects(readEditableFile(repo, "linked.ts"), /symbolic/);
    await assert.rejects(readEditableFile(repo, ".git/config"), /outside .git/);
    await assert.rejects(readEditableFile(repo, "../outside"), /inside/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("code search and import graph provide bounded source references", async () => {
  const repo = await fixture();
  try {
    assert.equal((await searchCode(repo, "main", "symbols")).hits[0]?.symbol, "main");
    assert.equal((await searchCode(repo, "a + b")).hits[0]?.path, "sum.ts");
    assert.deepEqual((await dependencyGraph(repo)).edges, [{ from: "main.ts", to: "sum.ts", specifier: "./sum.js" }]);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("temporary validation cleans up its worktree after command failure", async () => {
  const repo = await fixture();
  const original = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString();
  try {
    await assert.rejects(inTemporaryWorktree(repo, "HEAD", async (path) => {
      await writeFile(join(path, "sum.ts"), "temporary\n");
      throw new Error("validation failed");
    }), /validation failed/);
    assert.match(await readFile(join(repo, "sum.ts"), "utf8"), /a \+ b/);
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString(), original);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("diagnostic exports redact credentials without losing numeric usage", () => {
  assert.equal(redactText("Bearer abcdefghijklmnopqrstuvwxyz"), "Bearer [REDACTED]");
  assert.equal(redactText("api_key=abcdefghijklmnop"), "api_key=[REDACTED]");
  assert.deepEqual(redactExport({ token: "secret-value", usage: { inputTokens: 25 }, url: "https://example.test/?token=secret" }), { token: "[REDACTED]", usage: { inputTokens: 25 }, url: "https://example.test/?token=[REDACTED]" });
});
