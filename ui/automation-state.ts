import { signal } from "@preact/signals";
import { sharedGet } from "./lib.js";
import { projects } from "./state.js";
import type { Schedule } from "../src/schedule-rules.js";
import type { AutomationStorageStatus } from "../src/automation.js";

/** Explicit records stay in their chosen project; only legacy records infer unique ownership. */
export const automationProject = (run: { project?: string; repo: string }) =>
  run.project ? projects.value.find(p => p.id === run.project) : projects.value.filter(p => p.repos.includes(run.repo)).length === 1 ? projects.value.find(p => p.repos.includes(run.repo)) : undefined;

export interface Automation {
  target?: { kind: "project-team"; teamId: string };
  id: string;
  name: string;
  enabled: boolean;
  revision?: number;
  run: { repo: string; project?: string; pattern: string; task: string; roles: Record<string, string[]> };
  schedule?: Schedule;
  scheduleText: string;
  webhook: boolean;
  token: string;
  hookPath: string;
  isolate: boolean;
  image?: string;
  nextAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastError?: string;
  /** A recurring sweep: lists this kind of work and starts runs for new items. */
  sweep?: { kind: "issues" | "dependabot" | "alerts"; max: number };
  handled?: string[];
  /** Webhook events waiting for the running run to end. */
  queued?: unknown[];
}

export const automations = signal<Automation[]>([]);
export const automationStorage = signal<AutomationStorageStatus | undefined>(undefined);
export const automationLoadError = signal("");
export async function loadAutomations() {
  try {
    const [records, storage] = await Promise.all([sharedGet<Automation[]>("/api/automations"), sharedGet<AutomationStorageStatus>("/api/automations/storage")]);
    automations.value = records; automationStorage.value = storage; automationLoadError.value = "";
  } catch (error) { automationLoadError.value = (error as Error).message; }
}
