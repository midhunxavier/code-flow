import { useEffect, useState } from "preact/hooks";
import { BrowserTab } from "./browser.js";
import { ChangesTab } from "./changes.js";
import { addContext, FileTree } from "./composer.js";
import { Icon, type IconName } from "./icons.js";
import { ago, api, baseName, enc, fmtSize, onPhone, post, showToast } from "./lib.js";
import { placesFor, PlacePicker, usePlace } from "./panel-bits.js";
import { ChatTab } from "./side-chat.js";
import {
  closeSide,
  openSide,
  pinSide,
  projectKeyOf,
  rememberSide,
  repo,
  restoreSideTab,
  route,
  setSideChat,
  setSideWidth,
  setTask,
  SIDE_TABS,
  sideDraft,
  sideFile,
  sideMemo,
  sideMemory,
  sideOpen,
  sideScope,
  sideTab,
  task,
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
  return (
    <aside class={`side ${sideOpen.value ? "open" : ""} ${popped ? "popped" : ""}`} aria-label="Side panel" aria-hidden={!sideOpen.value}>
      {popped ? null : <div class={`side-handle ${dragging ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize" onPointerDown={startDrag} />}
      <ScopeHeader popped={popped} />
      <div class="side-tabs" role="tablist" aria-label="Side panel tabs">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" id={`side-tab-${t}`} aria-selected={t === tab} aria-controls={`side-pane-${t}`} class={`side-tab ${t === tab ? "on" : ""}`} aria-label={TABS[t].label} title={TABS[t].title} onClick={() => openSide(t)}>
            <Icon name={TABS[t].icon} />
            <span>{TABS[t].label}</span>
          </button>
        ))}
      </div>
      <div class="side-body">
        {tabs.filter((t) => visited.has(t) || t === tab).map((t) => (
          <div key={t} id={`side-pane-${t}`} role="tabpanel" aria-labelledby={`side-tab-${t}`} class="side-pane" hidden={t !== tab}>
            {panes[t]()}
          </div>
        ))}
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
        {where ? <span class="sc-where">{where}</span> : <span class="help">No repository chosen</span>}
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
              <a class="sc-what" href={`#/run/${enc(s.run.id)}`} title="Open this run">
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
  const [open, setOpen] = useState<string | null>(null);
  // Something else asked for a file (a run's diff, a transcript): show it, in its folder.
  useEffect(() => {
    const want = sideFile.value;
    if (!want) return;
    const target = places.find((p) => p.path === want.root);
    if (target) setPlace(target);
    setOpen(want.path);
    sideFile.value = null;
  }, [sideFile.value]);
  const viewKey = place?.path ?? "";
  useEffect(() => setOpen(null), [viewKey]);
  return (
    <>
      <div class="side-toolbar">
        <PlacePicker label="Folder" place={place} places={places} onChange={setPlace} />
      </div>
      {place && open ? <FileViewer root={place.path} path={open} onClose={() => setOpen(null)} /> : <FileTree root={place?.path ?? ""} onOpen={setOpen} />}
    </>
  );
}

const MAX_SHOWN_LINES = 5_000;

function FileViewer({ root, path, onClose }: { root: string; path: string; onClose: () => void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setFile(null);
    setError("");
    api<FileContent>(`/api/file?repo=${enc(root)}&path=${enc(path)}`).then(setFile, (err) => setError((err as Error).message));
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
  const key = scope === "repo" && here ? here : "general";
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ at: number; text: string } | null>(null);
  const [status, setStatus] = useState("");
  /** The note for `key` has loaded: until then the box is off, so typing can't be overwritten by the load. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    setStatus("Loading…");
    let current = true;
    api<{ text: string; updatedAt: number }>(`/api/notes?key=${enc(key)}`).then(
      (n) => {
        if (!current) return;
        setText(n.text);
        setSaved({ at: n.updatedAt, text: n.text });
        setStatus("");
        setReady(true);
      },
      (err) => current && setStatus((err as Error).message),
    );
    return () => {
      current = false;
    };
  }, [key]);
  // Saved as you type, a moment after you stop.
  useEffect(() => {
    if (!ready || saved?.text === text) return;
    setStatus("Saving…");
    const timer = setTimeout(() => {
      post<{ updatedAt: number }>("/api/notes", { key, text }).then(
        (n) => {
          setSaved({ at: n.updatedAt, text });
          setStatus("");
        },
        (err) => setStatus(`Couldn't save: ${(err as Error).message}`),
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [text, key]);
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
            <button type="button" class={scope === "repo" ? "on" : ""} aria-pressed={scope === "repo"} onClick={() => setScope("repo")} title={here}>
              {baseName(here)}
            </button>
            <button type="button" class={scope === "general" ? "on" : ""} aria-pressed={scope === "general"} onClick={() => setScope("general")}>
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
            const add = selection();
            setTask(task.value.trim() ? `${task.value.trimEnd()}\n\n${add}` : add);
            route.value = { view: "composer" };
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
      <textarea id="side-notes" class="notes-area" aria-label="Notes" placeholder="Notes to yourself: what to check, ideas, commands… Saved as you type." spellcheck={false} disabled={!ready} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="notes-foot">
        <span>{status || (saved?.at ? `Saved ${ago(saved.at)}` : "")}</span>
        <span class="spacer" />
        <span>{text.length ? `${text.length.toLocaleString()} characters` : ""}</span>
      </div>
    </>
  );
}
