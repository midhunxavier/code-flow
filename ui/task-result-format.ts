/** Recognize only the execution engine's stopped-result envelope; keep other output unchanged. */
export function stoppedResult(body: string) {
  const prefix = "Stopped: completion requirements were not met.\n";
  if (!body.startsWith(prefix)) return undefined;
  const text = body.slice(prefix.length);
  const preserved = /\n\nLatest preserved deliverable \(([^\n)]+)\):\n/.exec(text);
  const reason = (preserved ? text.slice(0, preserved.index) : text).trim();
  const deliverable = preserved ? text.slice(preserved.index + preserved[0].length).trim() : undefined;
  const markers = [...reason.matchAll(/^Reviewer: ([^;\n]+); target: ([^;\n]+); verdict: ([^\n]+)\n/gm)];
  const reviews = markers.map((match, i) => ({
    reviewer: match[1]!, target: match[2]!, verdict: match[3]!.trim(),
    body: reason.slice(match.index! + match[0].length, markers[i + 1]?.index ?? reason.length).trim(),
  }));
  const snapshot = deliverable && /^Code snapshot ([a-f0-9]{7,64})\nBranch: ([^\n]+)\nWorktree: ([^\n]+)\nReview diff: ([\s\S]+)$/.exec(deliverable);
  return {
    reason: markers.length ? reason.slice(0, markers[0]!.index).trim() : reason,
    reviews, deliverable, artifactId: preserved?.[1],
    snapshot: snapshot ? { commit: snapshot[1]!, branch: snapshot[2]!, worktree: snapshot[3]!, diff: snapshot[4]! } : undefined,
  };
}
