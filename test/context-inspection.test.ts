import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-inspection-module-"));
const { inspectContext, measurePromptContext, enforceContextBudget, ContextBudgetError, validateContextBudget } = await import("../src/context-inspection.js");
const { prepareContext, stageMessageFiles } = await import("../src/context.js");
async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "codeflow-inspection-")); const repo = join(root, "repo"); await mkdir(join(repo, "src"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); git("init", "-q", "-b", "main");
  await writeFile(join(repo, "src", "app.ts"), "export const original = '🧪';\n"); await writeFile(join(repo, "src", ".env"), "PASSWORD=never-preview-this\n");
  await writeFile(join(repo, "src", "binary.bin"), Buffer.from([0, 1, 2, 3])); await writeFile(join(repo, ".gitignore"), "src/ignored.txt\n");
  await writeFile(join(root, "outside-secret"), "outside-secret-must-not-appear"); await symlink(join(root, "outside-secret"), join(repo, "src", "linked"));
  git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
  const base = git("rev-parse", "HEAD"); await writeFile(join(repo, "src", "app.ts"), "export const changed = true;\n"); await writeFile(join(repo, "src", "untracked.txt"), "Uncommitted reference\n"); await writeFile(join(repo, "src", "ignored.txt"), "Ignored local material\n");
  return { root, repo, base, git };
}

test("directory inspection uses committed base contents, excludes secrets/binary/symlinks and does not imply local descendants were dispatched", async (t) => {
  const { repo, base } = await fixture(t); const report = await inspectContext({ repo, baseRef: base, paths: ["src"] });
  const app = report.files.find((file) => file.path === "src/app.ts")!;
  assert.equal(app.source, "base-ref"); assert.match(app.preview!, /original/); assert.doesNotMatch(app.preview!, /changed/);
  assert.equal(app.bytes, Buffer.byteLength("export const original = '🧪';\n")); assert.equal(app.approximateTokens, Math.ceil(app.bytes! / 4));
  assert.equal(report.files.some((file) => /untracked|ignored/.test(file.path)), false);
  assert.equal(report.files.find((file) => file.path === "src/.env")!.sensitive, true);
  assert.ok(report.files.find((file) => file.path === "src/binary.bin")!.omitted); assert.ok(report.files.find((file) => file.path === "src/linked")!.omitted);
  assert.doesNotMatch(JSON.stringify(report), /never-preview-this|outside-secret-must-not-appear/);
});

test("explicit files inspect local edits and uncommitted references with deduplication, redacted previews and attachment uncertainty", async (t) => {
  const { repo, base } = await fixture(t); await writeFile(join(repo, "reference.md"), "api_key=abcdefghijklmnopqrstuvwxyz0123456789\n");
  const report = await inspectContext({ repo, baseRef: base, paths: ["src/app.ts", "src/untracked.txt", "src/app.ts", "reference.md", ".git/config", "src/.env"], attachments: [{ name: "spec.md", size: 40 }, { name: "screen.png", size: 100 }] });
  assert.equal(report.files.filter((file) => file.path === "src/app.ts").length, 1); assert.match(report.files.find((file) => file.path === "src/app.ts")!.preview!, /changed/);
  assert.equal(report.files.find((file) => file.path === "reference.md")!.redacted, true); assert.doesNotMatch(JSON.stringify(report), /abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal(report.attachments[0]!.approximateTokens, 10); assert.equal(report.attachments[1]!.approximateTokens, undefined); assert.equal(report.unknownTokenAttachments, 1);
  assert.equal(report.attachmentBytes, 140); assert.equal(report.bytes, report.fileBytes + 140); assert.match(report.note, /not pasted into prompts/);
});

test("inspection bounds file count, individual size and total bytes", async (t) => {
  const { repo, git } = await fixture(t); await mkdir(join(repo, "many"));
  for (let index = 0; index < 205; index++) await writeFile(join(repo, "many", `${index}.txt`), "small\n");
  await mkdir(join(repo, "bytes")); for (let index = 0; index < 17; index++) await writeFile(join(repo, "bytes", `${index}.txt`), "x".repeat(512 * 1024));
  await writeFile(join(repo, "oversized.txt"), "x".repeat(513 * 1024)); git("add", "many", "bytes", "oversized.txt"); git("-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "bounds");
  const many = await inspectContext({ repo, paths: ["many"] }); assert.equal(many.files.length, 200); assert.equal(many.truncated, true);
  const bytes = await inspectContext({ repo, paths: ["bytes", "oversized.txt"] }); assert.ok(bytes.fileBytes <= 8 * 1024 * 1024); assert.equal(bytes.truncated, true); assert.match(bytes.files.find((file) => file.path === "oversized.txt")!.omitted!, /512 KiB/);
});

test("actual context preparation rejects credentials, selected symlinks and credential attachments before copying them", async (t) => {
  const { repo, root, base } = await fixture(t); const staging = join(root, "stage");
  await assert.rejects(prepareContext(repo, base, { paths: [{ path: "src/.env" }] }, staging), /credential/);
  await assert.rejects(prepareContext(repo, base, { paths: [{ path: ".git/config" }] }, staging), /credential|Git-internal/);
  await assert.rejects(prepareContext(repo, base, { paths: [{ path: "src/linked" }] }, staging), /Symbolic/);
  await rm(join(repo, "src", "linked")); await assert.rejects(prepareContext(repo, base, { paths: [{ path: "src/linked" }] }, staging), /Symbolic/);
  await assert.rejects(prepareContext(repo, base, { attachments: [{ name: "../../.env", data: Buffer.from("secret").toString("base64") }] }, staging), /credential attachments/);
  await assert.rejects(stageMessageFiles(staging, "m1", [{ name: "private.pem", data: Buffer.from("secret").toString("base64") }]), /credential attachments/);
  const normal = await prepareContext(repo, base, { paths: [{ path: "src/app.ts" }], attachments: [{ name: "../../spec.md", data: Buffer.from("Public spec\n").toString("base64") }] }, staging);
  assert.equal(await readFile(join(staging, "repo", "src", "app.ts"), "utf8"), "export const changed = true;\n"); assert.equal(normal.attachments[0]!.name, "spec.md");
});

test("invocation measurement covers exact UTF-8 prompt/schema input and keeps hidden provider context explicitly outside scope", () => {
  const input = { prompt: "Task 🧪\nUser note", jsonSchema: { type: "object" }, resumeSessionId: "existing-session" };
  const evidence = measurePromptContext(input); assert.equal(evidence.promptBytes, Buffer.byteLength(input.prompt)); assert.equal(evidence.schemaBytes, Buffer.byteLength(JSON.stringify(input.jsonSchema))); assert.equal(evidence.bytes, evidence.promptBytes + evidence.schemaBytes);
  assert.equal(evidence.approximateTokens, Math.ceil(evidence.bytes / 4)); assert.equal(evidence.resumed, true); assert.match(evidence.hash, /^[a-f0-9]{64}$/); assert.ok(evidence.excluded.includes("Earlier conversation history"));
  assert.equal(measurePromptContext({ ...input, resumeSessionId: undefined }).bytes, evidence.bytes, "unknown previous conversations are not invented in the estimate");
  const warn = enforceContextBudget(input, { maxPromptBytes: 1, maxApproximateTokens: 1, policy: "warn" }); assert.equal(warn.exceeded, true); assert.equal(warn.violations.length, 2);
  assert.throws(() => enforceContextBudget(input, { maxPromptBytes: 1, policy: "block" }), (error: unknown) => error instanceof ContextBudgetError && error.evidence.promptBytes === evidence.promptBytes);
});

test("context ceilings are explicit, validated and never inferred from provider context windows", () => {
  assert.equal(validateContextBudget(undefined), undefined); assert.deepEqual(validateContextBudget({ maxPromptBytes: 100 }), { maxPromptBytes: 100, policy: "warn" });
  for (const value of [{}, { maxPromptBytes: 0 }, { maxPromptBytes: 1.5 }, { maxApproximateTokens: Infinity }, { maxPromptBytes: 100, policy: "silent" }, { maxPromptBytes: 100, providerWindow: 1000000 }]) assert.throws(() => validateContextBudget(value));
});
