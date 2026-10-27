import { git, resolveCommit } from "./git.js";

export const CODE_HOST_IMPORTS = "refs/codeflow/external/";
const LEGACY = "refs/heads/codeflow/external/";
export const CODE_HOST_PROVENANCE = "refs/codeflow/untrusted-code/";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Provenance outlives preview refs: selecting the same imported head by SHA must not bypass isolation. */
export async function isCodeHostImport(repo: string, ref: string): Promise<boolean> {
  if (/^(?:refs\/heads\/|refs\/)?codeflow\/external\//.test(ref)) return true;
  const head = await resolveCommit(repo, ref).catch(() => undefined);
  if (!head) return false; // The normal base-branch validator supplies the friendly missing-ref error.
  const marked = await git(["show-ref", "--verify", "--quiet", `${CODE_HOST_PROVENANCE}${head}`], repo);
  if (marked.code === 0) return true;
  if (marked.code !== 1) throw new Error("Cannot inspect imported code provenance");
  // Older builds left ordinary branches behind, including across a server restart.
  const legacy = await git(["for-each-ref", "--format=%(refname) %(objectname)", LEGACY], repo);
  if (legacy.code) throw new Error("Cannot inspect legacy code-host imports");
  const refs = legacy.stdout.split("\n").filter(Boolean).map(line => line.split(" "));
  if (refs.length) return (await legacyImportedHistory(repo, refs)).commits.includes(head);
  return false;
}

/** Pin existing local trust before importing any object; application preview/provenance refs grant none. */
export async function trustedCodeHostCommits(repo: string): Promise<string[]> {
  const listed = await git(["for-each-ref", "--count=4097", "--format=%(refname) %(objecttype) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"], repo);
  if (listed.code) throw new Error("Cannot inspect existing repository history before code-host import");
  const refs = listed.stdout.split("\n").filter(Boolean).map(line => line.split(" "));
  if (refs.length > 4096) throw new Error("Code-host import exceeds the 4,096 local-ref inspection limit");
  const provenance = await git(["for-each-ref", "--format=%(refname)", CODE_HOST_PROVENANCE], repo);
  if (provenance.code) throw new Error("Cannot inspect existing imported code provenance");
  const untrusted = new Set(provenance.stdout.split("\n").filter(Boolean).map(ref => ref.slice(CODE_HOST_PROVENANCE.length)));
  for (const [ref, , head] of refs) if (ref?.startsWith(LEGACY) && ref.endsWith("/source") && head) untrusted.add(head);
  const trusted = new Set<string>();
  for (const [ref, type, object] of refs) {
    if (!ref || ref.startsWith(LEGACY)) continue;
    const head = type === "commit" ? object : type === "tag" ? await resolveCommit(repo, ref).catch(() => undefined) : undefined;
    if (head && SHA.test(head) && !untrusted.has(head)) trusted.add(head);
  }
  const head = await resolveCommit(repo, "HEAD").catch(() => undefined);
  if (head && !untrusted.has(head)) trusted.add(head);
  return [...trusted];
}

/** Old imports lack a pre-fetch trust snapshot. Preserve existing ordinary history while marking
 * both remote histories; an old target alias cannot be distinguished from a pre-existing ref. */
async function legacyImportedHistory(repo: string, refs: string[][]): Promise<{ commits: string[]; anchor?: string }> {
  const tips = refs.filter(([ref, head]) => ref?.startsWith(LEGACY) && head && SHA.test(head)).map(([, head]) => head!);
  if (!tips.length) return { commits: [] };
  const trusted = await trustedCodeHostCommits(repo);
  const history = await git(["rev-list", "--max-count=1001", "--stdin"], repo, { input: [...tips, ...trusted.map(head => `^${head}`)].join("\n") + "\n" });
  if (history.code) throw new Error("Cannot inspect legacy imported history");
  const commits = history.stdout.trim().split("\n").filter(Boolean);
  if (commits.length > 1000 || commits.some(commit => !SHA.test(commit))) throw new Error("Legacy code-host history exceeds the 1,000-commit import limit; retain its refs for inspection");
  return { commits, anchor: trusted[0] ?? tips[0] };
}

export async function removeCodeHostImport(repo: string, imported: { branch: string; into: string }): Promise<void> {
  for (const ref of [imported.branch, imported.into]) {
    if (!ref.startsWith(CODE_HOST_IMPORTS)) throw new Error("Refusing to remove a non-preview ref");
    const removed = await git(["update-ref", "-d", ref], repo);
    if (removed.code) throw new Error("Cannot remove expired code-host preview refs");
  }
}

/** Called once per repository after restart; no preview survives a service restart. */
export async function clearOrphanedCodeHostImports(repo: string): Promise<void> {
  const listed = await git(["for-each-ref", "--format=%(refname) %(objectname)", CODE_HOST_IMPORTS, LEGACY], repo);
  if (listed.code) throw new Error("Cannot inspect code-host preview refs");
  const refs = listed.stdout.split("\n").filter(Boolean).map(line => line.split(" "));
  // Record both legacy source and target histories before dropping ordinary branch names.
  const { commits, anchor } = await legacyImportedHistory(repo, refs);
  if (commits.length) {
    const marked = await git(["update-ref", "--stdin"], repo, { input: commits.map(commit => `update ${CODE_HOST_PROVENANCE}${commit} ${anchor}\n`).join("") });
    if (marked.code) throw new Error("Cannot retain imported code provenance");
  }
  const worktrees = await git(["worktree", "list", "--porcelain", "-z"], repo);
  if (worktrees.code) throw new Error("Cannot inspect checkouts before cleaning legacy imports");
  const checkedOut = new Set(worktrees.stdout.split("\0").filter(line => line.startsWith("branch ")).map(line => line.slice(7)));
  for (const [ref] of refs) {
    if (!ref || checkedOut.has(ref)) continue;
    const removed = await git(["update-ref", "-d", ref], repo);
    if (removed.code) throw new Error("Cannot remove orphaned code-host preview refs");
  }
}
