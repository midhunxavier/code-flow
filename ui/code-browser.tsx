import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, enc, post, showToast } from "./lib.js";
import { FileTree, addContext } from "./composer.js";
import { repo, route, sideDraft, setSideChat, openSide } from "./state.js";
import { loadFileDraft, retainFileDraft } from "./file-drafts.js";
import { downloadArtifact } from "./workbench.js";
import { ChangeImpact } from "./change-impact.js";
import type { CodeHit } from "../src/workspace.js";
import type { SymbolHit } from "../src/code-intelligence.js";
interface Editable { path: string; text: string; hash: string; bytes: number; folder?: string }

/** Key by folder at the call site: drafts and responses never cross repository scopes. */
export function CodeBrowser({ folder, initialPath, onClose }: { folder: string; initialPath?: string; onClose?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [paths, setPaths] = useState("");
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("text");
  const [hits, setHits] = useState<(CodeHit & Partial<SymbolHit>)[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const [file, setFile] = useState<Editable | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [draftRecovery, setDraftRecovery] = useState("");
  const [mergeNote, setMergeNote] = useState("");
  const [mergeConflict, setMergeConflict] = useState(false);
  useLayoutEffect(() => { if (file?.folder === folder) setDraftRecovery(retainFileDraft(folder, file, draft, mergeConflict)); }, [folder, file, mergeConflict]);
  useEffect(() => {
    if (!file || draft === file.text) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [file, draft]);
  const loadFile = (path: string) => perform(async () => {
    const loaded = { ...await api<Editable>(`/api/workspace/file?repo=${enc(folder)}&path=${enc(path)}`), folder };
    const retained = loadFileDraft(folder, loaded.path);
    setMergeConflict(retained?.mergeConflict === true);
    setFile(retained ? { ...loaded, text: retained.text, hash: retained.hash } : loaded); setDraft(retained?.draft ?? loaded.text); setConflict(!!retained && retained.hash !== loaded.hash); setPreview(false); setMergeNote("");
    if (retained) showToast("Recovered your unsaved draft for this tab. Review it before saving.", 5000);
  });
  const refreshForMerge = () => perform(async () => {
    if (!file) return;
    const merged = await post<{ current: Editable; text: string; conflicts: number; clean: boolean }>("/api/workspace/merge-file", { repo: folder, path: file.path, base: file.text, draft });
    setFile({ ...merged.current, folder }); setDraft(merged.text); setConflict(false); setPreview(true);
    setMergeConflict(!merged.clean);
    setMergeNote(merged.clean ? "Independent edits merged. Review the result before saving." : `${merged.conflicts} overlapping change(s). Edit the marked sections to preserve the intended result, then remove every conflict marker before saving.`);
  });
  const save = () => perform(async () => {
    if (!file) return;
    try {
      const saved = await post<{ hash: string; bytes: number }>("/api/workspace/file", { repo: folder, path: file.path, text: draft, expectedHash: file.hash });
      setFile({ ...file, ...saved, text: draft }); setMergeConflict(false); setPreview(false); showToast("File saved");
    } catch (error) { setConflict(true); throw error; }
  });

  const requestedPath = useRef<string>();
  useEffect(() => {
    if (!initialPath) { requestedPath.current = undefined; return; }
    if (!busy && requestedPath.current !== initialPath) { requestedPath.current = initialPath; void loadFile(initialPath); }
  }, [initialPath, busy]);
  return <section class="code-browser" aria-label="Code browser">
    <p class="help code-scope">Editing scope: <code>{folder || "Choose a repository"}</code></p>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p role="status">Working…</p> : null}
    <details open={!file}><summary>Browse files</summary><FileTree root={folder} onOpen={(path) => { if (!busy) void loadFile(path); }} /></details>
    {file ? <div class="settings-actions"><button class="btn small" onClick={() => { setFile(null); onClose?.(); }}>Back to the files</button>{route.value.view === "composer" && folder === repo.value ? <button class="btn small" onClick={() => addContext({ path: file.path, type: "file" })}>+ Task</button> : null}<button class="btn small" onClick={() => { sideDraft.value = `About ${file.path}: `; setSideChat(null); openSide("chat"); }}>Ask about this file</button></div> : null}
      <h2>Search and edit</h2><div class="wb-row"><select class="field" aria-label="Code search mode" value={mode} onChange={(event) => setMode(event.currentTarget.value)}><option value="text">Text</option><option value="symbols">Declarations</option><option value="semantic">JavaScript/TypeScript symbols</option></select><input class="field" aria-label="Search code" disabled={!folder || busy} placeholder={mode === "symbols" ? "Function, class, or variable" : "Search file contents"} value={query} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void perform(async () => { const result = await api<{ hits: CodeHit[]; scanned: number; truncated: boolean }>(`/api/workspace/search?repo=${enc(folder)}&q=${enc(query)}&mode=${mode}`); setHits(result.hits); setSearchNote(`${result.scanned} files inspected${result.truncated ? " · results limited; narrow your query" : ""}`); }); }} /><button class="btn" disabled={!folder || busy} onClick={() => perform(async () => { const result = await api<{ hits: CodeHit[]; scanned: number; truncated: boolean }>(`/api/workspace/search?repo=${enc(folder)}&q=${enc(query)}&mode=${mode}`); setHits(result.hits); setSearchNote(`${result.scanned} files inspected${result.truncated ? " · results limited" : ""}`); })}>Search</button></div>
      <p class="help">Declaration search recognizes common forms in several languages. JavaScript/TypeScript symbols and references use an isolated TypeScript language service over bounded saved repository files; external libraries and compiler plugins are excluded.</p>{searchNote ? <p class="help">{searchNote}</p> : null}
      <div class="wb-hits">{hits.map((hit) => <p key={`${hit.path}:${hit.line}`}><button class="btn ghost wb-path" onClick={() => loadFile(hit.path)}>{hit.path}:{hit.line} {hit.symbol ?? ""}</button><code>{hit.text}</code>{hit.column ? <button class="btn small" disabled={busy} onClick={() => perform(async () => { const result = await api<{hits:SymbolHit[];scanned:number;truncated:boolean;note:string}>(`/api/workspace/references?repo=${enc(folder)}&path=${enc(hit.path)}&line=${hit.line}&column=${hit.column}`); setHits(result.hits); setSearchNote(`${result.hits.length} references in ${result.scanned} saved source files${result.truncated ? " · results limited" : ""}. ${result.note}`); })}>Find references to {hit.symbol ?? `${hit.path}:${hit.line}`}</button> : null}</p>)}</div>
      <div class="wb-row"><input class="field" aria-label="File to edit" disabled={!folder || busy} placeholder="Repository-relative file path" value={paths} onInput={(event) => setPaths(event.currentTarget.value)} /><button class="btn" disabled={busy || !folder || !paths.trim()} onClick={() => loadFile(paths.trim())}>Open file</button></div>
      {file ? <><h3>{file.path}</h3><textarea class="field wb-editor" aria-label="File contents" spellcheck={false} disabled={busy} value={draft} onInput={(event) => { const value = event.currentTarget.value; setDraft(value); if (file.folder === folder) setDraftRecovery(retainFileDraft(folder, file, value, mergeConflict)); }} />{mergeNote ? <p class="at-notice" role="status">{mergeNote}</p> : null}<div class="wb-row"><button class="btn" onClick={() => setPreview(!preview)}>{preview ? "Hide comparison" : "Preview changes"}</button><button class="btn primary" disabled={busy || conflict || draft === file.text || mergeConflict && /^(?:<<<<<<< |=======$|>>>>>>> |\|\|\|\|\|\|\| )/m.test(draft)} onClick={save}>Save file</button>{conflict ? <button class="btn" onClick={refreshForMerge}>Load current version and keep draft</button> : null}<button class="btn" onClick={() => downloadArtifact(file.path.split("/").pop() ?? "draft.txt", draft, "text/plain")}>Export draft</button></div>{preview ? <div class="wb-diff"><div><h4>Current file</h4><pre>{file.text}</pre></div><div><h4>Your draft</h4><pre>{draft}</pre></div></div> : null}<p class="help">Saving checks the loaded version and preserves concurrent edits. Files in active run worktrees cannot be edited here. {draftRecovery === "sensitive" ? "This credential filename is excluded from browser draft recovery; export your draft before leaving." : draftRecovery === "full" ? "Browser draft storage is unavailable; export your draft before leaving." : "Unsaved drafts can be recovered in this browser tab for 24 hours."}</p></> : null}

{file ? <ChangeImpact key={file.path} folder={folder} paths={[file.path]} refreshKey={file.hash} /> : null}
</section>;
}
