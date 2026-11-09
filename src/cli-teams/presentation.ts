/** Human output stays separate from the stable machine-readable MCP contract. */
export function formatStatus(run: any): string {
  const outcomes: Record<string, string> = { plan_ready: "Plan ready", agreed_plan: "Plan agreed", verified_changes: "Changes verified", review_complete: "Review complete", stopped_limit: "Stopped with partial work", blocked: "Needs attention" };
  const phases: Record<string, string> = { working: "Working", queued: "Queued for a worker", pausing: "Pause requested", paused: "Paused", waiting_host: "Waiting for CLI", waiting_user: "Waiting for your answer", recovery: "Saved work needs inspection", stopped: "Stopped", cancelled: "Cancelled", completed: "Completed" };
  const lines = [run.task, outcomes[run.outcome] ?? phases[run.progress?.phase] ?? (run.paused ? "Paused" : run.status === "waiting_host" ? "Waiting for CLI" : run.status === "waiting_user" ? "Waiting for your answer" : run.status)];
  if (run.progress) {
    lines.push(run.progress.message);
    for (const step of run.progress.active ?? []) lines.push(`Working: ${step.participant ? `${step.participant} · ` : ""}${step.title}`);
    if (!run.progress.active?.length) for (const step of (run.progress.recent ?? []).slice(-3)) lines.push(`${step.status.replaceAll("_", " ")}: ${step.title}`);
    for (const note of run.progress.guidance ?? []) lines.push(`Guidance ${note.id}: ${deliveryMessage(note.status)}`);
  }
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
  if (run.handoff?.worktree) lines.push(`Worktree: ${run.handoff.worktree}\nBranch: ${run.handoff.branch}`);
  if (run.handoff?.check) lines.push(`Check: ${run.handoff.check.passed ? "passed" : "failed"} · ${run.handoff.check.command}`);
  else if (run.runtimeStatus === "done") lines.push("Checks: no recorded verification for this result.");
  if (run.outcome === "verified_changes") lines.push(`Independent reviews recorded: ${run.handoff?.reviewCount ?? 0}.`, run.handoff?.nextAction);
  if (run.workspace?.url) lines.push(`Open in Code Flow: ${run.workspace.url}`);
  return lines.filter(Boolean).join("\n");
}

export function deliveryMessage(status: string): string {
  return status === "delivered" ? "delivered to a worker" : status === "undelivered" ? "not delivered before work stopped; include it in a continuation" : "saved for the next eligible worker; not yet delivered";
}

/** Text is useful in expanded host tool cards. Machine fields remain in structuredContent. */
export function formatToolResult(name: string, value: any): string {
  if (!value.ok) return `Code Flow: ${value.error.message}\nCode: ${value.error.code}${value.error.nextAction ? `\nNext: ${value.error.nextAction}` : ""}`;
  const d = value.data;
  const link = d.workspace?.url ? `\nOpen in Code Flow: ${d.workspace.url}` : "";
  if (name === "codeflow_get_run" && d.follow) {
    const lines = [`Run: ${d.runId}`];
    const updates = d.follow.updates.map((update: any) => `Completed ${update.kind.replaceAll("_", " ")}${update.participant ? ` from ${update.participant}` : ""}${update.truncated ? " (excerpt)" : ""}:\n${update.excerpt}`);
    if (d.follow.next) {
      if (d.follow.changed) {
        if (updates.length) lines.push(...updates, "Before the next tool call, tell the user what each new output found or recommended. Write it as a visible message in the conversation.");
        lines.push(d.progress.message);
        for (const step of d.progress.active) lines.push(`Active: ${step.participant ? `${step.participant} · ` : ""}${step.title}`);
        if (!updates.length) lines.push("Share meaningful progress in the conversation as an interim update.");
      } else lines.push("No new progress in this wait.");
      lines.push(`Continue monitoring in this turn. Call codeflow_get_run with ${JSON.stringify(d.follow.next)}.`);
    } else {
      lines.push(...updates);
      const result = d.follow.resultPage;
      if (result) {
        lines.push(`${result.nextCursor === undefined ? "Recorded result" : "First page of recorded result"}:\n${result.body}`);
        if (result.nextCursor !== undefined) lines.push(`Read the rest with codeflow_get_artifact using ${JSON.stringify({ runId: d.runId, artifactId: result.id, sha256: result.sha256, cursor: result.nextCursor })}. Follow all pages.`);
        lines.push("Use the recorded artifact to present the result in this turn.");
      }
      lines.push(formatStatus(d));
    }
    return lines.join("\n");
  }
  if (name === "codeflow_get_run") return `${formatStatus(d)}\nRun: ${d.runId} · event cursor: ${d.afterCursor}${d.nextArtifactCursor !== undefined ? ` · next artifact cursor: ${d.nextArtifactCursor}` : ""}`;
  if (name === "codeflow_propose_run") return `${link ? `${link.slice(1)}\n` : ""}Proposal: ${d.proposalId} · revision: ${d.revision}\n${d.summary ?? d.preview}\nHash: ${d.proposalHash}\n${d.nextAction}`;
  if (name === "codeflow_start_run") return `Task started or existing execution recovered.\nRun: ${d.runId}\nContinue in this turn: call codeflow_get_run with ${JSON.stringify(d.follow ?? { runId: d.runId, follow: true })}. Follow progress and deliver the result without waiting for another message.${link}`;
  if (name === "codeflow_list_providers") return [d.connection?.message ?? "Code Flow is connected to this project.", ...(d.providers ?? []).map((p: any) => `${p.id}: ${p.installed ? "CLI found" : "CLI missing"}`), d.connection?.configuration?.message, `Confirmation: ${d.approvalMethod ?? "host dependent"}. Authentication and execution permissions remain unverified.`].filter(Boolean).join("\n");
  if (name === "codeflow_list_runs") return d.runs.length ? d.runs.map((r: any) => `${r.task} · ${r.outcome ?? r.status}\nRun: ${r.runId}`).join("\n\n") + (d.nextCursor !== undefined ? `\nMore tasks: cursor ${d.nextCursor}` : "") : "No Code Flow tasks found in this repository.";
  if (name === "codeflow_get_artifact") return `${d.body}\n\nArtifact: ${d.id} · SHA-256: ${d.sha256}${d.nextCursor !== undefined ? `\nMore content: cursor ${d.nextCursor}; retrieve the remaining pages.` : ""}${d.data?.nextFileCursor !== undefined ? `\nMore files: fileCursor ${d.data.nextFileCursor}.` : ""}`;
  if (name === "codeflow_control_run") return `${d.message ?? (d.pending ? `${d.action === "pause" ? "Pause" : "Cancellation"} requested; active work is settling.` : `${d.action === "resume" ? "Resumed" : d.action === "pause" ? "Paused" : "Cancellation requested"}.`)}\nRun: ${d.runId}${link}`;
  if (name === "codeflow_steer_run") return d.proposalId ? formatToolResult("codeflow_propose_run", value) : `${d.pending ? d.nextAction : d.noteId ? `Guidance ${d.noteId}: ${deliveryMessage(d.delivery)}.` : "Your answer was recorded."}\nRun: ${d.runId}${link}`;
  if (name === "codeflow_open_task") return `${d.opened ? "Opened" : "Available"} in Code Flow: ${d.workspace.url}`;
  if (name === "codeflow_preview_handoff") return `${d.summary}\nPreview hash: ${d.previewHash}\n${d.diff}${d.nextCursor !== undefined ? `\nMore diff: cursor ${d.nextCursor}.` : ""}\n${d.nextAction}`;
  if (name === "codeflow_apply_handoff") return `${d.message}\nRun: ${d.runId}`;
  if (name === "codeflow_submit_step") return `Assignment output saved for run ${d.runId}. Read progress for the next step.${link}`;
  if (name === "codeflow_claim_step") return `Assignment: ${d.assignment.id}\n${d.assignment.instructions}\nUse the exact inputs and private claim token in structuredContent. Do not display the token.`;
  if (name === "codeflow_get_guide") return d.guide;
  if (name === "codeflow_list_models") return (d.models ?? []).map((m: any) => `${m.id ?? m.name}: ${JSON.stringify(m)}`).join("\n") + (d.nextCursor !== undefined ? `\nMore models: cursor ${d.nextCursor}` : "");
  return "Code Flow completed the request. See structuredContent for the result.";
}
