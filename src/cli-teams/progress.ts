import type { Run } from "../engine.js";

/** Presentation state follows the engine; it never changes execution or implies delivery. */
export function runProgress(run: Run) {
  const state = run.cliTeam!;
  const active = run.steps.filter(s => s.status === "running").map(s => ({ id: s.id, title: s.title.slice(0, 160), participant: s.role }));
  let phase: string, message: string, needsAttention = false;
  if (run.status !== "running") {
    phase = state.recoveryRequired ? "recovery" : run.status === "done" ? "completed" : run.status === "cancelled" ? "cancelled" : "stopped";
    needsAttention = phase !== "completed" && phase !== "cancelled";
    message = phase === "recovery" ? "Saved changes need inspection before a new attempt. The interrupted writer will not restart automatically."
      : phase === "completed" ? "The result is ready. Inspect the deliverable and its evidence."
      : phase === "cancelled" ? "Cancelled. Work has stopped; any completed work is preserved. No answer is needed."
      : "Work stopped. Inspect the partial result and the reason before continuing.";
  } else if (run.pauseRequested) {
    phase = active.length ? "pausing" : "paused";
    message = active.length ? "Pause requested; active work is finishing." : "Paused. Resume when ready.";
  } else if (Object.values(state.questions).some(q => q.answer === undefined)) {
    phase = "waiting_user"; needsAttention = true; message = "Waiting for your answer to the task question below.";
  } else if (Object.values(state.pending).some(p => !p.output)) {
    phase = "waiting_host"; needsAttention = true; message = "Waiting for the assigned CLI session to complete its read-only step.";
  } else if (state.waitingForSlot) {
    phase = "queued"; message = "Waiting for an available worker slot. No action needed from you.";
  } else {
    phase = "working"; message = "Work is continuing. No action needed from you.";
  }
  return { phase, message, needsAttention, active,
    recent: (state.activity ?? []).filter(a => a.type !== "loop" && a.type !== "parallel").slice(-6).map(a => ({ title: a.title.slice(0, 160), participant: a.participant, status: a.status })),
    guidance: run.notes.filter(n => !n.control).slice(-5).map(n => ({ id: n.id, status: n.status, deliveredTo: n.deliveredTo ? { participant: n.deliveredTo.agent, midTurn: n.deliveredTo.midTurn === true } : undefined })),
  };
}
