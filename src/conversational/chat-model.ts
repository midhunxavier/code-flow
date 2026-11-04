import type { AgentId } from "../adapters/index.js";
import type { Candidate } from "../cli-teams/model.js";

export type ChatMode = "agent" | "team";
export interface ChatDefaults { mode: ChatMode; provider: AgentId; model?: string; effort?: string; trust: "safe" | "standard" | "trusted" | "full"; tools: boolean; maxCalls?: number; maxMinutes?: number }
export interface ChatAttachment { name: string; data: string }
export interface ChatFile { name: string; sha256: string; bytes: number }
export interface ProjectExecutionDefaults { check?: string; setup?: string; maxCalls?: number; maxMinutes?: number; trust?: "safe" | "standard" | "trusted" | "full" }
export interface ProjectChatContext { defaults?: ProjectExecutionDefaults; project: string; revision: number; instructions: string; files: ChatFile[]; receipts: Record<string, string> }
export interface PinnedProjectContext { defaults?: ProjectExecutionDefaults; revision: number; instructions: string; files: ChatFile[] }
export interface ChatEvent {
  id: string; sequence: number; at: number;
  kind: "user" | "answer" | "receipt" | "task" | "result" | "error";
  body?: string; taskId?: string; runId?: string; mode?: ChatMode;
  proposal?: { id: string; revision: number; hash: string };
  attachments?: ChatFile[];
  artifact?: { id: string; sha256: string; kind: "result"; data: Record<string, unknown> };
  evidence?: { id: string; sha256: string; kind: import("../cli-teams/model.js").Artifact["kind"]; data?: Record<string, unknown> }[];
  projectContext?: { revision: number; files: ChatFile[] };
  errorKind?: string;
}
export interface ChatRecord {
  purpose?: "automation";
  automationDraft?: { request: string };
  scheduledTasks?: Record<string, { mode: ChatMode; provider: AgentId; model?: string; effort?: string }>;
  id: string; version: number; project: string; repo: string; title: string; createdAt: number; updatedAt: number;
  defaults: ChatDefaults; events: ChatEvent[]; taskIds: string[]; agentRuns: string[]; leadRuns: string[];
  leadAllowance: { maxCalls: number; maxMinutes: number };
  source: "head" | "working_changes"; untracked: string[];
  files?: ChatFile[];
  pinned?: boolean; archived?: boolean;
  activeTask?: string;
  pending?: { automation?: true; operationId: string; eventId: string; mode: ChatMode; defaults: ChatDefaults; files?: ChatFile[]; projectContext?: PinnedProjectContext; sourceRunId?: string; continueRunId?: string; runId?: string; targetTask?: string; followUp?: boolean; error?: string; errorCode?: string };
  queue?: NonNullable<ChatRecord["pending"]>[];
  receipts: Record<string, { hash: string; complete?: boolean }>;
  createHash: string;
}
export interface LeadReply {
  kind: "answer" | "clarify" | "guidance" | "proposal";
  body: string;
  target?: "new" | "current";
  candidate?: Candidate;
}
export const CHAT_LEAD_ALLOWANCE = { maxCalls: 12, maxMinutes: 30 };
export const CHAT_OUTCOMES: Record<string, string> = { plan_ready: "Plan ready", agreed_plan: "Plan agreed", verified_changes: "Changes verified", review_complete: "Review completed", stopped_limit: "Stopped with partial work", blocked: "Needs attention" };
