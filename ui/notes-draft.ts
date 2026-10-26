import { store } from "./lib.js";

export type NoteBase = { text: string; revision: number };
export type NoteDraft = { v: 1; text: string; baseRevision?: number; baseText?: string };
export function parseNoteDraft(raw: string | null): NoteDraft | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.v === 1 && typeof value.text === "string" && (value.baseRevision === undefined || Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && typeof value.baseText === "string")) return value;
  } catch {}
  // Old drafts were plain text, including text that happens to be valid JSON. Their base is unknown.
  return { v: 1, text: raw };
}
export const readNoteDraft = (key: string) => parseNoteDraft(store.get(`notes-draft:${key}`));
export function writeNoteDraft(key: string, text: string, base?: NoteBase) {
  const draft: NoteDraft = { v: 1, text, ...(base ? { baseRevision: base.revision, baseText: base.text } : {}) };
  store.set(`notes-draft:${key}`, JSON.stringify(draft));
  return draft;
}
export const noteDraftConflicts = (draft: NoteDraft, note: NoteBase) => draft.text !== note.text && (draft.baseRevision !== note.revision || draft.baseText !== note.text);
export const sentence = (text: string) => /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
