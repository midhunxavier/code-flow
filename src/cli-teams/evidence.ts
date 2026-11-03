import type { Run } from "../engine.js";

/** Recorded dispatch settings are evidence of configuration, not provider attestation. */
export function runEvidence(run: Run) {
  const state = run.cliTeam!, artifacts = Object.values(state.artifacts);
  const snapshot = artifacts.filter(a => a.kind === "code_snapshot").at(-1);
  const result = artifacts.filter(a => a.kind === "result").at(-1);
  const decision = artifacts.filter(a => a.kind === "decision" && typeof a.data.approved === "boolean").at(-1);
  const reviews = decision && Array.isArray(decision.data.reviews) ? decision.data.reviews.map(id => state.artifacts[String(id)]).filter(a => !!a) : [];
  const ref = (a: typeof artifacts[number]) => ({ id: a.id, kind: a.kind, sha256: a.sha256 });
  return {
    result: result ? ref(result) : undefined,
    evidence: {
      source: state.source,
      lastDecision: decision ? { ...ref(decision), approved: decision.data.approved, target: decision.data.target,
        findingCount: reviews.reduce((n, a) => n + (Array.isArray(a.data.findings) ? a.data.findings.length : 0), 0),
        reviews: reviews.map(a => ({ ...ref(a), participant: a.participant, verdict: a.data.verdict })),
        verification: typeof decision.data.verification === "string" ? decision.data.verification : undefined,
      } : undefined,
      participants: state.definition.participants.map(p => ({
        id: p.id, provider: p.provider, binding: p.binding ?? "managed", requested: p.requested,
        resolved: { model: p.model, effort: p.effort },
        settingsEvidence: p.binding === "current_session" ? "host_settings_unverified" : "recorded_dispatch",
        assignments: run.steps.filter(s => s.kind === "agent" && s.role === p.id).map(s => ({
          stepId: s.id, status: s.status, provider: s.agent, model: s.settings?.model, effort: s.settings?.effort,
          invocations: s.invocations ?? 0, sessionId: s.sessionId,
        })),
        hostSubmissions: artifacts.filter(a => a.participant === p.id && (a.kind === "plan" || a.kind === "review") && p.binding === "current_session").length,
      })),
      snapshot: snapshot ? { ...ref(snapshot), head: snapshot.data.head, base: snapshot.data.base,
        changedFiles: Array.isArray(snapshot.data.changedFiles) ? snapshot.data.changedFiles.slice(0, 50) : undefined,
        changedFileCount: snapshot.data.changedFileCount,
        filesTruncated: Array.isArray(snapshot.data.changedFiles) && (snapshot.data.changedFiles.length > 50 || snapshot.data.filesTruncated === true),
        note: "Files belong to this recorded snapshot. Read its artifact for details; later uncommitted edits are not included.",
      } : undefined,
    },
    recovery: { preservedWork: !!snapshot || run.worktrees.length > 0, requiresReview: !!state.recoveryRequired,
      nextAction: run.status === "running" ? "Follow progress or add in-scope guidance." : "Describe what remains. Create a new approach using continueRunId to retain the preserved work; review it before starting.",
      continueRunId: run.id, chatId: state.taskConversation?.chatId },
  };
}
