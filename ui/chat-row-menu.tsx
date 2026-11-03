import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { Menu, MenuItem } from "./panel-bits.js";
import { Icon } from "./icons.js";
import { api, post, enc, showError, showToast } from "./lib.js";
import { refreshChats } from "./chat-state.js";
import type { ChatSummary, ChatSnapshot } from "../src/conversational/chats.js";

export function ChatRowMenu({ chat }: { chat: ChatSummary }) {
  const [rename, setRename] = useState(false), [title, setTitle] = useState(chat.title), [busy, setBusy] = useState(false);
  const dialog = useDialog(rename, () => setRename(false));
  async function organize(value: object) {
    if (busy) return; setBusy(true);
    try {
      const current = await api<ChatSnapshot>(`/api/chats/${enc(chat.id)}`);
      const body = { action: "organize", operationId: crypto.randomUUID(), expectedVersion: current.chat.version, ...value };
      try { await post(`/api/chats/${enc(chat.id)}/actions`, body); } catch (e) { if (e instanceof TypeError) await post(`/api/chats/${enc(chat.id)}/actions`, body); else throw e; }
      setRename(false); await refreshChats(); showToast("Chat updated");
    } catch (e) { showError((e as Error).message); } finally { setBusy(false); }
  }
  if (chat.id.startsWith("task-")) return null;
  return <><Menu label={`Chat options for ${chat.title}`} icon="more" class="chat-row-menu">{close => <>
    <MenuItem disabled={busy} onClick={() => { close(); setTitle(chat.title); setRename(true); }}>Rename</MenuItem>
    <MenuItem disabled={busy} onClick={() => { close(); void organize({ pinned: !chat.pinned }); }}>{chat.pinned ? "Unpin" : "Pin"}</MenuItem>
    <MenuItem disabled={busy} onClick={() => { close(); void organize({ archived: !chat.archived }); }}>{chat.archived ? "Restore chat" : "Archive chat"}</MenuItem>
  </>}</Menu><dialog class="chat-rename-dialog" ref={dialog} aria-label="Rename chat"><form onSubmit={e => { e.preventDefault(); void organize({ title: title.trim() }); }}><h2>Rename chat</h2><label>Chat title<input autoFocus class="field" value={title} maxLength={90} onInput={e => setTitle(e.currentTarget.value)}/></label><div class="task-actions"><button type="button" class="btn" onClick={() => setRename(false)}>Cancel</button><button type="submit" class="btn primary" disabled={busy || !title.trim()}>Save</button></div></form></dialog></>;
}
