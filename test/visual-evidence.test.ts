import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visualEvidenceFiles, visualEvidenceMarkdown, wantsVisualEvidence } from "../src/visual-evidence.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6LkAAAAASUVORK5CYII=", "base64");
test("only changed, regular, committed visual artifacts are attached at the exact revision", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cf-visual-evidence-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  const dir = join(repo, ".codeflow/evidence"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.png"), png); git("add", "."); git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "desktop.png"), png); writeFileSync(join(dir, "flow.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  writeFileSync(join(dir, "README.md"), "Tested the retry flow. Commands and results are described here.\n");
  writeFileSync(join(dir, "secret.txt"), "never attach"); symlinkSync("../../secret.txt", join(dir, "linked.png"));
  writeFileSync(join(dir, "oversized.mp4"), Buffer.alloc(21 * 1024 * 1024));
  git("add", "."); git("commit", "-qm", "capture evidence");
  writeFileSync(join(dir, "uncommitted.png"), png);
  const evidence = await visualEvidenceFiles(repo, base, "main");
  assert.deepEqual(evidence.files.map(file => file.path), [".codeflow/evidence/desktop.png", ".codeflow/evidence/flow.webm", ".codeflow/evidence/README.md"]);
  assert.equal(evidence.head, git("rev-parse", "HEAD"));
  const markdown = visualEvidenceMarkdown("https://github.example.com/owner/repo", evidence.head, evidence.files);
  assert.ok(markdown.includes(`/blob/${evidence.head}/.codeflow/evidence/desktop.png?raw=true`));
  assert.match(markdown, /Watch recording: flow.webm/);
  assert.match(markdown, /Test steps and results/);
  assert.doesNotMatch(markdown, /secret|linked|oversized|uncommitted|old.png/);
  assert.throws(() => visualEvidenceMarkdown("https://token@github.com/owner/repo", evidence.head, evidence.files), /Invalid/);
  assert.throws(() => visualEvidenceMarkdown("http://localhost/owner/repo", evidence.head, evidence.files), /Invalid/);
});

test("visual capture guidance is only added for relevant chat requests", () => {
  assert.ok(wantsVisualEvidence("Test this flow and attach screenshots and a short screen recording to the PR"));
  assert.ok(wantsVisualEvidence("Add visual evidence"));
  assert.equal(wantsVisualEvidence("Fix the dependency update and run unit tests"), false);
});
