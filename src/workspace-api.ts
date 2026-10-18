import type { IncomingMessage } from "node:http";
import { open, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertWorktree, repoRoot, resolveCommit, git, worktreeGit, WorktreeMismatchError, type CheckoutRef } from "./git.js";
import { readJson, HttpError } from "./http.js";
import { inspectReadiness, inTemporaryWorktree } from "./readiness.js";
import { applyCheckpoint, checkpoints, dependencyGraph, readEditableFile, saveEditableFile, searchCode, WorkspaceConflictError } from "./workspace.js";
import { detectVerificationProfile, renderVerificationReport, runVerification, validateVerificationProfile, type VerificationPreset } from "./verification.js";
import { runCheck, type CheckResult } from "./checks.js";
import { redactExport } from "./privacy.js";
import { CODEFLOW_HOME } from "./config.js";
import { writeHealth } from "./store.js";
import type { RunManager } from "./engine.js";
import { mergeFileDraft, checkpointHunks, applyCheckpointHunks } from "./workspace-changes.js";
import { verificationIntegrity, VerificationIntegrityError } from "./verification-integrity.js";
import { inspectContext, ContextInspectionError } from "./context-inspection.js";
import { applyCommitRevert, compareCheckpoint, previewCommitRevert } from "./checkpoint-review.js";
import { searchSemanticSymbols, findCodeReferences } from "./code-intelligence.js";
import { inspectArchitecture } from "./architecture.js";

interface Result { status: number; body: unknown }
async function ownedCheckout(repo: string, tree: CheckoutRef) {
  try { return await assertWorktree(repo, tree); }
  catch (error) { if (error instanceof WorktreeMismatchError) throw new HttpError(409, error.message); throw error; }
}
async function diagnosticTail(path: string) {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return "";
  try {
    const info = await file.stat();
    if (!info.isFile()) return "";
    const bytes = Math.min(info.size, 32_000);
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, Math.max(0, info.size - bytes));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}
export async function handleWorkspaceApi(req: IncomingMessage, url: URL, parts: string[], manager: RunManager, signal: AbortSignal): Promise<Result | undefined> {
  if (!["readiness", "verification", "workspace", "diagnostics", "v1"].includes(parts[1] ?? "")) return undefined;
  const body = req.method === "POST" ? await readJson(req) : {};
  const selected = body.repo ?? url.searchParams.get("repo");
  const absolute = typeof selected === "string" && selected.startsWith("/") ? resolve(selected) : undefined;
  // Resolve application-owned paths before asking the checkout's mutable .git where it belongs.
  const owned = absolute ? manager.list().flatMap((run) => run.worktrees.map((tree) => ({ run, tree }))).find(({ tree }) => absolute === resolve(tree.path) || absolute.startsWith(resolve(tree.path) + sep)) : undefined;
  const repo = owned?.tree.path ?? (absolute ? await repoRoot(absolute).catch(() => { throw new HttpError(400, "Choose an existing Git repository"); }) : undefined);
  const requireRepo = () => { if (!repo) throw new HttpError(400, "Choose a repository"); return repo; };
  const readRepo = () => owned ? worktreeGit(owned.run.repo, owned.tree.path) : Promise.resolve(requireRepo());
  const writeRepo = () => owned ? ownedCheckout(owned.run.repo, owned.tree) : Promise.resolve(requireRepo());
  const boundedCommand = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 4000 || value.includes("\0")) throw new HttpError(400, "Commands must be text under 4,000 characters");
    return value;
  };
  if (parts[1] === "v1" && parts[2] === "capabilities" && req.method === "GET") return { status: 200, body: { version: 1, features: ["readiness", "verification", "file-editing", "code-search", "dependencies", "checkpoints", "diagnostics", "run-export", "cursor-history", "shared-projects", "ssh-workers", "coordinated-changes", "code-hosts", "github-review-threads", "filesystem-policies", "filtered-tasks", "provider-workflow-extensions"], authentication: "Bearer CODEFLOW_TOKEN", api: "/api", docs: "docs/api.md" } };
  if (parts[1] === "readiness" && req.method === "POST") {
    if (body.execute === true) manager.noteActivity();
    return { status: 200, body: await inspectReadiness({ repo: owned?.run.repo ?? requireRepo(), baseRef: await resolveCommit(await readRepo(), typeof body.baseRef === "string" && body.baseRef ? body.baseRef : "HEAD"), setup: boundedCommand(body.setup), check: boundedCommand(body.check), execute: body.execute === true, signal }) };
  }
  if (parts[1] === "verification") {
    if (req.method === "GET" && parts[2] === "profile") return { status: 200, body: await detectVerificationProfile(requireRepo(), (url.searchParams.get("preset") || "standard") as VerificationPreset) };
    if (req.method === "POST" && !parts[2]) {
      const selectedRepo = requireRepo();
      const profile = body.profile ? validateVerificationProfile(body.profile) : await detectVerificationProfile(selectedRepo, body.preset ?? "standard");
      const originalRepo = owned?.run.repo ?? selectedRepo;
      const at = await readRepo();
      const ref = await resolveCommit(at, typeof body.baseRef === "string" && body.baseRef ? body.baseRef : "HEAD");
      const setup = boundedCommand(body.setup) ?? profile.setup;
      const run = async (path: string, baseline?: Record<string, CheckResult>) => {
        const integrity = await verificationIntegrity(await assertWorktree(originalRepo, { path }), signal);
        const report = await runVerification(path, profile, { signal, repeats: body.repeats, baseline, execute: async (check, options) => {
          await integrity.assert(`before gate ${check.id}`);
          await assertWorktree(originalRepo, { path });
          const result = await runCheck(path, check.command, options);
          await integrity.assert(`gate ${check.id}`);
          return result;
        } });
        await integrity.assert("completion"); return report;
      };
      manager.noteActivity();
      let baseline: Record<string, CheckResult> | undefined;
      const prepare = async (path: string) => {
        const integrity = await verificationIntegrity(await assertWorktree(originalRepo, { path }), signal);
        if (setup) {
          await assertWorktree(originalRepo, { path });
          const result = await runCheck(path, setup, { timeoutMs: 120_000, signal });
          await integrity.assert("setup");
          if (!result.ok) throw new HttpError(422, `Verification setup failed: ${result.output.slice(-2000)}`);
        }
      };
      try {
        if (typeof body.baseline === "string" && body.baseline) {
          const base = await resolveCommit(at, body.baseline);
          baseline = await inTemporaryWorktree(originalRepo, base, async (path) => { await prepare(path); const report = await run(path); return Object.fromEntries(report.checks.filter((check) => check.attempts.length).map((check) => [check.check.id, check.attempts[0]!])); }, signal);
        }
        const report = await inTemporaryWorktree(originalRepo, ref, async (path) => { await prepare(path); return run(path, baseline); }, signal);
        return { status: 200, body: redactExport({ ...report, repo: selectedRepo, commit: ref, markdown: renderVerificationReport(report) }) };
      } catch (error) { if (error instanceof VerificationIntegrityError || error instanceof WorktreeMismatchError) throw new HttpError(409, error.message); throw error; }
    }
  }
  if (parts[1] === "workspace") {
    const selectedRepo = requireRepo();
    if (parts[2] === "compare-checkpoint" && req.method === "POST") {
      if (typeof body.from !== "string" || typeof body.to !== "string") throw new HttpError(400, "Choose two commits to compare");
      return { status: 200, body: await compareCheckpoint(await readRepo(), body, signal) };
    }
    if (["preview-revert", "apply-revert"].includes(parts[2] ?? "") && req.method === "POST") {
      const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
      const tree = run?.worktrees.find((tree) => tree.path === selectedRepo);
      if (!run || !tree) throw new HttpError(409, "Choose an owned run worktree before reverting a commit");
      if (typeof body.commit !== "string" || typeof body.expectedHead !== "string") throw new HttpError(400, "Choose a commit and refresh the current HEAD");
      try {
        return { status: 200, body: await manager.withIdleRepository<unknown>(selectedRepo, async () => { const at = await ownedCheckout(run.repo, tree); return parts[2] === "preview-revert" ? previewCommitRevert(at, body, signal, run.repo) : applyCommitRevert(at, body, signal, run.repo); }, { kind: "checkpoint-revert", owner: run.id }) };
      } catch (error) { if (error instanceof WorkspaceConflictError) throw new HttpError(409, error.message); throw error; }
    }
    if (parts[2] === "merge-file" && req.method === "POST") return { status: 200, body: await mergeFileDraft(await readRepo(), body.path, body.base, body.draft) };
    if (["checkpoint-hunks", "apply-hunks"].includes(parts[2] ?? "") && req.method === "POST") {
      const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
      const tree = run?.worktrees.find((tree) => tree.path === selectedRepo);
      if (!run || !tree || run.status === "running") throw new HttpError(409, "Choose an idle run worktree before applying checkpoint hunks");
      try { return { status: 200, body: await manager.withIdleRepository<unknown>(selectedRepo, async () => { const at = await ownedCheckout(run.repo, tree); return parts[2] === "checkpoint-hunks" ? checkpointHunks(at, body) : applyCheckpointHunks(at, body); }, { kind: "checkpoint-hunks", owner: run.id }) }; }
      catch (error) { if (error instanceof WorkspaceConflictError) throw new HttpError(409, error.message); throw error; }
    }
    if (parts[2] === "file") {
      const path = typeof body.path === "string" ? body.path : url.searchParams.get("path") ?? "";
      if (req.method === "GET") return { status: 200, body: await readEditableFile(await readRepo(), path) };
      if (req.method === "POST") {
        const busy = manager.list().find((run) => run.status === "running" && (run.repo === selectedRepo || run.worktrees.some((tree) => tree.path === selectedRepo)));
        if (busy) throw new HttpError(409, "Finish or stop the active run before editing its workspace");
        try { return { status: 200, body: await manager.withIdleRepository(selectedRepo, async () => saveEditableFile(await writeRepo(), path, body.text, body.expectedHash), { kind: "file-edit", owner: "workspace" }) }; }
        catch (error) { if (error instanceof WorkspaceConflictError) throw new HttpError(409, error.message); throw error; }
      }
    }
    if (parts[2] === "search" && req.method === "GET") return { status: 200, body: url.searchParams.get("mode") === "semantic" ? await searchSemanticSymbols(selectedRepo, url.searchParams.get("q") ?? "", signal) : await searchCode(await readRepo(), url.searchParams.get("q") ?? "", url.searchParams.get("mode") === "symbols" ? "symbols" : "text") };
    if (parts[2] === "references" && req.method === "GET") return { status: 200, body: await findCodeReferences(selectedRepo, { path: url.searchParams.get("path") ?? "", line: Number(url.searchParams.get("line")), column: Number(url.searchParams.get("column")) }, signal) };
    if (parts[2] === "dependencies" && req.method === "GET") return { status: 200, body: await inspectArchitecture(selectedRepo, signal) };
    if (parts[2] === "checkpoints" && req.method === "GET") { const at = await readRepo(); return { status: 200, body: { head: await resolveCommit(at), checkpoints: await checkpoints(at, url.searchParams.get("ref") || "HEAD") } }; }
    if (parts[2] === "apply-checkpoint" && req.method === "POST") {
      const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
      const tree = run?.worktrees.find((tree) => tree.path === selectedRepo);
      if (!run || !tree || run.status === "running") throw new HttpError(409, "Choose an idle run worktree before applying checkpoint files");
      if (!Array.isArray(body.paths) || body.paths.some((path: unknown) => typeof path !== "string")) throw new HttpError(400, "Choose repository paths");
      return { status: 200, body: await manager.withIdleRepository(selectedRepo, async () => applyCheckpoint(await ownedCheckout(run.repo, tree), { source: String(body.source ?? ""), paths: body.paths, expectedHead: String(body.expectedHead ?? "") }), { kind: "checkpoint-files", owner: run.id }) };
    }
    if (parts[2] === "context" && req.method === "POST") {
      try { return { status: 200, body: await inspectContext({ repo: selectedRepo, baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined, paths: body.paths, attachments: body.attachments, signal }) }; }
      catch (error) { if (error instanceof ContextInspectionError) throw new HttpError(error.status, error.message); throw error; }
    }
  }
  if (parts[1] === "diagnostics" && req.method === "GET") {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const log = await diagnosticTail(join(CODEFLOW_HOME, "server.log"));
    const runs = manager.list();
    return { status: 200, body: redactExport({ version: 1, application: packageJson.version, node: process.version, platform: process.platform, at: Date.now(), busy: manager.busy, activity: manager.inspectRepositoryActivity(), writes: writeHealth, runs: { total: runs.length, active: runs.filter((run) => run.status === "running").length, interrupted: runs.filter((run) => run.status === "interrupted").length }, recentErrors: log.slice(-32_000), capabilities: { workspace: true, verificationProfiles: true }, git: repo ? await git(["--version"], repo).then((result) => result.stdout.trim()) : undefined }) };
  }
  throw new HttpError(404, "Unknown workspace operation");
}
