import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, baseName, enc, fmtSize, post, showToast } from "./lib.js";
import { Icon } from "./icons.js";
import { FileTree, addContext } from "./composer.js";
import { repo, route, sideDraft, setSideChat, openSide } from "./state.js";
import { loadFileDraft, retainFileDraft } from "./file-drafts.js";
import { downloadArtifact } from "./workbench.js";
import { ChangeImpact } from "./change-impact.js";
import type { FileContent } from "./types.js";
import type { CodeHit } from "../src/workspace.js";
import type { SymbolHit } from "../src/code-intelligence.js";
interface Editable { path: string; text: string; hash: string; bytes: number; folder?: string }

/** Key by folder at the call site: drafts and responses never cross repository scopes. */
export function CodeBrowser({ folder, initialPath, onClose, compact = false }: { folder: string; initialPath?: string; onClose?: () => void; compact?: boolean }) {
  const [panelMode,setPanelMode] = useState<"files"|"search">("files");
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
  const [readOnly, setReadOnly] = useState<(FileContent & { reason: string }) | null>(null);
  const selectedPath = file?.path ?? readOnly?.path;
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
    let loaded: Editable;
    try { loaded = { ...await api<Editable>(`/api/workspace/file?repo=${enc(folder)}&path=${enc(path)}`), folder }; }
    catch (error) {
      // The viewer caps reads at 512 KB and identifies binary content. It also applies
      // repository access policy, so this fallback cannot bypass a denied read.
      const preview = await api<FileContent>(`/api/file?repo=${enc(folder)}&path=${enc(path)}`);
      setFile(null); setReadOnly({ ...preview, reason: (error as Error).message });
      return;
    }
    setReadOnly(null);
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
  const search = () => perform(async () => {
    const result = await api<{hits:CodeHit[];scanned:number;truncated:boolean}>(`/api/workspace/search?repo=${enc(folder)}&q=${enc(query)}&mode=${mode}`);
    setHits(result.hits); setSearchNote(`${result.scanned} files inspected${result.truncated ? " · results limited; narrow your query" : ""}`);
  });
  const back = () => { setFile(null); setReadOnly(null); onClose?.(); };
  return <section class={`code-browser ${compact ? "compact-files" : ""} ${selectedPath ? "file-open" : ""}`} aria-label="Code browser">
    {compact ? <header class="files-heading">
      {selectedPath ? <button class="btn ghost small" aria-label="Back to the files" onClick={back}>← {panelMode === "search" ? "Search" : "Files"}</button> : <div class="segmented small" role="group" aria-label="File explorer view"><button aria-pressed={panelMode === "files"} onClick={() => setPanelMode("files")}>Files</button><button aria-pressed={panelMode === "search"} onClick={() => setPanelMode("search")}><Icon name="search" />Search</button></div>}
      <span class="files-location" title={folder}>{baseName(folder)}</span>
      {file && draft !== file.text ? <span class="badge">Unsaved</span> : null}
    </header> : <p class="help code-scope">Editing scope: <code>{folder || "Choose a repository"}</code></p>}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {busy ? <p class="help files-progress" role="status">Working…</p> : null}
    {compact ? <div key="explorer" class="files-explorer" hidden={!!selectedPath || panelMode !== "files"}><FileTree root={folder} onOpen={path => {if(!busy) void loadFile(path);}} /></div> : <details open={!selectedPath}><summary>Browse files</summary><FileTree root={folder} onOpen={path => {if(!busy) void loadFile(path);}} /></details>}
    {selectedPath ? <div key="actions" class="files-actions settings-actions">
      {!compact ? <button class="btn small" onClick={back}>Back to the files</button> : null}
      {route.value.view === "composer" && folder === repo.value ? <button class="btn small" onClick={() => addContext({path:selectedPath,type:"file"})}>+ Task</button> : null}
      <button class="btn small ghost" onClick={() => {sideDraft.value=`About ${selectedPath}: `;setSideChat(null);openSide("chat");}}><Icon name="chat" />Ask about this file</button>
    </div> : null}
    {readOnly ? <section aria-label="Read-only file preview"><h3 class="file-title" title={readOnly.path}>{readOnly.path}</h3><p class="help">Read-only · {fmtSize(readOnly.size)}</p><details><summary>Preview details</summary><p class="help">{readOnly.reason}</p></details>{readOnly.binary ? <p>This is a binary file.</p> : <pre class="file-view" tabIndex={0}>{readOnly.text?.split("\n").slice(0,5000).join("\n")}</pre>}{readOnly.truncated || (readOnly.text?.split("\n").length ?? 0) > 5000 ? <p class="help">Showing a bounded preview; the rest of the file is omitted.</p> : null}</section> : null}
    <div key="search" class="files-search-tools" hidden={compact && (!!selectedPath || panelMode !== "search")}>
      {!compact ? <h2>Search and edit</h2> : null}
      <form class="wb-row" onSubmit={event => {event.preventDefault();void search();}}>
        <select class="field" aria-label="Code search mode" value={mode} onChange={event => setMode(event.currentTarget.value)}><option value="text">Text</option><option value="symbols">Declarations</option><option value="semantic">JavaScript/TypeScript symbols</option></select>
        <input class="field" aria-label="Search code" disabled={!folder || busy} placeholder={mode === "symbols" ? "Function, class, or variable" : "Search file contents"} value={query} onInput={event => setQuery(event.currentTarget.value)} />
        <button class="btn" disabled={!folder || busy || !query.trim()}>Search</button>
      </form>
      {!compact ? <p class="help">Declaration search recognizes common forms in several languages. JavaScript/TypeScript symbols and references use an isolated TypeScript language service over bounded saved repository files; external libraries and compiler plugins are excluded.</p> : null}
      {searchNote ? <p class="help" role="status">{searchNote}</p> : null}
      <div class="wb-hits">{hits.map(hit => <p key={`${hit.path}:${hit.line}`}><button class="btn ghost wb-path" onClick={() => loadFile(hit.path)}>{hit.path}:{hit.line} {hit.symbol ?? ""}</button><code>{hit.text}</code>{hit.column ? <button class="btn small" disabled={busy} onClick={() => perform(async () => {const result=await api<{hits:SymbolHit[];scanned:number;truncated:boolean;note:string}>(`/api/workspace/references?repo=${enc(folder)}&path=${enc(hit.path)}&line=${hit.line}&column=${hit.column}`);setHits(result.hits);setSearchNote(`${result.hits.length} references in ${result.scanned} saved source files${result.truncated ? " · results limited" : ""}. ${result.note}`);})}>Find references to {hit.symbol ?? `${hit.path}:${hit.line}`}</button> : null}</p>)}</div>
      <form class="wb-row" onSubmit={event => {event.preventDefault();if(paths.trim())void loadFile(paths.trim());}}><input class="field" aria-label="File to edit" disabled={!folder || busy} placeholder="Open a file by path…" value={paths} onInput={event => setPaths(event.currentTarget.value)} /><button class="btn" disabled={busy || !folder || !paths.trim()}>Open file</button></form>
    </div>
    {file ? <>
      <h3 class="file-title" title={file.path}>{file.path}</h3>
      <textarea class="field wb-editor" aria-label="File contents" spellcheck={false} disabled={busy} value={draft} onInput={event => {const value=event.currentTarget.value;setDraft(value);if(file.folder===folder)setDraftRecovery(retainFileDraft(folder,file,value,mergeConflict));}} />
      {mergeNote ? <p class="at-notice" role="status">{mergeNote}</p> : null}
      <div class="wb-row file-save-actions"><button class="btn primary" disabled={busy || conflict || draft === file.text || mergeConflict && /^(?:<<<<<<< |=======$|>>>>>>> |\|\|\|\|\|\|\| )/m.test(draft)} onClick={save}>Save file</button><button class="btn" onClick={() => setPreview(!preview)}>{preview ? "Hide comparison" : "Preview changes"}</button>{conflict ? <button class="btn" onClick={refreshForMerge}>Load current version and keep draft</button> : null}{!compact ? <button class="btn" onClick={() => downloadArtifact(file.path.split("/").pop() ?? "draft.txt",draft,"text/plain")}>Export draft</button> : null}</div>
      {preview ? <div class="wb-diff"><div><h4>Current file</h4><pre>{file.text}</pre></div><div><h4>Your draft</h4><pre>{draft}</pre></div></div> : null}
      <details class="file-edit-details" open={!compact}><summary>Editing details</summary><p class="help">Saving checks the loaded version and preserves concurrent edits. Files in active run worktrees cannot be edited here. {draftRecovery === "sensitive" ? "This credential filename is excluded from browser draft recovery; export your draft before leaving." : draftRecovery === "full" ? "Browser draft storage is unavailable; export your draft before leaving." : "Unsaved drafts can be recovered in this browser tab for 24 hours."}</p>{compact ? <button class="btn small" onClick={() => downloadArtifact(file.path.split("/").pop() ?? "draft.txt",draft,"text/plain")}>Export draft</button> : null}</details>
      <ChangeImpact key={file.path} folder={folder} paths={[file.path]} refreshKey={file.hash} />
    </> : null}
  </section>;
}
