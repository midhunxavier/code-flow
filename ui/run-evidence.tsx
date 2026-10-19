import type { RunSummary } from "./types.js";
import { executionLabel, checksLabel, agentReviewLabel } from "./run-experience.js";

export function RunEvidence({ run, checking = false, branch }: { run: RunSummary; checking?: boolean; branch?: string }) {
  const checks = checksLabel(run, checking, branch);
  const humanRecorded = branch ? !!run.humanReview?.[branch] : Object.keys(run.humanReview ?? {}).length > 0;
  return <dl class="run-evidence" aria-label="Run status and evidence">
    <div><dt>Execution</dt><dd>{executionLabel(run)}</dd></div>
    <div><dt>Checks</dt><dd class={checks === "Passed" ? "evidence-ok" : ["Failed", "Blocked"].includes(checks) ? "evidence-warn" : ""}>{checks}</dd></div>
    <div><dt>Agent review</dt><dd>{agentReviewLabel(run, branch)}</dd></div>
    <div><dt>Human review</dt><dd>{humanRecorded ? "Recorded · see file coverage" : "Not recorded"}</dd></div>
  </dl>;
}

export function VerificationEvidence({ run }: { run: RunSummary }) {
  return <details class="verify-profile"><summary>Verification evidence{run.verification ? ` · ${run.verification.checks.length} checks` : ""}</summary>
    <p class="help">Evidence belongs to the recorded run and commit. Review coverage and merge validation check the current branch separately.</p>
    {run.checkCantRun ? <p class="msg warn">{run.checkCantRun.command}: {run.checkCantRun.reason}</p> : null}
    {run.lastCheck ? <p>Last check: <code>{run.lastCheck.command}</code> · {run.lastCheck.ok ? "Passed" : "Failed"} · {new Date(run.lastCheck.at).toLocaleString()}</p> : <p class="help">No check result recorded.</p>}
    {run.verification ? <>
      {run.verification.branch ? <p class="help">Checked branch <code>{run.verification.branch}</code></p> : null}
      {run.verification.head ? <p class="help">Commit <code>{run.verification.head.slice(0, 12)}</code></p> : null}
      <ul>{run.verification.checks.map(gate => <li key={gate.check.id}>{gate.check.title ?? gate.check.id}: {gate.diagnosis}{gate.check.required ? " (required)" : ""}{gate.reason ? ` · ${gate.reason}` : ""}</li>)}</ul>
      {run.verification.skipped.map(gate => <p class="help" key={gate.check.id}>Skipped {gate.check.title ?? gate.check.id}: {gate.reason}</p>)}
      {run.verification.risk ? <p>Change risk: {run.verification.risk.level} · {run.verification.risk.reasons.join("; ") || "No configured sensitive-path rule matched."}</p> : null}
      {run.verification.requirements?.length ? <ul>{run.verification.requirements.map(requirement => <li key={requirement.id}>{requirement.covered ? "Covered" : "Uncovered"}: {requirement.description}{requirement.missing.length ? ` · missing ${requirement.missing.join(", ")}` : ""}</li>)}</ul> : null}
    </> : null}
  </details>;
}
