import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentationOnlyChange } from "../src/documentation-changes.js";
const repos: string[] = [];
after(() => { for (const repo of repos) rmSync(repo, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "codeflow-doc-diff-")); repos.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
  git("init", "-q"); mkdirSync(join(repo, "docs")); writeFileSync(join(repo, "README.md"), "Before\n");
  git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  return { repo, git, base, commit: () => { git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change"); return git("rev-parse", "HEAD"); } };
}
test("plain documentation is measured; mixed code, instructions, binaries and executable/symlink changes require proof", async () => {
  for (const kind of ["docs", "code", "instructions", "binary", "executable", "symlink", "misleading-name"]) {
    const f = fixture(); writeFileSync(join(f.repo, "README.md"), "After\n");
    if (kind === "code") writeFileSync(join(f.repo, "app.js"), "export const changed = true;\n");
    if (kind === "instructions") writeFileSync(join(f.repo, "docs/AGENTS.md"), "Run these commands\n");
    if (kind === "binary") writeFileSync(join(f.repo, "docs/example.md"), Buffer.from([0, 1, 2]));
    if (kind === "executable") chmodSync(join(f.repo, "README.md"), 0o755);
    if (kind === "symlink") symlinkSync("../README.md", join(f.repo, "docs/link.md"));
    if (kind === "misleading-name") writeFileSync(join(f.repo, "README.js"), "process.exit(1);\n");
    assert.equal(await documentationOnlyChange(f.repo, f.base, f.commit()), kind === "docs", kind);
    assert.equal(await documentationOnlyChange(f.repo, f.base, f.base), false);
  }
});
