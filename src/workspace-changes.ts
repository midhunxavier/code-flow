import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, resolveCommit, withRepoLock, type GitCwd } from "./git.js";
import { normalizeRepoPath } from "./repo-tree.js";
import { readEditableFile, WorkspaceConflictError } from "./workspace.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_TEXT = 512 * 1024;

/** Compute a three-way text merge without touching the repository or losing either draft. */
export async function mergeFileDraft(repo: GitCwd, path: string, base: string, draft: string) {
  if ([base, draft].some((value) => typeof value !== "string" || Buffer.byteLength(value) > MAX_TEXT || value.includes("\0"))) throw new Error("Merge drafts must be text under 512 KB");
  const current = await readEditableFile(repo, path);
  const folder = await mkdtemp(join(tmpdir(), "codeflow-file-merge-"));
  try {
    await Promise.all([["current", current.text], ["base", base], ["draft", draft]].map(([name, text]) => writeFile(join(folder, name!), text!, { mode: 0o600, flag: "wx" })));
    const merged = await git(["merge-file", "--stdout", "--diff3", "-L", "Current file", "-L", "Loaded base", "-L", "Your draft", "current", "base", "draft"], folder, { timeoutMs: 10000 });
    // git merge-file returns the number of conflicts (capped at 127), negative/system errors use 255.
    if (merged.code < 0 || merged.code > 127 || merged.timedOut || merged.aborted || merged.stderr.trim()) throw new Error(merged.stderr.trim() || "Cannot merge the file drafts");
    return { current, text: merged.stdout, conflicts: merged.code, clean: merged.code === 0 };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

export interface CheckpointHunk { id: string; header: string; patch: string }
export interface CheckpointHunks { head: string; source: string; path: string; hunks: CheckpointHunk[]; patchHeader: string }

/** Hunk IDs refer to server-generated patches at pinned commits, never caller-authored patches. */
export async function checkpointHunks(repo: GitCwd, input: { source: string; path: string }): Promise<CheckpointHunks> {
  const path = normalizeRepoPath(input.path);
  if (!path || path.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error("Choose a regular repository file outside .git");
  await readEditableFile(repo, path); // rejects links and binary/oversized files in the current checkout
  const [head, source] = await Promise.all([resolveCommit(repo), resolveCommit(repo, input.source)]);
  const modes = await Promise.all([head, source].map((ref) => git(["--literal-pathspecs", "ls-tree", "-z", ref, "--", path], repo)));
  if (modes.some((result) => result.code || !/^100(?:644|755) blob /.test(result.stdout))) throw new Error("Hunks support existing regular text files. Apply added, deleted, renamed or binary files as complete files instead.");
  const diff = await git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", head, source, "--", path], repo);
  if (diff.code) throw new Error(diff.stderr.trim() || "Cannot compare the checkpoint file");
  if (diff.stdout.length > 2 * 1024 * 1024 || /^(?:Binary files |GIT binary patch)/m.test(diff.stdout)) throw new Error("The patch is binary or too large for selective hunks");
  const first = diff.stdout.search(/^@@ /m);
  if (first < 0) return { head, source, path, patchHeader: "", hunks: [] };
  const patchHeader = diff.stdout.slice(0, first).replace(/^index .*\n/m, "");
  const chunks = diff.stdout.slice(first).split(/(?=^@@ )/m).filter(Boolean);
  if (chunks.length > 200) throw new Error("This file has too many hunks; apply the complete file instead");
  return { head, source, path, patchHeader, hunks: chunks.map((patch) => ({ id: digest(`${head}\0${source}\0${path}\0${patch}`), header: patch.split("\n")[0]!, patch })) };
}

/** Apply selected hunks to a clean, unchanged result checkout, leaving them unstaged for review. */
export async function applyCheckpointHunks(repo: GitCwd, input: { source: string; path: string; expectedHead: string; hunks: string[] }) {
  if (!Array.isArray(input.hunks) || input.hunks.length < 1 || input.hunks.length > 200 || input.hunks.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || new Set(input.hunks).size !== input.hunks.length) throw new Error("Choose 1–200 distinct checkpoint hunks");
  return withRepoLock(typeof repo === "string" ? repo : repo.path, async () => {
    const head = await resolveCommit(repo);
    if (head !== input.expectedHead) throw new WorkspaceConflictError(head, "The worktree HEAD changed since these hunks were compared. Compare hunks again.");
    const status = await git(["status", "--porcelain"], repo);
    if (status.code || status.stdout.trim()) throw new Error("Commit or save existing changes before applying checkpoint hunks");
    const preview = await checkpointHunks(repo, input);
    const chosen = preview.hunks.filter((hunk) => input.hunks.includes(hunk.id));
    if (chosen.length !== input.hunks.length) throw new Error("The checkpoint hunks changed. Refresh the comparison before applying");
    const patch = preview.patchHeader + chosen.map((hunk) => hunk.patch).join("");
    const checked = await git(["apply", "--check", "--whitespace=nowarn", "-"], repo, { input: patch });
    if (checked.code) throw new Error(checked.stderr.trim() || "The selected hunks cannot be applied safely");
    const applied = await git(["apply", "--whitespace=nowarn", "-"], repo, { input: patch });
    if (applied.code) throw new Error(applied.stderr.trim() || "Cannot apply the selected hunks");
    return { head: preview.head, source: preview.source, path: preview.path, hunks: input.hunks, staged: false };
  });
}
