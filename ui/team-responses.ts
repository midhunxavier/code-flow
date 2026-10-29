import type { AgentEvent, Step } from "./types.js";

export interface TeamResponse { id: string; title: string; body: string; source: string; stepId?: string }

/** One current public submission per task. Earlier attempts remain in Team details. */
export function latestWorkerSteps(steps: Step[]): Step[] {
  const tasks = new Set<string>();
  return [...steps].reverse().filter(step => {
    if (step.kind && step.kind !== "agent" || step.status === "running") return false;
    try {
      const result = JSON.parse(step.finalText ?? "null");
      if (typeof result?.taskId !== "string" || tasks.has(result.taskId)) return false;
      tasks.add(result.taskId);
      return true;
    } catch { return false; }
  }).reverse();
}

/** Recover omitted deliverables into the answer, without repeating older attempts or the lead. */
export function inlineTeamResponses(steps: Step[], transcripts: Map<string, AgentEvent[]>, answer = ""): TeamResponse[] {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  let shown = normalize(answer);
  return latestWorkerSteps(steps).flatMap(step => {
    // A tail page can start in the middle of a streamed message. Only a complete
    // public snapshot is safe to present as the written response.
    const messages = (transcripts.get(step.id) ?? []).filter((event): event is Extract<AgentEvent, { kind: "text" }> => event.kind === "text" && !event.delta && event.phase !== "commentary" && !!event.text.trim()).filter(event => {
      try { return typeof JSON.parse(event.text)?.taskId !== "string"; } catch { return true; }
    });
    const prose = messages.at(-1);
    const result = JSON.parse(step.finalText!);
    const responses: TeamResponse[] = prose ? [{ id: `${step.id}:answer`, title: "", body: prose.text, source: step.title }] : teamResponses([step]);
    if (!responses.length && typeof result.handover === "string" && result.handover.trim()) responses.push({ id: `${step.id}:handover`, title: "", body: result.handover, source: step.title });
    return responses.filter(response => {
      const body = normalize(response.body);
      if (shown.includes(body)) return false;
      shown += ` ${body}`;
      return true;
    }).map(response => ({ ...response, stepId: step.id }));
  });
}
/** Response artifacts are drafts, not claims that a review or check passed. */
export function teamResponses(steps: Step[], transcripts: Map<string, AgentEvent[]> = new Map()): TeamResponse[] {
  const responses: TeamResponse[] = [];
  for (const step of steps) {
    if (!step.finalText || step.kind && step.kind !== "agent") continue;
    let result: { taskId?: string; findings?: { title?: string; body?: string }[] };
    try { result = JSON.parse(step.finalText); } catch { continue; }
    if (!result || typeof result.taskId !== "string") continue;
    const messages = new Map<string, string>();
    for (const [index, event] of (transcripts.get(step.id) ?? []).entries()) {
      if (event.kind !== "text" || !event.text.trim()) continue;
      const key = event.messageId ?? String(index);
      messages.set(key, event.delta ? (messages.get(key) ?? "") + event.text : event.text);
    }
    // Keep the worker's prose as well as its structured handoff. A complete proposal may
    // be in either, and a later handoff can omit an earlier response artifact.
    for (const [id, body] of messages) {
      if (body.trim() === step.finalText.trim()) continue;
      if (messages.size > 1 && body.length < 1000) continue;
      const heading = body.match(/^#{1,2}\s+(.+)$/m)?.[1];
      responses.push({ id: `${step.id}:message:${id}`, title: heading ?? "Worker response", body, source: step.title });
    }
    if (Array.isArray(result.findings)) for (const [index, finding] of result.findings.entries()) {
      if (typeof finding?.title !== "string" || typeof finding.body !== "string" || !finding.body.trim()) continue;
      responses.push({ id: `${step.id}:finding:${index}`, title: finding.title, body: finding.body, source: step.title });
    }
  }
  return responses.reverse();
}
