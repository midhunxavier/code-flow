import { useEffect, useRef, useState } from "preact/hooks";
import { BrowserTab } from "./browser.js";
import { ChangesTab } from "./changes.js";
import { addContext, FileTree } from "./composer.js";
import { Icon, type IconName } from "./icons.js";
import { ago, api, baseName, enc, fmtSize, onPhone, post, showToast, useLatest } from "./lib.js";
import { placesFor, PlacePicker, usePlace } from "./panel-bits.js";
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
  sideWidth,
  sideScope,
  sideTab,
  type SideTab,
} from "./state.js";
import { TerminalTab } from "./terminal.js";
import type { DevServer, FileContent } from "./types.js";

/**
 * The side panel: what you'd keep open next to the work in Claude's or Codex's app. A chat with
 * one agent (you pick which), the files of the repository or of a run's worktree, a terminal, a
 * browser for the app a run started, and your notes. It follows what you open (see `sideScope`):
 * on a run, every tab is that run's, and each run keeps its own chat, folders and address.
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
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => setSideWidth(window.innerWidth - ev.clientX);
    const stop = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const panes: Record<SideTab, () => preact.JSX.Element> = {
    chat: () => <ChatTab />,
    changes: () => (run ? <ChangesTab key={run.id} run={run} /> : <div class="side-empty help">Open a run to see what it changed.</div>),
    files: () => <FilesTab />,
    terminal: () => <TerminalTab />,
    browser: () => <BrowserTab />,
    notes: () => <NotesTab />,
  };
  // Closed, it's off-screen on narrower windows (not gone): inert keeps its controls out of the Tab order.
  const closed = !sideOpen.value && !popped;
  return (
    <aside class={`side ${sideOpen.value ? "open" : ""} ${popped ? "popped" : ""}`} aria-label="Side panel" aria-hidden={closed} inert={closed}>
      {popped ? null : <div class={`side-handle ${dragging ? "dragging" : ""}`} role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize the side panel" aria-valuemin={300} aria-valuemax={900} aria-valuenow={sideWidth.value} title="Drag or use arrow keys to resize" onPointerDown={startDrag} onKeyDown={(event) => { const width = event.key === "ArrowLeft" ? sideWidth.value + 24 : event.key === "ArrowRight" ? sideWidth.value - 24 : event.key === "Home" ? 300 : event.key === "End" ? 900 : undefined; if (width !== undefined) { event.preventDefault(); setSideWidth(width); } }} />}
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
        {sideScope.value.waiting ? (
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
  /** This tab in a window of its own, fixed to what the panel shows now; the panel here closes. */
  const popOut = () => {
    const url = `${location.origin}${location.pathname}#/side/${sideTab.value}/${encodeURIComponent(s.key)}`;
    if (window.open(url, `codeflow-side-${s.key}`, "popup,width=560,height=860")) closeSide();
    else showToast("The browser blocked the window: allow pop-ups for code-flow", 5000);
  };
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
        {where ? <span class="sc-where">{where}</span> : s.waiting ? null : <span class="help">No repository chosen</span>}
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
      {popped ? null : s.pinned ? (
        <button type="button" class="btn ghost small" title="Follow what you open again" onClick={() => pinSide(false)}>
          Follow
        </button>
      ) : (
        <button type="button" class="icon-btn" aria-label={`Pin the panel to this ${thing}`} title={`Pin: keep the panel on this ${thing} while you open others`} disabled={!s.repo} onClick={() => pinSide(true)}>
          <Icon name="pin" />
        </button>
      )}
      {popped || onPhone ? null : (
        <button type="button" class="icon-btn" aria-label="Open in its own window" title="Open this tab in a window of its own, for this run or project" disabled={!s.repo} onClick={popOut}>
          <Icon name="external" />
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
  useEffect(() => setOpen((o) => (o?.root === viewKey ? o : null)), [viewKey]);
  // Keyed by folder (and file): another worktree's tree or file never shows what an earlier one loaded.
  return (
    <>
      <div class="side-toolbar">
        <PlacePicker label="Folder" place={place} places={places} onChange={setPlace} />
      </div>
      {place && open?.root === place.path ? (
        <FileViewer key={`${place.path}\n${open.path}`} root={place.path} path={open.path} onClose={() => setOpen(null)} />
      ) : (
        <FileTree key={viewKey} root={viewKey} onOpen={(path) => setOpen({ root: viewKey, path })} />
      )}
    </>
  );
}

const MAX_SHOWN_LINES = 5_000;

function FileViewer({ root, path, onClose }: { root: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState("");
  const request = useLatest();
  useEffect(() => {
    const current = request();
    setFile(null);
    setError("");
    api<FileContent>(`/api/file?repo=${enc(root)}&path=${enc(path)}`).then(
      (f) => current() && setFile(f),
      (err) => current() && setError((err as Error).message),
    );
  }, [root, path]);
  const lines = file?.text?.split("\n") ?? [];
  const inComposer = route.value.view === "composer" && root === repo.value;
  return (
    <>
      <div class="file-head">
        <button type="button" class="btn ghost small" aria-label="Back to the files" title="Back to the files" onClick={onClose}>
          ←
        </button>
        <span class="fp" title={path}>
          {path}
        </span>
        {file ? <span class="help">{fmtSize(file.size)}</span> : null}
        {inComposer ? (
          <button type="button" class="btn ghost small" title="Add this file to the task as context" onClick={() => addContext({ path, type: "file" })}>
            + Task
          </button>
        ) : null}
        <button
          type="button"
          class="btn ghost small"
          title="Ask the agent about this file in the chat"
          onClick={() => {
            sideDraft.value = `About \`${path}\`: `;
            setSideChat(null);
            openSide("chat");
          }}
        >
          <Icon name="chat" />
        </button>
      </div>
      {error ? <div class="side-empty msg err">{error}</div> : null}
      {!file && !error ? <div class="side-empty help">Loading…</div> : null}
      {file?.binary ? <div class="side-empty help">This is a binary file ({fmtSize(file.size)}).</div> : null}
      {file && !file.binary ? (
        <pre class="file-view" tabIndex={0}>
          {lines.slice(0, MAX_SHOWN_LINES).map((line, i) => (
            <span key={i} class="fl">
              <span class="ln">{i + 1}</span>
              {line}
              {"\n"}
            </span>
          ))}
          {lines.length > MAX_SHOWN_LINES || file.truncated ? <span class="help">… showing the first {Math.min(lines.length, MAX_SHOWN_LINES).toLocaleString()} lines</span> : null}
        </pre>
      ) : null}
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
  const key = pickedNote ?? (scope === "repo" && here ? here : "general");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ at: number; text: string; revision: number } | null>(null);
  const [history, setHistory] = useState<{ text: string; updatedAt: number; revision: number }[]>([]);
  const [latest, setLatest] = useState<{ text: string; updatedAt: number; revision: number } | null>(null);
  const bases = useRef(new Map<string, { text: string; revision: number }>());
  const saving = useRef(Promise.resolve());
  const activeKey = useRef(key);
  activeKey.current = key;
  const [status, setStatus] = useState("");
  /** The note for `key` has loaded: until then the box is off, so typing can't be overwritten by the load. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    setStatus("Loading…");
    let current = true;
    api<{ text: string; updatedAt: number; revision: number }>(`/api/notes?key=${enc(key)}`).then(
      (n) => {
        if (!current) return;
        let draft: string | null = null;
        try { draft = localStorage.getItem(`notes-draft:${key}`); } catch {}
        setText(draft ?? n.text);
        bases.current.set(key, { text: n.text, revision: n.revision });
        setSaved({ at: n.updatedAt, text: n.text, revision: n.revision });
        setLatest(null); setHistory([]);
        setStatus(draft !== null && draft !== n.text ? "Recovered your unsaved draft" : "");
        setReady(true);
      },
      (err) => current && setStatus((err as Error).message),
    );
    return () => {
      current = false;
    };
  }, [key]);
  // Queue writes so the next save uses the revision returned by the preceding one.
  // Browser drafts survive navigation and an unavailable server.
  useEffect(() => {
    if (!ready || saved?.text === text || latest) return;
    setStatus("Saving…");
    const timer = setTimeout(() => {
      saving.current = saving.current.catch(() => undefined).then(async () => {
        const base = bases.current.get(key);
        if (!base || base.text === text) return;
        try {
          const note = await post<{ updatedAt: number; revision: number }>("/api/notes", { key, text, expectedRevision: base.revision });
          bases.current.set(key, { text, revision: note.revision });
          try { if (localStorage.getItem(`notes-draft:${key}`) === text) localStorage.removeItem(`notes-draft:${key}`); } catch {}
          if (activeKey.current === key) { setSaved({ at: note.updatedAt, text, revision: note.revision }); setStatus(""); }
        } catch (error) {
          if (activeKey.current !== key) return;
          setStatus(`Couldn't save: ${(error as Error).message}. Your draft is kept in this browser.`);
          const current = await api<{ text: string; updatedAt: number; revision: number }>(`/api/notes?key=${enc(key)}`).catch(() => null);
          if (current && current.revision !== base.revision && activeKey.current === key) setLatest(current);
        }
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [text, key, ready, saved?.revision, latest]);
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
      <details><summary>Search saved notes</summary><div class="side-toolbar"><input class="field" aria-label="Search saved notes" placeholder="Words or repository path" value={search} onInput={(event) => setSearch(event.currentTarget.value)} /><button class="btn small" onClick={async () => { try { setMatches(await api(`/api/notes/search?q=${enc(search)}`)); } catch (error) { setStatus((error as Error).message); } }}>Search notes</button></div>{matches ? <>{matches.hits.length ? matches.hits.map((match) => <p key={match.key}><button class="btn ghost small" onClick={() => { setPickedNote(match.key); setMatches(null); }}>{match.key} · revision {match.revision}</button><span class="help">{match.excerpt}</span></p>) : <p class="help">No saved notes match.</p>}{matches.truncated ? <p class="help">Results are limited; narrow the query.</p> : null}</> : null}</details>
      {pickedNote ? <div class="side-toolbar"><span class="help">Editing {pickedNote}</span><button class="btn small" onClick={() => setPickedNote(null)}>Return to current notes</button></div> : null}
      {latest ? <div class="msg err" role="alert"><p>This note changed in another window. Your draft is preserved.</p><details><summary>Compare saved version</summary><pre>{latest.text}</pre></details><button class="btn small" onClick={() => { bases.current.set(key, latest); setText(latest.text); setSaved({ at: latest.updatedAt, text: latest.text, revision: latest.revision }); setLatest(null); try { localStorage.removeItem(`notes-draft:${key}`); } catch {} }}>Use saved version</button><button class="btn small" onClick={() => { bases.current.set(key, latest); setSaved({ at: latest.updatedAt, text: latest.text, revision: latest.revision }); setLatest(null); }}>Save my draft over this version</button></div> : null}
      <div class="side-toolbar"><button class="btn small" disabled={!ready} onClick={async () => { try { setHistory(await api(`/api/notes/history?key=${enc(key)}`)); } catch (error) { setStatus((error as Error).message); } }}>Revision history</button></div>
      {history.length ? <details open><summary>{history.length} saved revisions</summary>{history.map((note) => <div key={note.revision}><details><summary>Revision {note.revision} · {new Date(note.updatedAt).toLocaleString()}</summary><pre>{note.text || "(empty)"}</pre><button class="btn small" disabled={note.revision === saved?.revision || saved?.text !== text} onClick={async () => { try { const restored = await post<{ text: string; updatedAt: number; revision: number }>("/api/notes/restore", { key, revision: note.revision, expectedRevision: saved?.revision }); bases.current.set(key, restored); setSaved({ at: restored.updatedAt, text: restored.text, revision: restored.revision }); setText(restored.text); setHistory([]); setStatus("Restored as a new revision"); } catch (error) { setStatus((error as Error).message); } }}>Restore as new revision</button></details></div>)}</details> : null}
      <textarea id="side-notes" class="notes-area" aria-label="Notes" placeholder="Notes to yourself: what to check, ideas, commands… Saved as you type." spellcheck={false} disabled={!ready} value={text} onInput={(e) => { setText(e.currentTarget.value); try { localStorage.setItem(`notes-draft:${key}`, e.currentTarget.value); } catch {} }} />
      <div class="notes-foot">
        <span>{status || (saved?.at ? `Saved ${ago(saved.at)}` : "")}</span>
        <span class="spacer" />
        <span>{text.length ? `${text.length.toLocaleString()} characters` : ""}</span>
      </div>
    </>
  );
}
