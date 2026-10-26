// Imported files and working edits must keep their exact Git paths when review labels provenance.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-qa-review-provenance-")));
process.env.CODEFLOW_HOME = join(directory, "home");
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { changedFiles, workingChangedFiles } = await import("../src/git.js");
const manager = new RunManager(findPattern);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", ...args], { cwd, encoding: "utf8" }).trim();
const write = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
after(async () => { await manager.shutdown(); rmSync(directory, { recursive: true, force: true }); });
async function idle(run: import("../src/engine.js").Run) {
  for (let tries = 0; tries < 600; tries++) { if (run.status !== "running") return run; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("Run did not finish");
}

test("review labels imported paths exactly and removes that label when their working files change", async () => {
  const repo = join(directory, "repo");
  git(directory, "init", "-q", "-b", "main", repo);
  write(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const run = await idle(await manager.start({ repo, pattern: findPattern("solo")!, task: "Edit shared.txt CONFLICT", roles: { agent: ["claude"] }, options: {} }));
  assert.equal(run.status, "done", run.error);
  const tree = run.worktrees[0]!;
  const names = [" imported.txt", "café.md", 'quote".txt', "tab\tname.txt", "line\nname.txt", "tail\n", "back\\slash.txt", "a b/c.txt"];
  git(repo, "checkout", "-q", "-b", "theirs");
  write(join(repo, "shared.txt"), "theirs\n");
  for (const path of names) write(join(repo, path), "imported content\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "target changes");
  git(repo, "checkout", "-q", "main");
  assert.deepEqual(new Set(await changedFiles(repo, "main", "theirs")), new Set(["shared.txt", ...names]));
  await manager.followUp(run.id, { kind: "resolve-conflicts", worktree: tree.name, agent: "claude", mergeFrom: "theirs" });
  await idle(run);
  assert.equal(run.followUps.at(-1)!.status, "done", run.followUps.at(-1)!.result);
  const files = await manager.diff(run.id, tree.branch);
  assert.deepEqual(new Set(files.filter(file => file.mergedFrom === "theirs").map(file => file.path)), new Set(names));
  assert.deepEqual(new Set((await manager.reviewCoverage(run.id, tree.branch)).merged?.files), new Set(names));

  for (const path of names) write(join(tree.path, path), "edited by the agent after import\n");
  assert.deepEqual(new Set(await workingChangedFiles(tree.path, "theirs")), new Set(["shared.txt", ...names]));
  assert.equal((await manager.diff(run.id, tree.branch)).filter(file => file.mergedFrom).length, 0, "working edits belong to this run even with unusual names");
});
