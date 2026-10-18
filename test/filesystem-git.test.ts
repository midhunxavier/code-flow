import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureFilePolicyResolver, ProjectFilePolicies } from "../src/filesystem-policy.js";
import { listTree } from "../src/repo-tree.js";
import { branchDiff } from "../src/ship.js";

test("restricted tree browsing and review diffs never execute repository fsmonitor, clean filters, textconv or external diff commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "codeflow-policy-git-")), repo = join(home, "repo"), marker = join(home, "executed"), command = join(home, "repository-command"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); let restore: (() => void) | undefined;
  try {
    git("init", "-q", "-b", "main"); await writeFile(join(repo, "source.md"), "original source\n"); await writeFile(join(repo, ".gitattributes"), "*.md diff=policy-fixture filter=policy-fixture\n"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "base"); const base = git("rev-parse", "HEAD"); await writeFile(join(repo, "source.md"), "changed source\n"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@test", "commit", "-qm", "result");
    await writeFile(command, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},'executed\\n');process.stdout.write('command output');\n`); await chmod(command, 0o700);
    git("config", "core.fsmonitor", command); git("config", "filter.policy-fixture.clean", command); git("config", "filter.policy-fixture.smudge", command); git("config", "diff.policy-fixture.textconv", command); git("config", "diff.policy-fixture.command", command); git("config", "diff.external", command);
    const policy = await new ProjectFilePolicies(home).set("project", { revision: 0, read: { allow: ["."], deny: ["private"] }, write: { allow: ["."], deny: [] } }); restore = configureFilePolicyResolver(async () => [policy], { suppressRepositoryCommands: () => true });
    const tree = await listTree(repo); assert.ok(tree.entries.some((entry) => entry.path === "source.md")); assert.equal(tree.entries.every((entry) => entry.status === undefined), true);
    const diff = await branchDiff(repo, base, "main"); assert.equal(diff.length, 1); assert.match(diff[0]!.patch, /changed source/); assert.equal(await readFile(marker, "utf8").catch(() => ""), "", "read-only app surfaces must not invoke configured repository programs");
  } finally { restore?.(); await rm(home, { recursive: true, force: true }); }
});
