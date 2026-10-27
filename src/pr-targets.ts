/** Keep likely targets prominent without removing valid stacked-PR bases. */
export function groupPrTargets(branches: readonly string[], initial: string, defaultBranch?: string, ownBranch?: string, knownRuns: ReadonlySet<string> = new Set()) {
  const available = [...new Set(branches)].filter(branch => branch !== ownBranch);
  const preferred = [...new Set([initial, defaultBranch].filter((branch): branch is string => !!branch && available.includes(branch)))];
  const other = available.filter(branch => !preferred.includes(branch)).sort((a, b) => a.localeCompare(b));
  const isRun = (branch: string) => branch.startsWith("codeflow/") || knownRuns.has(branch);
  const normal = [...preferred, ...other.filter(branch => !isRun(branch))];
  const runBranches = other.filter(isRun);
  return { initial: preferred[0] ?? normal[0] ?? runBranches[0] ?? "", defaultBranch, branches: normal, runBranches };
}
