import { selectedTeamConnection, workspaceKey } from "./lib.js";
export interface NewTaskDraft { projectId: string; repository: string; title: string; goal: string; acceptance: string; baseRef: string; owner: string; reviewer: string }
export const taskDraftKey = (viewer: string, project?: string) => workspaceKey(`team-new-draft:${selectedTeamConnection || "local"}:${viewer}:${project ?? "all"}`);
export function readTaskDraft(key: string): NewTaskDraft | null {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? "null"); return value && ["projectId", "repository", "title", "goal", "acceptance", "baseRef", "owner", "reviewer"].every(field => typeof value[field] === "string") ? value : null; } catch { return null; }
}
export function saveTaskDraft(key: string, value: NewTaskDraft | null): boolean {
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); return true; } catch { return false; }
}
