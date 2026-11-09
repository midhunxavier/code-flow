import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type GitCwd } from "../git.js";
import { digest, fail } from "./model.js";

export interface SourceSnapshot { base: string; commit: string; fingerprint: string; source: "head" | "working_changes"; untracked: string[]; unborn?: true; /** Original user snapshot before any retained task implementation. */ handoffBase?: string }
const snapshotIdentity = { GIT_AUTHOR_NAME: "Code Flow", GIT_AUTHOR_EMAIL: "codeflow@localhost", GIT_COMMITTER_NAME: "Code Flow", GIT_COMMITTER_EMAIL: "codeflow@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
async function checked(repo: GitCwd, args: string[], env?: NodeJS.ProcessEnv) {
  const r = await git(args, repo, { env });
  if (r.code) fail("snapshot_failed", `Git snapshot failed: ${r.stderr.slice(0, 1000)}`);
  return r.stdout.trim();
}
/** A separate index captures working files without touching the user's index or checkout. */
export async function captureSource(repo: GitCwd, source: SourceSnapshot["source"], untracked: string[] = []): Promise<SourceSnapshot> {
  const head = await git(["rev-parse", "--verify", "HEAD"], repo);
  const unborn = head.code !== 0;
  if (unborn && (await git(["symbolic-ref", "HEAD"], repo)).code !== 0) fail("snapshot_failed", "Repair this repository's HEAD before preparing work");
  // An object-only empty base supports a new Git repository without changing HEAD or its index.
  const base = unborn ? await checked(repo, ["commit-tree", await checked(repo, ["mktree"]), "-m", "Code Flow empty initial source"], snapshotIdentity) : head.stdout.trim();
  if (source === "head") return { base, commit: base, fingerprint: digest({ base }), source, untracked: [], ...(unborn ? { unborn: true as const } : {}) };
  if (untracked.length > 100 || untracked.some(p => !p || p.startsWith("/") || p.split(/[\\/]/).includes("..") || p.includes("\0"))) fail("validation_failed", "Choose at most 100 repository-relative untracked paths");
  const listed = (await git(["ls-files", "--others", "--exclude-standard", "-z"], repo)).stdout.split("\0").filter(Boolean);
  // A selected folder stands for the untracked, non-ignored files inside it.
  const matches = (p: string) => { const path = p.replace(/[\\/]+$/, ""); return listed.includes(path) ? [path] : listed.filter(f => f.startsWith(`${path}/`)); };
  const missing = untracked.filter(p => !matches(p).length);
  if (missing.length) fail("validation_failed", `Not an untracked, non-ignored file or folder: ${missing.join(", ")}. ${listed.length ? `Untracked files: ${listed.slice(0, 20).join(", ")}${listed.length > 20 ? ` and ${listed.length - 20} more` : ""}` : "This checkout has no untracked files."}`);
  untracked = [...new Set(untracked.flatMap(matches))];
  if (untracked.length > 100) fail("validation_failed", `The selected folders contain ${untracked.length} untracked files; choose at most 100`);
  const scratch = await mkdtemp(join(tmpdir(), "codeflow-cli-snapshot-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    const index = await checked(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    try { await copyFile(index, env.GIT_INDEX_FILE); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await checked(repo, ["read-tree", base], env); }
    // Rebuild the scratch index from its staged tree so copied stat-cache
    // entries cannot hide a same-size edit made in the same timestamp interval.
    const stagedTree = await checked(repo, ["write-tree"], env);
    await rm(env.GIT_INDEX_FILE, { force: true });
    await checked(repo, ["read-tree", stagedTree], env);
    await checked(repo, ["add", "-u", "--", "."], env);
    if (untracked.length) await checked(repo, ["--literal-pathspecs", "add", "--", ...untracked], env);
    const tree = await checked(repo, ["write-tree"], env);
    const staged = await checked(repo, ["ls-files", "--stage", "-z"]);
    const fingerprint = digest({ base, tree, staged, untracked: [...untracked].sort() });
    const commit = await checked(repo, ["commit-tree", tree, "-p", base, "-m", "Code Flow accepted source snapshot"], snapshotIdentity);
    const latest = await git(["rev-parse", "--verify", "HEAD"], repo);
    if (unborn ? latest.code === 0 : latest.code !== 0 || base !== latest.stdout.trim()) fail("snapshot_stale", "Repository HEAD changed during capture; refresh the proposal");
    return { base, commit, fingerprint, source, untracked, ...(unborn ? { unborn: true as const } : {}) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
