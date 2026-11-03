import type { RunSummary } from "../engine.js";

/** Only new chat automations opt into quiet success; historical workflow inbox rules stay intact. */
export function chatAutomationAttention(run: RunSummary): "decision" | "failure" | "findings" | "changes" | "quiet" | undefined {
  if (!run.trigger || run.cliTeam?.taskConversation?.phase !== "execution") return;
  if (run.awaiting || Object.values(run.cliTeam.questions ?? {}).some(q => !q.answer)) return "decision";
  if (["failed", "interrupted", "stopped"].includes(run.status) || ["blocked", "stopped_limit"].includes(run.cliTeam.outcome ?? "")) return "failure";
  if (run.status !== "done") return;
  const reviews = Object.values(run.cliTeam.artifacts ?? {}).filter(a => a.kind === "review");
  if (reviews.some(a => a.data.verdict === "changes_requested" || Array.isArray(a.data.findings) && a.data.findings.length)) return "findings";
  if (run.cliTeam.outcome === "verified_changes" || run.artifacts?.some(a => a.stat?.trim())) return "changes";
  return "quiet";
}
