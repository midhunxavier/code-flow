import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { api, post, enc } from "./lib.js";
import { Icon } from "./icons.js";
import type { ChatAttachment, ChatFile } from "../src/conversational/chat-model.js";
type Defaults = import("../src/conversational/chat-model.js").ProjectExecutionDefaults;
type Context = { defaults?: Defaults; project: string; revision: number; instructions: string; files: ChatFile[] };
export function ProjectContextEditor({ project, repo, open, onClose }: { project: string; repo: string; open: boolean; onClose: () => void }) {
  const [context, setContext] = useState<Context>(), [instructions, setInstructions] = useState(""), [attachments, setAttachments] = useState<ChatAttachment[]>([]), [remove, setRemove] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [defaults, setDefaults] = useState<Defaults>({});
  const dialog = useDialog(open, onClose), fileInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ fingerprint: string; body: object }>();
  useEffect(() => {
    if (!open || !project || !repo) return;
    const controller = new AbortController(); setContext(undefined); setError(""); setAttachments([]); setRemove([]); attempt.current = undefined;
    void api<Context>(`/api/chats/context?project=${enc(project)}&repo=${enc(repo)}`, { signal: controller.signal }).then(c => { setContext(c); setInstructions(c.instructions); setDefaults(c.defaults ?? {}); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [project, repo, open]);
  async function attach(files: FileList | null) {
    try {
      if (!files?.length) return;
      const added: ChatAttachment[] = [];
      if (attachments.length + files.length > 10) throw new Error("Attach up to ten project files.");
      for (const file of Array.from(files)) {
        if (file.size > 1024 * 1024) throw new Error("Project files must be no larger than 1 MB each.");
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
        added.push({ name: file.name, data });
      }
      setAttachments(old => [...old.filter(f => !added.some(a => a.name === f.name)), ...added]);
    } catch (e) { setError((e as Error).message); }
  }
  async function save() {
    if (!context || busy) return; setBusy(true); setError("");
    const value = { project, repo, expectedRevision: context.revision, instructions, defaults, attachments, remove }, fingerprint = JSON.stringify(value);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, body: { ...value, operationId: crypto.randomUUID() } };
    try { await post("/api/chats/context", attempt.current.body); attempt.current = undefined; onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <dialog class="chat-context-dialog" ref={dialog} aria-labelledby="project-context-title"><header><div><p class="task-kicker">Shared across future messages in this project</p><h2 id="project-context-title">Project context</h2></div><button type="button" class="icon-btn" aria-label="Close project context" onClick={onClose}><Icon name="close"/></button></header>
    {!project || !repo ? <p>Choose a project and repository to manage shared context.</p> : !context && !error ? <p role="status">Loading project context…</p> : context ? <form onSubmit={e => { e.preventDefault(); void save(); }}><label>Project instructions<textarea class="field" rows={8} maxLength={6000} value={instructions} onInput={e => setInstructions(e.currentTarget.value)} placeholder="Conventions, constraints and background for this project…"/></label><p class="help">Only messages sent after saving use this revision. Queued turns and accepted tasks keep their pinned context.</p><h3>Optional task defaults</h3><p class="help">New messages pin these values. Explicit task instructions take precedence; Team approaches show resolved settings before execution.</p>{(["check", "setup"] as const).map(key => <label>{key === "check" ? "Check command" : "Setup command"}<input class="field" value={defaults[key] ?? ""} maxLength={4000} onInput={e => setDefaults({ ...defaults, [key]: e.currentTarget.value })}/></label>)}<div class="task-target-grid"><label>Managed calls<input class="field" type="number" min="1" max="256" value={defaults.maxCalls ?? ""} placeholder="12" onInput={e => setDefaults({ ...defaults, maxCalls: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })}/></label><label>Execution minutes<input class="field" type="number" min="1" max="720" value={defaults.maxMinutes ?? ""} placeholder="30" onInput={e => setDefaults({ ...defaults, maxMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : undefined })}/></label></div><label>Agent permission default<select class="field" value={defaults.trust ?? "standard"} onChange={e => setDefaults({ ...defaults, trust: e.currentTarget.value as Defaults["trust"] })}><option value="safe">Read only</option><option value="standard">Standard</option><option value="trusted">Trusted</option><option value="full">Full access</option></select></label><p class="help">Agent mode uses its composer permission setting. Team workers use the reviewed managed policy.</p><h3>Project files</h3><p class="help">Shared background files. Message attachments stay in their own chat. Combined context supports ten files and 4 MB.</p>{context.files.filter(f => !remove.includes(f.sha256)).map(f => <div class="chat-context-file" key={f.sha256}><span>{f.name} · {(f.bytes / 1024).toFixed(1)} KB</span><button class="btn ghost small" type="button" onClick={() => setRemove([...remove, f.sha256])}>Remove</button></div>)}{attachments.map(f => <div class="chat-context-file" key={f.name}><span>{f.name} · New</span><button class="btn ghost small" type="button" onClick={() => setAttachments(attachments.filter(a => a !== f))}>Remove</button></div>)}<input type="file" multiple hidden ref={fileInput} aria-label="Attach project files" onChange={e => { void attach(e.currentTarget.files); e.currentTarget.value = ""; }}/><button class="btn small" type="button" onClick={() => fileInput.current?.click()}><Icon name="attach"/>Add project files</button><div class="task-actions"><span class="help">Current revision {context.revision}</span><button type="submit" class="btn primary" disabled={busy}>{busy ? "Saving…" : "Save project context"}</button></div></form> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}</dialog>;
}
