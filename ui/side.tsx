import { lazyView } from "./lazy-view.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
const BrowserTab = lazyView(() => import("./interactive-browser.js").then((module) => module.BrowserTab));
const ChangesTab = lazyView(() => import("./changes.js").then((module) => module.ChangesTab));
const CodeBrowser = lazyView(() => import("./code-browser.js").then((module) => module.CodeBrowser));
import { Icon, type IconName } from "./icons.js";
import { ago, api, baseName, enc, post, showToast, store } from "./lib.js";
import { placesFor, PlacePicker, usePlace } from "./panel-bits.js";
import { readNoteDraft, writeNoteDraft, noteDraftConflicts, sentence, type NoteDraft, type NoteBase } from "./notes-draft.js";
import { ChatTab } from "./side-chat.js";
import {
  closeSide,
  navigate,
  openSide,
  pinSide,
  projectKeyOf,
  rememberSide,
  repo,
  restoreSideTab,
  route,
  setSideChat,
  setSideWidth,
  SIDE_TABS,
  sideDraft,
  sideFile,
  sideMemo,
  sideMemory,
  sideOpen,
  sideDisplayWidth,
  sideMaxWidth,
  sideExpanded,
  sideScope,
  sideTab,
  type SideTab,
} from "./state.js";
const TerminalTab = lazyView(() => import("./terminal.js").then((module) => module.TerminalTab));


/**
 * The side panel: what you'd keep open next to the work in Claude's or Codex's app. A chat with
 * one agent (you pick which), the files of the repository or of a run's worktree, a terminal, a
 * browser for the app a run started, and your notes. It follows what you open (see `sideScope`):
 * on an Agent task, provider tabs share the panel memory; other runs and projects keep their own.
 */

const TABS: Record<SideTab, { label: string; icon: IconName; title: string }> = {
  chat: { label: "Chat", icon: "chat", title: "Chat with one agent about this run or repository" },
  changes: { label: "Changes", icon: "diff", title: "What this run changed: the whole branch or its last step, with line comments" },
  files: { label: "Files", icon: "files", title: "The repository's files, or a run's worktree" },
  terminal: { label: "Terminal", icon: "terminal", title: "A shell in the repository or a worktree" },
  browser: { label: "Browser", icon: "globe", title: "Open the app a run started, or any address" },
  notes: { label: "Notes", icon: "note", title: "Your scratchpad for this repository" },
};

export function SidePanel({ popped = false }: { popped?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const run = sideScope.value.run;
  // Changes are a run's: the tab is there while the panel shows one.
  const tabs = SIDE_TABS.filter((t) => t !== "changes" || run);
  const tab = tabs.includes(sideTab.value) ? sideTab.value : "chat";
  // Tabs you've opened stay mounted: the terminal and the browser keep their state behind another tab.
  const [visited, setVisited] = useState<Set<SideTab>>(() => new Set([tab]));
  useEffect(() => {
    if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  }, [tab]);
  // Back on a run you've used the panel with: the tab you had open there.
  const scopeKey = sideScope.value.key;
  useEffect(restoreSideTab, [scopeKey]);
  const [dragging, setDragging] = useState(false);
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const stopDrag = (e: PointerEvent) => {
    setDragging(false);
    const handle = e.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  };
  useLayoutEffect(() => {
    if (!sideOpen.value || !sideExpanded.value || popped) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('dialog[open], [role="menu"]')) return;
      event.preventDefault(); sideExpanded.value = false;
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [sideOpen.value, sideExpanded.value, popped]);
  const panes: Record<SideTab, () => preact.JSX.Element> = {
    chat: () => <ChatTab />,
    changes: () => (run ? <ChangesTab key={run.id} run={run} /> : <div class="side-empty help">Open a run to see what it changed.</div>),
    files: () => <FilesTab />,
    terminal: () => <TerminalTab />,
    browser: () => <BrowserTab />,
    notes: () => <NotesTab />,
  };
  // Keep visited panes mounted while closed so browsers, terminals and drafts survive.
  const closed = !sideOpen.value && !popped;
  useLayoutEffect(() => {
    if (closed && panel.current?.contains(document.activeElement)) document.querySelector<HTMLButtonElement>('button[aria-label="Side panel"]')?.focus();
  }, [closed]);
  return (
    <aside id="side-panel" ref={panel} tabIndex={-1} class={`side ${sideOpen.value ? "open" : ""} ${popped ? "popped" : ""}`} aria-label="Side panel" aria-hidden={closed} inert={closed}>
      {popped || sideExpanded.value ? null : <div class={`side-handle ${dragging ? "dragging" : ""}`} role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize the side panel" aria-valuemin={300} aria-valuemax={sideMaxWidth.value} aria-valuenow={sideDisplayWidth.value} title="Drag or use arrow keys to resize; double-click to reset" onPointerDown={startDrag} onPointerMove={event => { if (dragging) setSideWidth(window.innerWidth - event.clientX); }} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={() => setDragging(false)} onDblClick={() => setSideWidth(420)} onKeyDown={(event) => { const width = event.key === "ArrowLeft" ? sideDisplayWidth.value + 24 : event.key === "ArrowRight" ? sideDisplayWidth.value - 24 : event.key === "Home" ? 300 : event.key === "End" ? sideMaxWidth.value : undefined; if (width !== undefined) { event.preventDefault(); setSideWidth(width); } }} />}
      <ScopeHeader popped={popped} />
      <div class="side-tabs" role="tablist" aria-label="Side panel tabs">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" id={`side-tab-${t}`} aria-selected={t === tab} aria-controls={`side-pane-${t}`} class={`side-tab ${t === tab ? "on" : ""}`} aria-label={TABS[t].label} title={TABS[t].title} tabIndex={t === tab ? 0 : -1} onKeyDown={(event) => { const at = tabs.indexOf(t); const index = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1; if (index >= 0) { event.preventDefault(); const next = tabs[index]!; openSide(next); document.getElementById(`side-tab-${next}`)?.focus(); } }} onClick={() => openSide(t)}>
            <Icon name={TABS[t].icon} />
            <span>{TABS[t].label}</span>
          </button>
        ))}
      </div>
      <div class="side-body">
        {sideScope.value.missing ? (
          <div class="side-empty help">{sideScope.value.kind === "run" ? "This run no longer exists." : "Project not found."}</div>
        ) : sideScope.value.waiting ? (
          <div class="side-empty help">Loading…</div>
        ) : (
          tabs.filter((t) => visited.has(t) || t === tab).map((t) => (
            <div key={t} id={`side-pane-${t}`} role="tabpanel" aria-labelledby={`side-tab-${t}`} class="side-pane" hidden={t !== tab}>
              {panes[t]()}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- what the panel is about
/** The project and run the panel is showing, and the pin that keeps it there while you open others. */
function ScopeHeader({ popped }: { popped: boolean }) {
  const s = sideScope.value;
  const browser = sideTab.value === "browser";
  const thing = s.run ? "run" : "project";
  const where = s.project?.name ?? (s.repo ? baseName(s.repo) : "");
  const task = s.run ? s.run.task.split("\n")[0] || "(no task)" : "";
  return (
    <div class={`side-scope ${s.pinned ? "pinned" : ""}`}>
      <span class="scope-state" title={popped ? `This window shows one ${thing}` : s.pinned ? `The panel stays on this ${thing} while you open others` : "The panel follows what you open"}>
        {popped ? <Icon name="external" /> : s.pinned ? <Icon name="pin" /> : <span class="scope-dot" aria-hidden="true" />}
        {popped ? "Own window" : s.pinned ? "Pinned" : "Following"}
      </span>
      <span class="scope-crumbs" title={[where, s.repo, task].filter(Boolean).join("\n")}>
        {where ? <span class="sc-where">{where}</span> : s.waiting ? null : <span class="help">{s.missing ? s.kind === "run" ? "This run no longer exists" : "Project not found" : "No repository chosen"}</span>}
        {!s.run && s.project && s.project.repos.length > 1 ? (
          <>
            <span class="sep" aria-hidden="true">›</span>
            <span class="sc-what">{baseName(s.repo)}</span>
          </>
        ) : null}
        {s.run ? (
          <>
            <span class="sep" aria-hidden="true">›</span>
            {s.pinned ? (
              <a class="sc-what" href={`#/run/${enc(s.run.id)}`} title={popped ? "Open this run in the main window" : "Open this run"}>
                {task}
              </a>
            ) : (
              <span class="sc-what">{task}</span>
            )}
          </>
        ) : null}
      </span>
      {popped ? <a class="btn ghost small" href="#/" target="_self">Open code-flow</a> : s.pinned ? (
        <button type="button" class="btn ghost small" title="Follow what you open again" onClick={() => pinSide(false)}>
          Follow
        </button>
      ) : (
        <button type="button" class={browser ? "btn ghost small scope-keep" : "icon-btn"} aria-label={browser ? "Keep open when switching runs" : `Pin the panel to this ${thing}`} title={`Keep this ${browser ? "browser and panel" : "panel"} on this ${thing} while you open others`} disabled={!s.repo} onClick={() => pinSide(true)}>
          <Icon name="pin" />
          {browser ? "Keep open" : null}
        </button>
      )}
      {popped ? null : (
        <button type="button" class="icon-btn side-expand" aria-label={sideExpanded.value ? "Restore side panel" : "Expand side panel"} title={sideExpanded.value ? "Restore alongside chat (Esc)" : "Expand to full screen"} aria-pressed={sideExpanded.value} onClick={() => { sideExpanded.value = !sideExpanded.value; }}>
          <Icon name={sideExpanded.value ? "collapse" : "expand"} />
        </button>
      )}
      {popped ? null : (
        <button type="button" class="icon-btn" aria-label="Close side panel" title="Close (\)" onClick={closeSide}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- files
function FilesTab() {
  const [place, setPlace, places] = usePlace("files");
  const run = sideScope.value.run;
  const [retained, setRetained] = useState<{ runId: string; paths: string[] } | null>(null);
  useEffect(() => {
    if (!run?.archived) { setRetained(null); return; }
    let current = true;
    // Archive can keep shared/dirty worktrees or remove them. Only offer folders
    // still present; a historical worktree record is not an available folder.
    void Promise.all(run.worktrees.map(async (tree) => {
      try { await api(`/api/fs?path=${enc(tree.path)}`); return tree.path; }
      catch { return null; }
    })).then((paths) => { if (current) setRetained({ runId: run.id, paths: paths.filter((p): p is string => p !== null) }); });
    return () => { current = false; };
  }, [run]);
  const availablePlaces = run?.archived ? places.filter((p) => !p.runId || retained?.runId === run.id && retained.paths.includes(p.path)) : places;
  useEffect(() => {
    if (run?.archived) {
      const repository = places.find((p) => p.path === run.repo);
      if (repository) setPlace(repository);
    }
  }, [run?.id, run?.archived]);
  /** The file shown, and the folder it's in: it closes when the panel shows another folder. */
  const [open, setOpen] = useState<{ root: string; path: string } | null>(null);
  // Something else asked for a file (a run's diff, a transcript): show it, in its folder.
  useEffect(() => {
    const want = sideFile.value;
    if (!want) return;
    const target = places.find((p) => p.path === want.root);
    if (target) setPlace(target);
    setOpen({ root: target?.path ?? place?.path ?? "", path: want.path });
    sideFile.value = null;
  }, [sideFile.value]);
  const viewKey = place?.path ?? "";
  // A visited tab stays mounted while agents work. Refresh its tree on completion,
  // including follow-ups, without remounting the editor or losing an unsaved draft.
  const treeRevision = `${run?.endedAt ?? ""}:${run?.followUps.filter((f) => f.status !== "pending").map((f) => f.id).join(",") ?? ""}`;
  useEffect(() => setOpen((o) => (o?.root === viewKey ? o : null)), [viewKey]);
  // Keyed by folder (and file): another worktree's tree or file never shows what an earlier one loaded.
  return (
    <>
      <div class="side-toolbar">
        <PlacePicker label="Folder" place={place} places={availablePlaces} onChange={setPlace} />
      </div>
      {place ? <CodeBrowser compact key={viewKey} folder={viewKey} refreshKey={treeRevision} initialPath={open?.root === viewKey ? open.path : undefined} onClose={() => setOpen(null)} /> : <p class="side-empty">Choose a repository or run worktree.</p>}
    </>
  );
}

// ---------------------------------------------------------------- notes
function NotesTab() {
  const here = sideScope.value.repo;
  const [scope, setScope] = useState<"repo" | "general">(here ? "repo" : "general");
  const [pickedNote, setPickedNote] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState<{ hits: { key: string; revision: number; excerpt: string }[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const key = pickedNote ?? (scope === "repo" && here ? here : "general");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ at: number; text: string; revision: number } | null>(null);
  const [history, setHistory] = useState<{ text: string; updatedAt: number; revision: number }[]>([]);
  const [latest, setLatest] = useState<{ text: string; updatedAt: number; revision: number } | null>(null);
  const bases = useRef(new Map<string, NoteBase>());
  const drafts = useRef(new Map<string, NoteDraft>());
  const blocked = useRef(new Set<string>());
  const saving = useRef(Promise.resolve());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const activeKey = useRef(key);
  activeKey.current = key;
  const loadedKey = useRef<string>();
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const flush = (scopeKey: string) => {
    clearTimeout(timers.current.get(scopeKey)); timers.current.delete(scopeKey);
    saving.current = saving.current.catch(() => undefined).then(async () => {
      const draft = drafts.current.get(scopeKey), base = bases.current.get(scopeKey);
      if (!draft || !base || blocked.current.has(scopeKey)) return;
      if (draft.text === base.text) {
        drafts.current.delete(scopeKey);
        if (readNoteDraft(scopeKey)?.text === draft.text) store.remove(`notes-draft:${scopeKey}`);
        if (activeKey.current === scopeKey) setStatus("");
        return;
      }
      const value = draft.text;
      try {
        const note = await post<{ updatedAt: number; revision: number }>("/api/notes", { key: scopeKey, text: value, expectedRevision: base.revision });
        const next = { text: value, revision: note.revision };
        bases.current.set(scopeKey, next);
        const pending = drafts.current.get(scopeKey);
        if (pending?.text === value) drafts.current.delete(scopeKey);
        else if (pending) drafts.current.set(scopeKey, writeNoteDraft(scopeKey, pending.text, next));
        // A different window can write the same storage key while this request is in flight.
        const stored = readNoteDraft(scopeKey);
        if (stored?.text === value) store.remove(`notes-draft:${scopeKey}`);
        if (activeKey.current === scopeKey) { setSaved({ at: note.updatedAt, ...next }); setStatus(pending?.text === value ? "" : "Saving…"); }
      } catch (error) {
        if (activeKey.current === scopeKey) setStatus(`Couldn't save: ${sentence((error as Error).message)} Your draft is kept in this browser.`);
        const current = await api<{ text: string; updatedAt: number; revision: number }>(`/api/notes?key=${enc(scopeKey)}`).catch(() => null);
        if (current && current.revision !== base.revision) {
          blocked.current.add(scopeKey);
          if (activeKey.current === scopeKey) setLatest(current);
        }
      }
    });
  };
  const queue = (scopeKey: string, value: string, base = bases.current.get(scopeKey)) => {
    drafts.current.set(scopeKey, writeNoteDraft(scopeKey, value, base));
    clearTimeout(timers.current.get(scopeKey)); timers.current.delete(scopeKey);
    if (!blocked.current.has(scopeKey)) {
      setStatus("Saving…");
      timers.current.set(scopeKey, setTimeout(() => flush(scopeKey), 600));
    }
  };
  useEffect(() => {
    setReady(false); loadedKey.current = undefined;
    setStatus("Loading…");
    let current = true;
    // A departing scope is flushed before loading it again, so its acknowledged base cannot regress.
    void saving.current.then(() => api<{ text: string; updatedAt: number; revision: number }>(`/api/notes?key=${enc(key)}`)).then(
      (n) => {
        if (!current) return;
        const draft = drafts.current.get(key) ?? readNoteDraft(key);
        const conflict = !!draft && noteDraftConflicts(draft, n);
        bases.current.set(key, n);
        setText(draft?.text ?? n.text);
        setSaved({ at: n.updatedAt, text: n.text, revision: n.revision });
        setLatest(conflict ? n : null); setHistory([]);
        blocked.current.delete(key);
        if (conflict) blocked.current.add(key);
        setStatus(draft && draft.text !== n.text ? "Recovered your unsaved draft" : "");
        loadedKey.current = key; setReady(true);
        if (draft && draft.text !== n.text) {
          drafts.current.set(key, draft);
          if (!conflict) queue(key, draft.text, n);
        } else { drafts.current.delete(key); store.remove(`notes-draft:${key}`); }
      },
      (err) => current && setStatus((err as Error).message),
    );
    return () => { current = false; flush(key); };
  }, [key]);
  useEffect(() => {
    const flushAll = () => { for (const k of timers.current.keys()) flush(k); };
    const hidden = () => { if (document.visibilityState === "hidden") flushAll(); };
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flushAll); document.removeEventListener("visibilitychange", hidden); flushAll(); };
  }, []);
  const selection = () => {
    const el = document.getElementById("side-notes") as HTMLTextAreaElement | null;
    const picked = el && el.selectionStart !== el.selectionEnd ? el.value.slice(el.selectionStart, el.selectionEnd) : "";
    return (picked || text).trim();
  };
  return (
    <>
      <div class="side-toolbar">
        {here ? (
          <div class="segmented small" role="group" aria-label="Which notes">
            <button type="button" class={!pickedNote && scope === "repo" ? "on" : ""} aria-pressed={!pickedNote && scope === "repo"} onClick={() => { setScope("repo"); setPickedNote(null); }} title={here}>
              {baseName(here)}
            </button>
            <button type="button" class={!pickedNote && scope === "general" ? "on" : ""} aria-pressed={!pickedNote && scope === "general"} onClick={() => { setScope("general"); setPickedNote(null); }}>
              General
            </button>
          </div>
        ) : (
          <span class="help">General notes</span>
        )}
        <span class="spacer" />
        <button
          type="button"
          class="btn ghost small"
          title="Add the selection (or the whole note) to the task in the composer"
          disabled={!text.trim()}
          onClick={() => {
            // The composer takes it as a draft, so from a popped-out panel it goes to the main window's.
            navigate({ view: "composer" }, [{ to: "composer", text: selection(), images: [] }]);
            showToast("Added to the task");
          }}
        >
          → Task
        </button>
        <button
          type="button"
          class="btn ghost small"
          title="Send the selection (or the whole note) to the chat"
          disabled={!text.trim()}
          onClick={() => {
            sideDraft.value = selection();
            setSideChat(null);
            openSide("chat");
          }}
        >
          → Chat
        </button>
      </div>
      {/* Searching and the revision history: one quiet row of tools over the note */}
      <div class="notes-tools">
        <button type="button" class="btn ghost small" aria-expanded={searching} aria-controls={searching ? "notes-search" : undefined} onClick={() => setSearching(!searching)}><Icon name="search" /> Search saved notes</button>
        <span class="spacer" />
        <button type="button" class="btn ghost small" disabled={!ready} onClick={async () => { try { setHistory(await api(`/api/notes/history?key=${enc(key)}`)); } catch (error) { setStatus((error as Error).message); } }}><Icon name="clock" /> Revision history</button>
      </div>
      {searching ? <div id="notes-search" class="notes-search"><form class="notes-search-row" onSubmit={async (event) => { event.preventDefault(); try { setMatches(await api(`/api/notes/search?q=${enc(search)}`)); } catch (error) { setStatus((error as Error).message); } }}><input class="field" aria-label="Search saved notes" placeholder="Words or repository path" value={search} onInput={(event) => setSearch(event.currentTarget.value)} /><button class="btn small">Search notes</button></form>{matches ? <>{matches.hits.length ? matches.hits.map((match) => <div class="notes-hit" key={match.key}><button type="button" class="notes-hit-key" onClick={() => { setPickedNote(match.key); setMatches(null); }}>{match.key} · revision {match.revision}</button><span class="help">{match.excerpt}</span></div>) : <p class="help">No saved notes match.</p>}{matches.truncated ? <p class="help">Results are limited; narrow the query.</p> : null}</> : null}</div> : null}
      {pickedNote ? <div class="notes-picked"><span class="help">Editing <code>{pickedNote}</code></span><button class="btn small" onClick={() => setPickedNote(null)}>Return to current notes</button></div> : null}
      {latest ? <div class="notes-conflict" role="alert"><p>This note changed in another window. Your draft is preserved.</p><details><summary>Compare saved version</summary><pre>{latest.text}</pre></details><div class="row"><button class="btn small" onClick={() => { bases.current.set(key, latest); setText(latest.text); setSaved({ at: latest.updatedAt, text: latest.text, revision: latest.revision }); setLatest(null); blocked.current.delete(key); drafts.current.delete(key); setStatus(""); store.remove(`notes-draft:${key}`); }}>Use saved version</button><button class="btn small" onClick={() => { bases.current.set(key, latest); setSaved({ at: latest.updatedAt, text: latest.text, revision: latest.revision }); setLatest(null); blocked.current.delete(key); queue(key, text, latest); }}>Save my draft over this version</button></div></div> : null}
      {history.length ? <details open class="notes-history"><summary>{history.length} saved revisions</summary>{history.map((note) => <div key={note.revision}><details><summary>Revision {note.revision} · {new Date(note.updatedAt).toLocaleString()}</summary><pre>{note.text || "(empty)"}</pre><button class="btn small" disabled={note.revision === saved?.revision || saved?.text !== text} onClick={async () => { try { const restored = await post<{ text: string; updatedAt: number; revision: number }>("/api/notes/restore", { key, revision: note.revision, expectedRevision: saved?.revision }); bases.current.set(key, restored); setSaved({ at: restored.updatedAt, text: restored.text, revision: restored.revision }); setText(restored.text); setHistory([]); setStatus("Restored as a new revision"); } catch (error) { setStatus((error as Error).message); } }}>Restore as new revision</button></details></div>)}</details> : null}
      <textarea id="side-notes" class="notes-area" aria-label="Notes" placeholder="Notes to yourself: what to check, ideas, commands… Saved as you type." spellcheck={false} disabled={!ready || loadedKey.current !== key} value={text} onInput={(e) => { setText(e.currentTarget.value); queue(key, e.currentTarget.value); }} />
      <div class="notes-foot">
        <span>{status || (saved?.at ? `Saved ${ago(saved.at)}` : "")}</span>
        <span class="spacer" />
        <span>{text.length ? `${text.length.toLocaleString()} characters` : ""}</span>
      </div>
    </>
  );
}
