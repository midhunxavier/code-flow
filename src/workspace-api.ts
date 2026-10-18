import type { IncomingMessage } from "node:http";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, resolveCommit, git } from "./git.js";
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

interface Result { status: number; body: unknown }
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
  const repo = typeof selected === "string" && selected.startsWith("/") ? await repoRoot(selected).catch(() => { throw new HttpError(400, "Choose an existing Git repository"); }) : undefined;
  const requireRepo = () => { if (!repo) throw new HttpError(400, "Choose a repository"); return repo; };
  const boundedCommand = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > 4000 || value.includes("\0")) throw new HttpError(400, "Commands must be text under 4,000 characters");
    return value;
  };
  if (parts[1] === "v1" && parts[2] === "capabilities" && req.method === "GET") return { status: 200, body: { version: 1, features: ["readiness", "verification", "file-editing", "code-search", "dependencies", "checkpoints", "diagnostics", "run-export"], authentication: "Bearer CODEFLOW_TOKEN", api: "/api", docs: "docs/api.md" } };
  if (parts[1] === "readiness" && req.method === "POST") {
    if (body.execute === true) manager.noteActivity();
    return { status: 200, body: await inspectReadiness({ repo: requireRepo(), baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined, setup: boundedCommand(body.setup), check: boundedCommand(body.check), execute: body.execute === true, signal }) };
  }
  if (parts[1] === "verification") {
    if (req.method === "GET" && parts[2] === "profile") return { status: 200, body: await detectVerificationProfile(requireRepo(), (url.searchParams.get("preset") || "standard") as VerificationPreset) };
    if (req.method === "POST" && !parts[2]) {
      const selectedRepo = requireRepo();
      const profile = body.profile ? validateVerificationProfile(body.profile) : await detectVerificationProfile(selectedRepo, body.preset ?? "standard");
      const ref = await resolveCommit(selectedRepo, typeof body.baseRef === "string" && body.baseRef ? body.baseRef : "HEAD");
      const setup = boundedCommand(body.setup) ?? profile.setup;
      const run = async (path: string, baseline?: Record<string, CheckResult>) => {
        const integrity = await verificationIntegrity(path, signal);
        const report = await runVerification(path, profile, { signal, repeats: body.repeats, baseline, execute: async (check, options) => {
          await integrity.assert(`before gate ${check.id}`);
          const result = await runCheck(path, check.command, options);
          await integrity.assert(`gate ${check.id}`);
          return result;
        } });
        await integrity.assert("completion"); return report;
      };
      manager.noteActivity();
      let baseline: Record<string, CheckResult> | undefined;
      const prepare = async (path: string) => {
        const integrity = await verificationIntegrity(path, signal);
        if (setup) {
          const result = await runCheck(path, setup, { timeoutMs: 120_000, signal });
          await integrity.assert("setup");
          if (!result.ok) throw new HttpError(422, `Verification setup failed: ${result.output.slice(-2000)}`);
        }
      };
      try {
        if (typeof body.baseline === "string" && body.baseline) {
          const base = await resolveCommit(selectedRepo, body.baseline);
          baseline = await inTemporaryWorktree(selectedRepo, base, async (path) => { await prepare(path); const report = await run(path); return Object.fromEntries(report.checks.filter((check) => check.attempts.length).map((check) => [check.check.id, check.attempts[0]!])); }, signal);
        }
        const report = await inTemporaryWorktree(selectedRepo, ref, async (path) => { await prepare(path); return run(path, baseline); }, signal);
        return { status: 200, body: redactExport({ ...report, repo: selectedRepo, commit: ref, markdown: renderVerificationReport(report) }) };
      } catch (error) { if (error instanceof VerificationIntegrityError) throw new HttpError(409, error.message); throw error; }
    }
  }
  if (parts[1] === "workspace") {
    const selectedRepo = requireRepo();
    if (parts[2] === "merge-file" && req.method === "POST") return { status: 200, body: await mergeFileDraft(selectedRepo, body.path, body.base, body.draft) };
    if (["checkpoint-hunks", "apply-hunks"].includes(parts[2] ?? "") && req.method === "POST") {
      const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
      if (!run?.worktrees.some((tree) => tree.path === selectedRepo) || run.status === "running") throw new HttpError(409, "Choose an idle run worktree before applying checkpoint hunks");
      try { return { status: 200, body: parts[2] === "checkpoint-hunks" ? await checkpointHunks(selectedRepo, body) : await applyCheckpointHunks(selectedRepo, body) }; }
      catch (error) { if (error instanceof WorkspaceConflictError) throw new HttpError(409, error.message); throw error; }
    }
    if (parts[2] === "file") {
      const path = typeof body.path === "string" ? body.path : url.searchParams.get("path") ?? "";
      if (req.method === "GET") return { status: 200, body: await readEditableFile(selectedRepo, path) };
      if (req.method === "POST") {
        const busy = manager.list().find((run) => run.status === "running" && (run.repo === selectedRepo || run.worktrees.some((tree) => tree.path === selectedRepo)));
        if (busy) throw new HttpError(409, "Finish or stop the active run before editing its workspace");
        try { return { status: 200, body: await saveEditableFile(selectedRepo, path, body.text, body.expectedHash) }; }
        catch (error) { if (error instanceof WorkspaceConflictError) throw new HttpError(409, error.message); throw error; }
      }
    }
    if (parts[2] === "search" && req.method === "GET") return { status: 200, body: await searchCode(selectedRepo, url.searchParams.get("q") ?? "", url.searchParams.get("mode") === "symbols" ? "symbols" : "text") };
    if (parts[2] === "dependencies" && req.method === "GET") return { status: 200, body: await dependencyGraph(selectedRepo) };
    if (parts[2] === "checkpoints" && req.method === "GET") return { status: 200, body: { head: await resolveCommit(selectedRepo), checkpoints: await checkpoints(selectedRepo, url.searchParams.get("ref") || "HEAD") } };
    if (parts[2] === "apply-checkpoint" && req.method === "POST") {
      const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
      const tree = run?.worktrees.find((tree) => tree.path === selectedRepo);
      if (!run || !tree || run.status === "running") throw new HttpError(409, "Choose an idle run worktree before applying checkpoint files");
      if (!Array.isArray(body.paths) || body.paths.some((path: unknown) => typeof path !== "string")) throw new HttpError(400, "Choose repository paths");
      return { status: 200, body: await applyCheckpoint(selectedRepo, { source: String(body.source ?? ""), paths: body.paths, expectedHead: String(body.expectedHead ?? "") }) };
    }
    if (parts[2] === "context" && req.method === "POST") {
      if (!Array.isArray(body.paths) || body.paths.length > 50) throw new HttpError(400, "Choose at most 50 context files");
      const files = await Promise.all(body.paths.map(async (path: unknown) => {
        if (typeof path !== "string") throw new HttpError(400, "Context paths must be strings");
        if (/(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key))$/.test(path)) return { path, sensitive: true, omitted: "Potential credential file; contents are not included in the inspector." };
        const file = await readEditableFile(selectedRepo, path);
        return { path, bytes: file.bytes, approximateTokens: Math.ceil(file.text.length / 4), preview: redactExport(file.text.slice(0, 3000)), truncated: file.text.length > 3000 };
      }));
      return { status: 200, body: { files, bytes: files.reduce((total, file) => total + (file.bytes ?? 0), 0), approximateTokens: files.reduce((total, file) => total + (file.approximateTokens ?? 0), 0), note: "Token counts are estimates; provider conversations and additional context are not included." } };
    }
  }
  if (parts[1] === "diagnostics" && req.method === "GET") {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const log = await diagnosticTail(join(CODEFLOW_HOME, "server.log"));
    const runs = manager.list();
    return { status: 200, body: redactExport({ version: 1, application: packageJson.version, node: process.version, platform: process.platform, at: Date.now(), busy: manager.busy, writes: writeHealth, runs: { total: runs.length, active: runs.filter((run) => run.status === "running").length, interrupted: runs.filter((run) => run.status === "interrupted").length }, recentErrors: log.slice(-32_000), capabilities: { workspace: true, verificationProfiles: true }, git: repo ? await git(["--version"], repo).then((result) => result.stdout.trim()) : undefined }) };
  }
  throw new HttpError(404, "Unknown workspace operation");
}
