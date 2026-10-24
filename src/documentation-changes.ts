import { git, type GitCwd } from "./git.js";

/** Classify the measured Git diff, never a task's claimed category or file list. */
export async function documentationOnlyChange(repo: GitCwd, base: string, head: string) {
  const [raw, stats] = await Promise.all([
    git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--raw", "-z", base, head, "--"], repo),
    git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, head, "--"], repo),
  ]);
  if (raw.code || stats.code || !raw.stdout || !stats.stdout) return false;
  const entries = raw.stdout.split("\0").filter(Boolean);
  if (entries.length % 2) return false;
  for (let i = 0; i < entries.length; i += 2) {
    const meta = entries[i]!.split(" "), path = entries[i + 1]!;
    if (!["100644", "000000"].includes(meta[0]!.slice(1)) || !["100644", "000000"].includes(meta[1]!)) return false;
    if (!/^(?:docs\/[^\0]+\.(?:md|rst|txt)|(?:README|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|SUPPORT)(?:\.(?:md|rst|txt))?)$/i.test(path)) return false;
    if (path.split("/").some(part => /^(?:AGENTS|CLAUDE|GEMINI)\.md$|^\./i.test(part))) return false;
  }
  return stats.stdout.split("\0").filter(Boolean).every(entry => /^\d+\t\d+\t/.test(entry));
}
