import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { api } from "./lib.js";
import { Icon } from "./icons.js";
import { improveSettings } from "./improve-settings.js";
import { IMPROVE_NAMES, type ImproveMode } from "../src/improve-settings.js";

/** A rewrite is a draft suggestion, never a submitted message or execution approval. */
export function ChatPromptImprove({ text, repo, disabled, onApply }: { text: string; repo: string; disabled: boolean; onApply: (text: string) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState<ImproveMode>(improveSettings.value.defaultMode);
  const [result, setResult] = useState<{ prompt: string; summary: string }>();
  const [undo, setUndo] = useState<{ before: string; after: string; repo: string }>();
  const request = useRef<AbortController>(), original = useRef({ text, repo });
  const close = () => { request.current?.abort(); request.current = undefined; setBusy(false); setOpen(false); };
  const dialog = useDialog(open, close);
  useEffect(() => { close(); setResult(undefined); }, [text, repo, disabled]);
  useEffect(() => () => request.current?.abort(), []);
  async function improve() {
    if (request.current || disabled || !repo || !text.trim()) return;
    original.current = { text, repo }; setOpen(true); setBusy(true); setResult(undefined); setError("");
    const controller = new AbortController(); request.current = controller;
    try {
      const value = await api<{ prompt: string; summary: string }>("/api/improve-prompt", { method: "POST", signal: controller.signal, body: JSON.stringify({ text, repo, mode, execution: "local", settings: improveSettings.value }) });
      if (controller.signal.aborted || request.current !== controller) return;
      if (!value.prompt?.trim() || value.prompt.length > 12000) throw new Error("The rewrite does not fit this message. Your original draft is unchanged; try a shorter prompt.");
      setResult(value);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false); } }
  }
  const canUndo = undo?.after === text && undo.repo === repo;
  return <>
    {text.trim() ? <button type="button" class="btn ghost small chat-improve" aria-label="Improve prompt" title={!repo ? "Choose a repository to use prompt improvement" : "Review a clearer, structured rewrite before sending"} disabled={disabled || !repo} onClick={() => void improve()}><Icon name="sparkle"/><span>Improve</span></button> : null}
    {canUndo ? <button type="button" class="btn ghost small" onClick={() => { onApply(undo!.before); setUndo(undefined); }}>Undo rewrite</button> : null}
    <dialog class="chat-improve-dialog" ref={dialog} aria-labelledby="chat-improve-title">
      <header><div><h2 id="chat-improve-title">Improve your prompt</h2><p class="help">Clarify the goal, requirements and completion criteria while preserving your intent.</p></div><button type="button" class="icon-btn" aria-label="Close prompt improvement" onClick={close}><Icon name="close"/></button></header>
      <div class="chat-improve-options"><label>Context<select class="field" value={mode} disabled={busy} onChange={e => { setMode(e.currentTarget.value as ImproveMode); setResult(undefined); }}><option value="quick">Text only · Quick</option><option value="repo">Committed repository · Repo</option></select></label><span class="help">{IMPROVE_NAMES[improveSettings.value.agent]} · <a href="#/settings/agents" onClick={close}>Rewrite settings</a></span></div>
      <p class="help">{mode === "quick" ? "Uses your draft text only." : "Reads a private snapshot of committed files; local edits are excluded."} Uses your configured local provider. This does not send your message or start the task.</p>
      {busy ? <p role="status">Improving your prompt…</p> : null}
      {result ? <><p class="help">{result.summary}</p><label>Suggested prompt<textarea class="field" rows={12} maxLength={12000} value={result.prompt} onInput={e => setResult({ ...result, prompt: e.currentTarget.value })}/></label></> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      <details><summary>Your original prompt</summary><pre>{original.current.text}</pre></details>
      <footer><button type="button" class="btn" onClick={close}>{busy ? "Cancel rewrite" : "Keep original"}</button>{!busy && !result ? <button type="button" class="btn primary" onClick={() => void improve()}>Try rewrite</button> : null}{result ? <button type="button" class="btn primary" disabled={disabled || !result.prompt.trim() || original.current.text !== text || original.current.repo !== repo} onClick={() => { const after = result.prompt; setUndo({ before: text, after, repo }); close(); onApply(after); }}>Use this prompt</button> : null}</footer>
    </dialog>
  </>;
}
