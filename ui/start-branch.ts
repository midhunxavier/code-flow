export function startBranchLabel(source: { kind: string; number: number; headRefName?: string } | null, selected: string, current?: string | null): string {
  return source?.kind === "pr" ? `PR #${source.number}${source.headRefName ? ` · ${source.headRefName}` : "'s branch"}` : selected || current || "HEAD";
}
