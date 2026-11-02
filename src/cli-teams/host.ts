import type { TeamContext } from "../engine.js";
import type { PendingAssignment } from "./model.js";

type HostHandler = (ctx: TeamContext, request: PendingAssignment) => Promise<NonNullable<PendingAssignment["output"]>>;
type DecisionHandler = (ctx: TeamContext, id: string, question: string, options: string[], inputs?: string[]) => Promise<string>;
let host: HostHandler | undefined, decide: DecisionHandler | undefined;
export function registerHostHandlers(handler: HostHandler, decision: DecisionHandler) { host = handler; decide = decision; }
export function runHostStep(ctx: TeamContext, request: PendingAssignment) {
  if (!host) throw new Error("CLI host service is unavailable; reconnect to the local owner");
  return host(ctx, request);
}
export function userDecision(ctx: TeamContext, id: string, question: string, options: string[], inputs?: string[]) {
  if (!decide) throw new Error("CLI decision service is unavailable");
  return decide(ctx, id, question, options, inputs);
}
