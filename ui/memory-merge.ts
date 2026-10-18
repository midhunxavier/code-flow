import type { MemoryEntry } from "../src/memory.js";

export type MemoryDraft = Pick<MemoryEntry, "title" | "body" | "paths" | "applicability">;
export type MemoryDraftField = keyof MemoryDraft;
export const MEMORY_DRAFT_FIELDS: MemoryDraftField[] = ["title", "body", "paths", "applicability"];

export function memoryDraft(entry: MemoryDraft): MemoryDraft {
  return structuredClone({ title: entry.title, body: entry.body, paths: entry.paths, applicability: entry.applicability });
}

/** Preserve local edits, incorporate independent remote edits, and require a choice on overlap. */
export function mergeMemoryDraft(base: MemoryDraft, draft: MemoryDraft, latest: MemoryDraft): { draft: MemoryDraft; conflicts: MemoryDraftField[] } {
  const merged = memoryDraft(draft);
  const conflicts: MemoryDraftField[] = [];
  for (const field of MEMORY_DRAFT_FIELDS) {
    const before = JSON.stringify(base[field]);
    const local = JSON.stringify(draft[field]);
    const remote = JSON.stringify(latest[field]);
    if (local === before) Object.assign(merged, { [field]: structuredClone(latest[field]) });
    else if (remote !== before && remote !== local) conflicts.push(field);
  }
  return { draft: merged, conflicts };
}

export function resolveMemoryMerge(base: MemoryDraft, draft: MemoryDraft, latest: MemoryDraft, choices: Partial<Record<MemoryDraftField, "draft" | "latest">>): MemoryDraft {
  const merged = mergeMemoryDraft(base, draft, latest);
  for (const field of merged.conflicts) {
    if (!choices[field]) throw new Error(`Choose which ${field} to keep before applying the merge`);
    if (choices[field] === "latest") Object.assign(merged.draft, { [field]: structuredClone(latest[field]) });
  }
  return merged.draft;
}
