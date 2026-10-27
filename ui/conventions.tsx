import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, enc, post, showToast } from "./lib.js";
import { projects, settingsProject } from "./state.js";
import type { ConventionPublication, ConventionRestorePreview, ConventionsDocument } from "../src/conventions.js";

export function ConventionsPanel({ projectId, repos }: { projectId: string; repos: string[] }) {
  const [document, setDocument] = useState<ConventionsDocument | null>(null);
  const [draft, setDraft] = useState(""); const [note, setNote] = useState("");
  const [selectedVersion, setSelectedVersion] = useState(""); const [preview, setPreview] = useState<ConventionRestorePreview | null>(null);
  const [comparison, setComparison] = useState<ConventionsDocument | null>(null);
  const [repo, setRepo] = useState(repos[0] ?? ""); const [publication, setPublication] = useState<ConventionPublication | null>(null);
  const [published, setPublished] = useState<{ revision: number; path: string; requiresCommit: boolean } | null>(null);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [conflicted, setConflicted] = useState(false);
  const draftField = useRef<HTMLTextAreaElement>(null); const publicationStatus = useRef<HTMLParagraphElement>(null);
  const project = projects.value.find(project => project.id === projectId);
  const paused = project?.filesystemRestricted === true;
  const isPaused = () => projects.peek().find(project => project.id === projectId)?.filesystemRestricted === true;
  const documentProject = useRef(projectId);
  const generation = useRef(0); const action = useRef(0); const path = `/api/projects/${enc(projectId)}/conventions`;
  const bytes = new TextEncoder().encode(draft).length; const dirty = !!document && draft !== document.text;
  useEffect(() => {
    const scope = ++generation.current; ++action.current;
    const changedProject = documentProject.current !== projectId; documentProject.current = projectId;
    if (changedProject) { setDocument(null); setDraft(""); setNote(""); setConflicted(false); setRepo(repos[0] ?? ""); }
    setPreview(null); setComparison(null); setPublication(null); setPublished(null); setError(""); setBusy("");
    // Settings mounts this panel from the project inventory, including its policy. Keep it mounted when
    // restrictions change so an already loaded draft and its CAS revision survive the pause.
    if (!paused && (!document || changedProject)) {
      setBusy("load");
      const current = () => scope === generation.current && !isPaused();
      void api<ConventionsDocument>(path).then((value) => { if (current()) { setDocument(value); setDraft(value.text); setSelectedVersion(String(value.history[0]?.revision ?? "")); setBusy(""); } }, (err) => { if (current()) { setError(err.message); setBusy(""); } });
    }
    return () => { generation.current++; action.current++; };
  }, [projectId, paused]);
  useEffect(() => { if (!repos.includes(repo)) { setRepo(repos[0] ?? ""); setPublication(null); setPublished(null); } }, [JSON.stringify(repos)]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { if (published && !busy) publicationStatus.current?.focus(); }, [published, busy]);
  const perform = async (name: string, task: (current: () => boolean) => Promise<void>) => {
    if (busy || isPaused()) return; const scope = generation.current; const op = ++action.current; setBusy(name); setError("");
    const current = () => scope === generation.current && op === action.current && !isPaused();
    try { await task(current); }
    catch (err) { if (current()) { setError((err as Error).message); if (err instanceof ApiError && err.status === 409 && name === "save") setConflicted(true); if (name === "publish") setPublication(null); if (name === "restore") setPreview(null); } }
    finally { if (current()) setBusy(""); }
  };
  const accept = (value: ConventionsDocument) => { setDocument(value); setDraft(value.text); setNote(""); setPreview(null); setComparison(null); setConflicted(false); setSelectedVersion(String(value.revision)); setPublication(null); setPublished(null); };
  const save = () => perform("save", async (current) => { const value = await api<ConventionsDocument>(path, { method: "PUT", body: JSON.stringify({ revision: document!.revision, text: draft, note }) }); if (current()) { accept(value); showToast(`Saved private conventions revision ${value.revision}`); requestAnimationFrame(() => { if (current()) draftField.current?.focus(); }); } });
  const compare = () => perform("compare", async (current) => { const value = await api<ConventionsDocument>(path); if (current()) setComparison(value); });
  const restorePreview = () => perform("preview", async (current) => { const value = await post<ConventionRestorePreview>(path + "/restore-preview", { version: Number(selectedVersion) }); if (current()) setPreview(value); });
  const restore = () => perform("restore", async (current) => { const value = await post<ConventionsDocument>(path + "/restore", preview); if (current()) { accept(value); showToast(`Restored as new revision ${value.revision}`); requestAnimationFrame(() => { if (current()) draftField.current?.focus(); }); } });
  const inspect = () => perform("inspect", async (current) => { setPublication(null); const value = await api<ConventionPublication>(path + `/publication?repo=${enc(repo)}`); if (current()) { setPublication(value); setPublished(null); } });
  const publish = () => perform("publish", async (current) => { const value = await post<{ revision: number; path: string; requiresCommit: boolean }>(path + "/publish", { repo, revision: document!.revision, sourceHash: publication!.sourceHash, head: publication!.head }); if (current()) { setPublished(value); setPublication(null); showToast("Conventions file staged; commit it to activate guidance", 5000); } });
  const exportDraft = () => { const url = URL.createObjectURL(new Blob([draft], { type: "text/markdown;charset=utf-8" })); const link = window.document.createElement("a"); link.href = url; link.download = "conventions-draft.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <section class="wb-card project-conventions" aria-label="Versioned project conventions">
    <h2>Project conventions</h2><p class="help">Save shared guidance privately, review prior versions, then deliberately publish a saved revision to a project repository. Agents read only the committed repository file; private drafts and imported run text are never activated automatically.</p>
    {paused ? <p class="msg warn policy-pause">Private conventions are paused: project “{project!.name}” has a custom filesystem restriction. Remove its restrictions to load or change private guidance. <a href="#/settings/projects" onClick={() => { settingsProject.value = projectId; }}>Review the filesystem policy</a></p> : null}
    {paused && dirty ? <p class="help">Your unsaved draft is kept in this tab. Remove the filesystem restrictions to continue editing.</p> : null}
    {!paused && !document && busy ? <p role="status">Loading private conventions…</p> : null}
    {document && !paused ? <>
      <label class="lbl" for={`conventions-text-${enc(projectId)}`}>Private conventions draft</label><textarea ref={draftField} id={`conventions-text-${enc(projectId)}`} class="field" value={draft} disabled={!!busy} onInput={(event) => setDraft(event.currentTarget.value)} placeholder="Describe coding, review, and verification conventions for this project." />
      <p class="help">Saved revision {document.revision} · {bytes.toLocaleString()} / 65,536 UTF-8 bytes{dirty ? " · unsaved changes" : ""}. The latest 32 revisions are retained.</p>
      <label class="lbl" for={`conventions-note-${enc(projectId)}`}>Revision note</label><input id={`conventions-note-${enc(projectId)}`} class="field" value={note} maxLength={500} disabled={!!busy} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Why should this guidance change?" />
      <div class="convention-actions"><button class="btn primary" disabled={!!busy || bytes > 65536 || !dirty && !note.trim()} onClick={save}>{busy === "save" ? "Saving…" : "Save private revision"}</button><button class="btn" disabled={!!busy} onClick={exportDraft}>Export draft</button>{dirty ? <button class="btn" disabled={!!busy} onClick={() => { setDraft(document.text); setNote(""); }}>Revert to saved draft</button> : null}</div>
      {conflicted ? <div class="msg warn"><p>Your draft is preserved. Review the latest saved guidance before applying it.</p><button class="btn" disabled={!!busy} onClick={compare}>Compare latest revision</button></div> : null}
      {comparison ? <div><div class="convention-compare"><div><h3>Latest saved revision {comparison.revision}</h3><pre>{comparison.text || "Empty guidance"}</pre></div><div><h3>Your draft</h3><pre>{draft || "Empty guidance"}</pre></div></div><button class="btn" disabled={!!busy} onClick={() => { setDocument(comparison); setComparison(null); setConflicted(false); setPublication(null); setPreview(null); requestAnimationFrame(() => draftField.current?.focus()); }}>Use latest revision as base and keep my draft</button></div> : null}
      <details><summary>Revision history ({document.history.length})</summary>{document.history.length ? <><label class="lbl" for={`conventions-version-${enc(projectId)}`}>Saved conventions version</label><select id={`conventions-version-${enc(projectId)}`} class="field" value={selectedVersion} disabled={!!busy} onChange={(event) => { setSelectedVersion(event.currentTarget.value); setPreview(null); }}>{document.history.map((version) => <option key={version.revision} value={version.revision}>Revision {version.revision} · {new Date(version.at).toLocaleString()}{version.note ? ` · ${version.note}` : ""}</option>)}</select><div class="convention-actions"><button class="btn" disabled={!!busy || !selectedVersion} onClick={restorePreview}>Preview saved revision</button></div>{preview ? <div><h3>Preview revision {preview.version}</h3><pre>{preview.text || "Empty guidance"}</pre><p class="help">Restoring creates a new private revision. It does not publish or remove the current saved version.{dirty ? " Save or revert your unsaved draft first." : ""}</p><button class="btn" disabled={!!busy || dirty || preview.revision !== document.revision} onClick={restore}>Restore as new revision</button></div> : null}</> : <p class="help">Save the first revision to start a history.</p>}</details>
      <h3 class="convention-publish">Publish reviewed guidance</h3><p class="help">Publishing writes and stages <code>.codeflow/conventions.md</code>. Commit the staged file yourself to activate guidance for future runs. The repository must belong to this project, be clean, and have no active code-flow work.</p>
      <label class="lbl" for={`conventions-repo-${enc(projectId)}`}>Publish conventions to repository</label><select id={`conventions-repo-${enc(projectId)}`} class="field" value={repo} disabled={!!busy} onChange={(event) => { setRepo(event.currentTarget.value); setPublication(null); setPublished(null); }}>{repos.length ? repos.map((path) => <option key={path} value={path}>{path}</option>) : <option value="">This project has no repositories</option>}</select>
      <div class="convention-actions"><button class="btn" disabled={!!busy || !repo || !document.revision} onClick={inspect}>{busy === "inspect" ? "Inspecting…" : "Inspect repository file"}</button></div>
      {publication ? <div><p class="help">{publication.clean ? "Repository is clean" : "Repository has changes; commit or save them before publishing"} · {publication.branch ?? "Detached HEAD"} · {publication.head.slice(0, 12)} · {publication.tracked ? "File is tracked" : publication.exists ? "File exists outside tracking" : "File will be created"}</p><div class="convention-compare"><div><h4>Current repository file</h4><pre>{publication.text || "No repository guidance"}</pre></div><div><h4>Saved private revision {document.revision}</h4><pre>{document.text || "Empty guidance"}</pre></div></div><button class="btn primary" disabled={!!busy || dirty || !publication.clean} onClick={publish}>{busy === "publish" ? "Publishing…" : "Publish and stage file"}</button>{dirty ? <p class="help">Save or revert your unsaved draft before publishing a saved revision.</p> : null}</div> : null}
      {published ? <p class="msg ok" role="status" ref={publicationStatus} tabIndex={-1}>Revision {published.revision} was staged at {published.path}. Commit the file in the repository to activate it for future runs.</p> : null}
    </> : !paused && !busy ? <button class="btn" onClick={() => { void perform("reload", async (current) => { const value = await api<ConventionsDocument>(path); if (current()) accept(value); }); }}>Retry loading conventions</button> : null}
    {!paused && error ? <p class="msg err" role="alert">{error}</p> : null}
  </section>;
}
