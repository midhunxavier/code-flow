/** Human output stays separate from the stable machine-readable MCP contract. */
export function formatStatus(run: any): string {
  const outcomes: Record<string, string> = { plan_ready: "Plan ready", agreed_plan: "Plan agreed", verified_changes: "Changes verified", review_complete: "Review complete", stopped_limit: "Stopped with partial work", blocked: "Needs attention" };
  const lines = [outcomes[run.outcome] ?? (run.paused ? "Paused" : run.status === "waiting_host" ? "Waiting for CLI" : run.status === "waiting_user" ? "Waiting for your answer" : run.status)];
  if (run.detail || run.error) lines.push(run.detail || run.error);
  if (run.evidence?.lastDecision?.approved === false) lines.push(`Last review: changes requested · ${run.evidence.lastDecision.findingCount} blocking finding(s).`);
  for (const p of run.evidence?.participants ?? []) {
    const calls = p.assignments.reduce((n: number, a: any) => n + a.invocations, 0);
    lines.push(`${p.id}: ${p.provider} · ${p.resolved.model ?? "provider default"} · ${p.resolved.effort ?? "default"} effort · ${p.binding === "current_session" ? "CLI session; settings unverified" : `${calls} recorded call${calls === 1 ? "" : "s"}`}`);
  }
  if (run.evidence?.snapshot?.changedFileCount !== undefined) lines.push(`${run.evidence.snapshot.changedFileCount} changed file(s) in the recorded snapshot.`);
  if (run.usage) lines.push(`Allowance: ${run.usage.managedInvocations}/${run.limits.maxInvocations} calls · ${(run.usage.accountedExecutionMs / 60000).toFixed(1)}/${run.limits.maxMinutes} minutes.`);
  for (const q of run.questions ?? []) lines.push(`${q.question}\n${q.options.join(" · ")}`);
  if (run.host?.attachCommand) lines.push(`Reconnect this CLI session: ${run.host.attachCommand}`);
  if (run.host?.reconnect) lines.push(run.host.reconnect);
  if (run.runtimeStatus !== "running" && run.recovery?.preservedWork) lines.push(`Work is preserved. ${run.recovery.nextAction}`);
  if (run.workspace?.url) lines.push(`Open in Code Flow: ${run.workspace.url}`);
  return lines.filter(Boolean).join("\n");
}
