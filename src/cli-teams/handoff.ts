import type { Run } from "../engine.js";
import { isFolderMirror } from "../folders.js";
import { git } from "../git.js";
import { digest, fail } from "./model.js";

export function handoffBase(run: Run, find: (id: string) => Run | undefined): string {
  const seen = new Set<string>();
  while (!run.cliTeam!.source.handoffBase && run.parentRunId) {
    if (seen.has(run.id)) fail("recovery_required", "The continuation history contains a cycle; inspect the preserved work manually.");
    seen.add(run.id);
    const parent = find(run.parentRunId);
    if (!parent?.cliTeam || parent.repo !== run.repo) fail("recovery_required", "The original task source is unavailable. Inspect the retained changes before applying them manually.");
    run = parent;
  }
  return run.cliTeam!.source.handoffBase ?? run.cliTeam!.source.commit;
}

/** Applies a pinned task delta, not the user's pre-existing source snapshot. */
export async function prepareHandoff(run: Run, find: (id: string) => Run | undefined) {
  const state = run.cliTeam!;
  if (isFolderMirror(run.repo)) fail("handoff_unavailable", "This task worked on a copy of a folder. Applying results back to the folder isn't available yet; inspect the preserved work instead.");
  if (run.status !== "done" || state.outcome !== "verified_changes") fail("handoff_unavailable", "Finish verification before applying changes. Inspect or continue the preserved work first.");
  const artifacts = Object.values(state.artifacts), result = artifacts.filter(a => a.kind === "result").at(-1);
  const target = result && state.artifacts[String(result.data.primary)];
  if (!target || target.kind !== "code_snapshot" || typeof target.data.head !== "string") fail("artifact_stale", "The completed result has no exact code snapshot.");
  const source = handoffBase(run, find), head = target.data.head;
  const checked = async (args: string[]) => {
    const r = await git(args, run.repo);
    if (r.code) fail("handoff_unavailable", `Cannot inspect the handoff: ${r.stderr.slice(0, 800)}`);
    return r.stdout;
  };
  const targetHead = (await checked(["rev-parse", "--verify", "HEAD"])).trim();
  const branch = (await checked(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  const status = await checked(["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = await checked(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", source, head, "--"]);
  const stat = await checked(["diff", "--stat", "--no-ext-diff", "--no-textconv", source, head, "--"]);
  // --index checks the index and checkout together. No --3way/--reject: preflight cannot leave conflicts.
  const check = !status && diff ? await git(["apply", "--check", "--index"], run.repo, { input: diff }) : undefined;
  const ready = !status && !!diff && check?.code === 0;
  const reason = status ? "The checkout has local or untracked changes. Commit or move them before applying."
    : !diff ? "This task has no new changes to apply."
    : check?.code ? "The task changes do not apply cleanly to this checkout. Resolve the source difference in a continuation first." : undefined;
  const previewHash = digest({ runId: run.id, source, head, targetHead, branch, patch: digest(diff), status });
  const summary = [`Bring task changes into ${branch}`, `Source: ${source}\nResult: ${head}\nCheckout: ${targetHead}`, stat.trim() || "No changed files.",
    "Apply and stage only this task's changes. No commit or push is created.",
    "Checks and reviews describe the recorded result. Rerun checks in this checkout after application.", reason].filter(Boolean).join("\n");
  return { runId: run.id, source, head, targetHead, branch, previewHash, ready, reason, summary, diff,
    nextAction: ready ? `Review the diff, then request codeflow_apply_handoff for this preview. Terminal: codeflow apply ${run.id}` : reason! };
}

export function handoffPage(p: Awaited<ReturnType<typeof prepareHandoff>>, cursor = 0, maxBytes = 12000) {
  const bytes = Buffer.from(p.diff);
  if (cursor > bytes.length || cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80) fail("validation_failed", "Invalid UTF-8 diff cursor");
  let end = Math.min(bytes.length, cursor + maxBytes);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { ...p, diff: bytes.subarray(cursor, end).toString("utf8"), totalBytes: bytes.length, nextCursor: end < bytes.length ? end : undefined };
}
