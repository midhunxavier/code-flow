import { git, resolveCommit } from "./git.js";

// The GitLab/Bitbucket review workflow that fetched PR code has been removed. Repositories can still
// hold its imports, so ordinary runs keep refusing those commits.
const LEGACY = "refs/heads/codeflow/external/";
const CODE_HOST_PROVENANCE = "refs/codeflow/untrusted-code/";
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
  if (!refs.length) return false;
  const { commits, anchor } = await legacyImportedHistory(repo, refs);
  // Make the finding durable: once marked, deleting or renaming the legacy branches cannot launder their commits.
  if (commits.length) {
    const marked = await git(["update-ref", "--stdin"], repo, { input: commits.map(commit => `update ${CODE_HOST_PROVENANCE}${commit} ${anchor}\n`).join("") });
    if (marked.code) throw new Error("Cannot retain imported code provenance");
  }
  return commits.includes(head);
}

/** Existing local trust; application preview/provenance refs grant none. */
async function trustedCodeHostCommits(repo: string): Promise<string[]> {
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
