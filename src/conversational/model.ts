import type { Candidate, Participant } from "../cli-teams/model.js";
export interface TaskMessage {
    id: string;
    role: "user" | "system";
    body: string;
    at: number;
    noteId?: string;
    runId?: string;
    kind?: "status";
}
export interface TaskConversation {
    id: string;
    version: number;
    project: string;
    repo: string;
    createdAt: number;
    updatedAt: number;
    request: string;
    source: "head" | "working_changes";
    untracked: string[];
    coordinator: Participant;
    chatId?: string;
    contextNotes?: string;
    sourceRunId?: string;
    attachments?: { name: string; data: string }[];
    messages: TaskMessage[];
    preparation: {
        maxCalls: number;
        maxMinutes: number;
        runs: string[];
        active?: string;
        processed: string[];
    };
    proposals: string[];
    executions: string[];
    changes: string[];
    question?: {
        question: string;
        options: string[];
    };
    error?: string;
    continuation?: string;
    receipts: Record<string, {
        hash: string;
        completed?: boolean;
    }>;
    createHash: string;
    draftCandidate?: Candidate;
    approaches?: {
        id: string;
        revision: number;
        hash: string;
        scope: Candidate["scope"];
        at: number;
    }[];
}
export interface PrepareResult {
    kind: "proposal" | "question";
    candidate?: Candidate;
    question?: {
        question: string;
        options: string[];
    };
}
export const PREPARATION_LIMITS = { maxCalls: 3, maxMinutes: 5 };
export const TASK_LIMITS = { maxInvocations: 12, maxMinutes: 30, concurrency: 2, maxAttempts: 2 };
