import { useEffect, useRef, useState } from "preact/hooks";
import type { Attachment } from "./types.js";
import { workspaceKey } from "./lib.js";
import { ProjectDraftStore } from "./project-context.js";
import { reconcileSnapshots } from "./browser-context.js";
export interface MessageDraft { text: string; images: Attachment[] }
const storage = new ProjectDraftStore<MessageDraft>(workspaceKey("message-draft-v1:"), undefined, value => {
  if (!value || typeof value.text !== "string" || !Array.isArray(value.images) || value.images.some(image => !image || typeof image.name !== "string" || typeof image.data !== "string" || typeof image.size !== "number")) throw new Error("Invalid saved message draft");
});
const empty = (): MessageDraft => ({ text: "", images: [] });
const listeners = new Set<(key: string) => void>();
const channel = typeof document !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(workspaceKey("message-drafts")) : undefined;
channel?.addEventListener("message", event => { if (typeof event.data === "string") for (const listener of listeners) listener(event.data); });
export async function readMessageDraft(id: string, legacySessionKey?: string): Promise<MessageDraft> {
  const value = await storage.read(id); if (value) return { ...value, text: reconcileSnapshots(value.text, value.images) };
  let text = ""; try { text = legacySessionKey ? sessionStorage.getItem(legacySessionKey) ?? "" : ""; } catch {}
  const migrated = { text: reconcileSnapshots(text, []), images: [] };
  // A migration write failure must not hide the legacy text that was read successfully.
  if (text) await storage.write(id, migrated).catch(() => {});
  return migrated;
}
export async function writeMessageDraft(id: string, value: MessageDraft) { await storage.write(id, value); channel?.postMessage(id); }
/** Hydration precedes taking queued pins; text and images persist together, including a successful send's empty draft. */
export function useMessageDraft(id: string, legacySessionKey?: string) {
  const [draft, setDraft] = useState<MessageDraft>(empty), [readyId, setReadyId] = useState(""), [warning, setWarning] = useState("");
  const current = useRef(draft), active = useRef(id); active.current = id;
  useEffect(() => {
    let alive = true; setReadyId(""); setWarning("");
    readMessageDraft(id, legacySessionKey).then(value => { if (!alive) return; current.current = value; setDraft(value); setReadyId(id); if (storage.unsavedKeys.includes(id)) setWarning("This message could not be saved for reload. Keep this tab open until you send it."); }, () => { if (alive) { current.current = empty(); setDraft(current.current); setReadyId(id); setWarning("The saved message draft could not be read. Its stored data was retained; new edits remain in this tab."); } });
    const changed = (key: string) => { if (key === id) setWarning("Another tab updated this saved draft. Your local draft is kept. Reload to restore the latest saved version."); }; listeners.add(changed);
    return () => { alive = false; listeners.delete(changed); };
  }, [id]);
  const update = (patch: Partial<MessageDraft>) => {
    const value = { ...current.current, ...patch }; current.current = value; setDraft(value);
    void writeMessageDraft(id, value).then(() => { if (active.current === id) setWarning(""); }, () => { if (active.current === id) setWarning("This message could not be saved for reload. Keep this tab open until you send it."); });
  };
  return { ...draft, ready: readyId === id, warning,
    setText: (next: string | ((value: string) => string)) => update({ text: typeof next === "function" ? next(current.current.text) : next }),
    setImages: (next: Attachment[] | ((value: Attachment[]) => Attachment[])) => update({ images: typeof next === "function" ? next(current.current.images) : next }),
  };
}
