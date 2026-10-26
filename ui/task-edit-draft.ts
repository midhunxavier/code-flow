import { useEffect, useState } from "preact/hooks";
export interface TaskEditDraft { text: string; base: string; stamp: string; revision: number }
/** Rebase only when the field is untouched or the server changed another field. */
export function refreshTaskDraft(draft: TaskEditDraft, text: string, revision: number, stamp = text): TaskEditDraft {
  if (draft.text === draft.base || draft.text === text) return { text, base: text, stamp, revision };
  return stamp === draft.stamp ? { ...draft, revision } : draft;
}
export function useTaskEditDraft(text: string, revision: number, stamp = text) {
  const [draft, setDraft] = useState<TaskEditDraft>({ text, base: text, stamp, revision });
  useEffect(() => { setDraft(old => refreshTaskDraft(old, text, revision, stamp)); }, [text, revision, stamp]);
  return { ...draft, dirty: draft.text !== text, conflict: draft.text !== text && draft.text !== draft.base && stamp !== draft.stamp,
    edit: (value: string) => setDraft(old => ({ ...old, text: value })),
    reset: () => setDraft({ text, base: text, stamp, revision }),
    accepted: () => setDraft(old => ({ ...old, base: old.text })),
  };
}
