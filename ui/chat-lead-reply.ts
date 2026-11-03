/** Presentation only. Execution and approval always use the validated chat proposal. */
export interface LeadStepView { title: string; detail?: string; children: LeadStepView[] }
export interface LeadReplyView {
  kind: string; body: string; scope?: string; source?: string;
  participants: { id: string; provider: string; model?: string; effort?: string }[];
  completion: string[]; steps: LeadStepView[]; check?: string; setup?: string;
  calls?: number; minutes?: number;
}
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const human = (value: unknown, fallback: string) => string(value)?.replaceAll("_", " ") ?? fallback;
function steps(value: unknown, depth = 0): LeadStepView[] {
  if (!Array.isArray(value) || depth > 8) return [];
  return value.slice(0, 100).flatMap(raw => {
    const node = object(raw); if (!node) return [];
    const children = (v: unknown) => steps(v, depth + 1);
    switch (node.type) {
      case "task": return [{ title: `${string(node.participant) ? `${node.participant} · ` : ""}${human(node.operation, "Task")}`, detail: string(node.instructions), children: [] }];
      case "parallel": return [{ title: "Independent work in parallel", children: children(node.tasks) }];
      case "loop": return [{ title: `Up to ${positive(node.maxIterations) ?? "the approved number of"} review passes`, children: children(node.steps) }];
      case "gate": return [{ title: node.policy === "agreement" ? "Require agreement on the same plan" : "Require passing checks and the requested approvals", children: [] }];
      case "user_decision": return [{ title: "Your approval", detail: string(node.question), children: [] }];
      case "finish": return [{ title: `Deliver ${human(node.outcome, "the result")}`, children: [] }];
      case "join": return [{ title: "Combine the results", children: [] }];
      default: return [];
    }
  });
}
export function chatLeadReply(text: string): LeadReplyView | undefined {
  let value: unknown; try { value = JSON.parse(text); } catch { return; }
  const reply = object(value);
  if (!reply || !["answer", "clarify", "guidance", "proposal"].includes(String(reply.kind)) || typeof reply.body !== "string" || !reply.body.trim()) return;
  const candidate = reply.kind === "proposal" ? object(reply.candidate) : undefined, limits = object(candidate?.limits);
  return {
    kind: String(reply.kind), body: reply.body,
    scope: string(candidate?.scope), source: string(candidate?.source),
    participants: Array.isArray(candidate?.participants) ? candidate.participants.flatMap(raw => {
      const p = object(raw); return p && typeof p.id === "string" && typeof p.provider === "string" ? [{ id: p.id, provider: p.provider, model: string(p.model), effort: string(p.effort) }] : [];
    }) : [],
    completion: strings(candidate?.completion), steps: steps(candidate?.steps),
    check: string(candidate?.check), setup: string(candidate?.setup), calls: positive(limits?.maxInvocations), minutes: positive(limits?.maxMinutes),
  };
}

export function chatLeadReplyLabel(text: string): string {
  const reply = chatLeadReply(text);
  return reply?.kind === "proposal" ? "Approach ready" : reply?.kind === "clarify" ? "Needs input" : "Reply ready";
}
