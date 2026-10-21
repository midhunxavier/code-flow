import type { AgentId } from "./adapters/index.js";

/** Provider-independent identities and the serializable projection of an Auto team. */
export interface TeamMember {
  id: string;
  name: string;
  role: "coordinator" | "worker" | "reviewer";
  provider: AgentId;
  model: string;
  effort: string;
  reason: string;
  assignment?: import("./model-catalog.js").ModelAssignment;
  status?: "idle" | "working" | "waiting" | "done" | "failed" | "retired";
  checkpoint?: string;
  sessionId?: string;
  worktree?: string;
}

export interface TeamRequirement { id: string; description: string }

export interface TeamTask {
  id: string;
  title: string;
  instructions: string;
  owner: string;
  kind: "implementation" | "investigation";
  dependsOn: string[];
  /** Absent kinds preserve the original completed-artifact dependency semantics. */
  dependencyTypes?: Record<string, "completion" | "artifact" | "knowledge">;
  requirements: string[];
  acceptance: string[];
  paths: string[];
  status?: "pending" | "running" | "needs_info" | "submitted" | "completed" | "failed";
  attempts?: number;
  /** Cumulative attempts before the current explicit resume allocation. */
  allocationStartAttempt?: number;
  checkpoint?: string;
  checkpointOwner?: string;
  /** Explicitly published facts/next actions for a replacement or dependent member. */
  handover?: string;
  artifacts?: string[];
  head?: string;
  worktree?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  waitingSince?: number;
  evidenceRevision?: number;
  evidenceStale?: boolean;
  /** Reused source inputs, never a claim of fresh execution or verification in this run. */
  retainedBaseline?: { sourceRunId: string; sourceRevision: number; sourceTaskHead: string; baseCommit: string };
  /** Measured by Git after a rerun turn, not reported by an agent. Requires fresh final checks/review. */
  noNewDiff?: boolean;
}

export interface TeamSubplan {
  id: string;
  strategy: "investigate-implement" | "implement-verify" | "bounded-repair";
  owner: string;
  requirements: string[];
  acceptance: string[];
  paths: string[];
  dependsOn: string[];
  instructions: string;
}

export interface TeamPlan {
  templateUses?: import("./team-templates.js").TemplateUse[];
  subplans?: TeamSubplan[];
  requirements: TeamRequirement[];
  members: TeamMember[];
  tasks: TeamTask[];
  contracts: string[];
  rationale: string;
}

export interface TeamMessage {
  id: string;
  kind: "question" | "reply" | "message" | "finding" | "contract";
  sender: string;
  recipient: string;
  taskId: string;
  body: string;
  requestId?: string;
  blocking: boolean;
  evidence: string[];
  status: "open" | "answered" | "delivered";
  sourceStepId: string;
  /** Agent data never carries user authorization, even when it quotes a user. */
  origin: "agent" | "user";
  createdAt?: number;
  answeredAt?: number;
  consumedAt?: number;
  sourceAttempt?: number;
  revision?: number;
  deadlineAt?: number;
  originalRecipient?: string;
  /** steering: sent into a running turn, the CLI's acknowledgement still pending; it settles at a later drain. */
  delivery?: { status: "queued" | "context" | "steered" | "steering"; attempt?: number; at?: number };
}

export interface TeamWait {
  requestId: string;
  taskId: string;
  memberId: string;
  attempt: number;
  status: "waiting" | "resolved" | "escalated";
  createdAt: number;
  deadlineAt: number;
  resolvedAt?: number;
  reason?: string;
}
export interface TeamCommandReceipt {
  operationId: string;
  fingerprint: string;
  status: "accepted" | "stale";
  messageId?: string;
  requestId?: string;
  reason?: string;
}
export interface CoordinatorCheckpoint {
  revision: number;
  head: string;
  requirements: TeamRequirement[];
  contracts: string[];
  completed: { id: string; head?: string; artifacts: string[] }[];
  unfinished: { id: string; owner: string; status: string; dependencies: string[]; acceptance: string[]; handover?: string; error?: string }[];
  openDecisions: { id: string; from: string; to: string; body: string }[];
  remainingInvocations: number;
  remainingCoordination: number;
}


export interface TeamContextManifest {
  memberId: string;
  taskId: string;
  attempt: number;
  revision: number;
  inputHead: string;
  messageIds: string[];
  dependencyIds: string[];
  memoryIds: string[];
  checkpoint: boolean;
}

export interface TeamInventory {
  at: number;
  providers: {
    id: AgentId;
    available: boolean;
    blockedReason?: string;
    limitations?: string[];
    quotaKnown: boolean;
    model?: string;
    effort?: string;
    settingsByRole?: Partial<Record<TeamMember["role"], { model?: string; effort?: string; variants?: { model: string; effort?: string }[] }>>;
    /** Catalog choices are usable only where the user's settings do not pin a value. */
    models?: { id: string; efforts?: string[]; aliases?: string[]; documented?: import("./model-research.js").ModelDocumentation; source?: string; verifiedAt?: number; observations?: { successes: number; failures: number } }[];
    catalog?: { revision: number; environment: string; defaultModel?: string; state: "current" | "stale" | "unknown" };
    efforts?: string[];
  }[];
  ranking: AgentId[];
}

export interface TeamMetrics {
  /** Actual launches, including provider retries and structured-output repairs. */
  invocations: number;
  coordinatorInvocations: number;
  questionCount: number;
  blockedTurns: number;
  revisions: number;
  /** Provider token/cost reports remain optional: absence is unknown. */
  coordinatorInputTokens?: number;
  coordinatorOutputTokens?: number;
  coordinatorCacheReadTokens?: number;
  coordinatorCostUsd?: number;
  coordinatorMs?: number;
}

export interface TeamState extends TeamPlan {
  version: 1;
  revision: number;
  scheduler?: "waves" | "event";
  waits?: TeamWait[];
  commandReceipts?: TeamCommandReceipt[];
  coordinatorCheckpoint?: CoordinatorCheckpoint;
  strategyInstances?: { id: string; strategy: string; taskIds: string[]; revision: number }[];
  wave: number;
  status: "planning" | "awaiting_approval" | "running" | "blocked" | "verifying" | "completed";
  invocationLimit: number;
  coordinationLimit: number;
  maxWaves: number;
  maxRepairs: number;
  inventory?: TeamInventory;
  messages: TeamMessage[];
  awaitingRequestId?: string;
  contextManifests: TeamContextManifest[];
  metrics: TeamMetrics;
  gaps: string[];
  reviewFallback?: string;
  verification?: { revision?: number; head: string; check: "passed" | "failing" | "unknown" | "not_required"; reviewed: boolean; approved: boolean; proof?: string };
}
