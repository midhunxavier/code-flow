import { useEffect, useRef, useState } from "preact/hooks";
import { addContext, FileTree } from "./composer.js";
import { AgentPicker, ChatThread, ConversationBar, useRunStream } from "./run.js";
import { AgentTag, Markdown } from "./bits.js";
import { Icon, type IconName } from "./icons.js";
import { ago, api, baseName, enc, fmtSize, onPhone, post, SHORT, showToast, store, STATUS_TEXT } from "./lib.js";
import {
  agents,
  agentSettings,
  closeSide,
  limits,
  openSide,
  patterns,
  repo,
  route,
  runs,
  runState,
  setSideChat,
  setSideWidth,
  setTask,
  SIDE_TABS,
  sideChat,
  sideDraft,
  sideFile,
  sideOpen,
  sideTab,
  sideWidth,
  task,
  trust,
  type SideTab,
} from "./state.js";
import type { AgentId, DevServer, FileContent, RunSummary, ShellEvent, ShellInfo } from "./types.js";

/**
 * The side panel: what you'd keep open next to the work in Claude's or Codex's app. A chat with
 * one agent (you pick which), the files of the repository or of a run's worktree, a terminal, a
 * browser for the app a run started, and your notes. It stays as you move between runs.
 */

const TABS: Record<SideTab, { label: string; icon: IconName; title: string }> = {
  chat: { label: "Chat", icon: "chat", title: "Chat with one agent about this repository" },
  files: { label: "Files", icon: "files", title: "The repository's files, or a run's worktree" },
  terminal: { label: "Terminal", icon: "terminal", title: "A shell in the repository or a worktree" },
  browser: { label: "Browser", icon: "globe", title: "Open the app a run started, or any address" },
  notes: { label: "Notes", icon: "note", title: "Your scratchpad for this repository" },
};

export function SidePanel() {
  const tab = sideTab.value;
  // Tabs you've opened stay mounted: the terminal and the browser keep their state behind another tab.
  const [visited, setVisited] = useState<Set<SideTab>>(() => new Set([tab]));
  useEffect(() => {
    if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  }, [tab]);
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
  const panes: Record<SideTab, () => preact.JSX.Element> = { chat: () => <ChatTab />, files: () => <FilesTab />, terminal: () => <TerminalTab />, browser: () => <BrowserTab />, notes: () => <NotesTab /> };
  return (
    <aside class={`side ${sideOpen.value ? "open" : ""}`} aria-label="Side panel" aria-hidden={!sideOpen.value}>
      <div class={`side-handle ${dragging ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize" onPointerDown={startDrag} />
      <div class="side-tabs" role="tablist" aria-label="Side panel tabs">
        {SIDE_TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`side-tab-${t}`} aria-selected={t === tab} aria-controls={`side-pane-${t}`} class={`side-tab ${t === tab ? "on" : ""}`} title={TABS[t].title} onClick={() => openSide(t)}>
            <Icon name={TABS[t].icon} />
            <span>{TABS[t].label}</span>
          </button>
        ))}
        <button type="button" class="btn ghost small side-close" aria-label="Close side panel" title="Close (\)" onClick={closeSide}>
          <Icon name="close" />
        </button>
      </div>
      <div class="side-body">
        {SIDE_TABS.filter((t) => visited.has(t) || t === tab).map((t) => (
          <div key={t} id={`side-pane-${t}`} role="tabpanel" aria-labelledby={`side-tab-${t}`} class="side-pane" hidden={t !== tab}>
            {panes[t]()}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- where: the repo or a run's worktree
interface Place {
  label: string;
  path: string;
  /** The run this worktree belongs to, when it's one. */
  runId?: string;
}

/** The run open in the main view, if any. */
const openRun = (): RunSummary | undefined => ("id" in route.value ? runs.value.get(route.value.id) : undefined);

/**
 * The folders the panel can look at: the chosen repository, and the worktrees of the run you're
 * looking at. Following the view: opening a run moves to its worktree until you pick another.
 */
function usePlace(preferWorktree: boolean): [Place | undefined, (p: Place) => void, Place[]] {
  const run = openRun();
  const places: Place[] = [];
  if (repo.value) places.push({ label: `${baseName(repo.value)} · repository`, path: repo.value });
  if (run) {
    if (run.repo !== repo.value) places.push({ label: `${baseName(run.repo)} · repository`, path: run.repo });
    for (const wt of run.worktrees) places.push({ label: `${wt.name} · ${wt.branch}`, path: wt.path, runId: run.id });
  }
  const [picked, setPicked] = useState<string | null>(null);
  const viewKey = "id" in route.value ? route.value.id : route.value.view;
  useEffect(() => setPicked(null), [viewKey]);
  const current = places.find((p) => p.path === picked) ?? (preferWorktree && run?.worktrees.length ? places.find((p) => p.runId) : undefined) ?? places[0];
  return [current, (p) => setPicked(p.path), places];
}

function PlacePicker({ place, places, onChange, label }: { place?: Place; places: Place[]; onChange: (p: Place) => void; label: string }) {
  if (!places.length) return <span class="help">Choose a repository first.</span>;
  return (
    <select class="field" aria-label={label} title={place?.path} value={place?.path ?? ""} onChange={(e) => onChange(places.find((p) => p.path === e.currentTarget.value) ?? places[0]!)}>
      {places.map((p) => (
        <option key={p.path} value={p.path}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- chat
/** Patterns that are a conversation with one agent (Single agent). */
const chatPatterns = () => new Set(patterns.value.filter((p) => p.chat).map((p) => p.id));

function ChatTab() {
  const id = sideChat.value;
  const kinds = chatPatterns();
  const chats = [...runs.value.values()].filter((r) => kinds.has(r.pattern) && !r.archived && (!repo.value || r.repo === repo.value)).sort((a, b) => b.createdAt - a.createdAt);
  // The chat you were in stays listed even from another repository, until you leave it.
  const current = id ? runs.value.get(id) : undefined;
  const listed = current && kinds.has(current.pattern) && !chats.some((r) => r.id === current.id) ? [current, ...chats] : chats;
  return (
    <>
      <div class="side-toolbar">
        <select
          class="field"
          aria-label="Chat"
          value={current && kinds.has(current.pattern) ? current.id : ""}
          onChange={(e) => setSideChat(e.currentTarget.value || null)}
        >
          <option value="">New chat</option>
          {listed.length ? (
            <optgroup label={repo.value ? `Chats in ${baseName(repo.value)}` : "Chats"}>
              {listed.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.status === "running" ? "● " : ""}
                  {r.task.split("\n")[0]!.slice(0, 60)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {current ? (
          <a class="btn ghost small" href={`#/run/${enc(current.id)}`} title="Open this chat as a run, with its branch and result">
            Open
          </a>
        ) : null}
        <button type="button" class="btn ghost small" title="New chat" aria-label="New chat" onClick={() => setSideChat(null)}>
          <Icon name="plus" />
        </button>
      </div>
      {current ? <ChatView key={current.id} id={current.id} /> : <NewChat />}
    </>
  );
}

/** A chat in progress: the Single-agent run's thread and its composer, compact. */
function ChatView({ id }: { id: string }) {
  const { run, problem, data, version } = useRunStream(id);
  const scroll = useRef<HTMLDivElement>(null);
  // Follow the conversation unless you scrolled up to read.
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [version, run?.status, run?.followUps?.length]);
  if (problem) {
    return (
      <div class="side-empty">
        <p class="msg err">{problem}</p>
        <button class="btn" onClick={() => setSideChat(null)}>
          New chat
        </button>
      </div>
    );
  }
  if (!run) return <div class="side-empty help">Loading…</div>;
  const steps = [...data.current.steps.values()];
  const agent = Object.values(run.roles).flat()[0] as AgentId | undefined;
  const state = runState(run);
  const branch = run.artifacts[0]?.branch ?? run.worktrees[0]?.branch;
  return (
    <>
      <div class="chat-scroll" ref={scroll}>
        <div class="thread">
          <div class="chat-meta">
            <AgentTag id={agent} />
            <span class={`status-pill ${state}`}>{STATUS_TEXT[run.status] ?? run.status}</span>
            {branch ? (
              <code title="The branch this chat works on">{branch}</code>
            ) : null}
            {state === "failing" ? <span class="note">check fails</span> : run.verdict === "passed" ? <span class="ok">check passes</span> : null}
          </div>
          <div class="msg-you">
            <div class="bubble">
              <Markdown text={run.task} />
            </div>
          </div>
          <ChatThread run={run} steps={steps} data={data.current} />
          {["interrupted", "stopped", "failed", "cancelled"].includes(run.status) ? (
            <div class="chat-resume">
              <span class="help">{run.status === "interrupted" ? "This chat was interrupted." : `This chat ${STATUS_TEXT[run.status]?.toLowerCase() ?? run.status}.`}</span>
              <button class="btn small" onClick={() => post(`/api/runs/${run.id}/resume`).catch((e) => showToast(e.message))}>
                ▶ Resume
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <ConversationBar run={run} steps={steps} chat />
    </>
  );
}

/** Where a new chat starts: a fresh Single-agent run on the repository, with the agent you pick. */
function NewChat() {
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<AgentId>(() => {
    const saved = store.get("sideAgent") as AgentId | null;
    return saved && agents.value.some((a) => a.id === saved && a.available) ? saved : (agents.value.find((a) => a.available)?.id ?? "claude");
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [base, setBase] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  // Text sent over from Notes (or a file) lands in the box.
  useEffect(() => {
    if (!sideDraft.value) return;
    setText((t) => (t ? `${t}\n\n${sideDraft.value}` : sideDraft.value));
    sideDraft.value = "";
    area.current?.focus();
  }, [sideDraft.value]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const solo = patterns.value.find((p) => p.chat);
  const run = openRun();
  /** A run's result branch the chat can start from, so the agent sees that work. */
  const fromRun = run && run.repo === repo.value ? run.artifacts.map((a) => a.branch) : [];
  const name = SHORT[agent] ?? agent;
  const send = async () => {
    if (!text.trim() || busy || !solo) return;
    if (!repo.value) return setError("Choose a repository first.");
    setBusy(true);
    setError("");
    try {
      const { id } = await post<{ id: string }>("/api/runs", {
        repo: repo.value,
        task: text.trim(),
        pattern: solo.id,
        roles: { agent: [agent] },
        options: {},
        baseRef: base || undefined,
        agentSettings: agentSettings.value,
        trust: trust.value,
        loop: { maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps },
        parentRunId: base && run ? run.id : undefined,
      });
      setText("");
      setSideChat(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="chat-scroll">
        <div class="side-empty">
          <h3>Chat with {name}</h3>
          <p class="help">
            Ask a question or ask for a change. {name} works on its own branch of {repo.value ? baseName(repo.value) : "the repository"} and you keep talking to it; its reply shows here and the chat is a run like any other.
          </p>
          {!solo ? <p class="msg warn">This code-flow has no Single-agent pattern, which the chat needs.</p> : null}
        </div>
      </div>
      <div class="convo">
        <div class="convo-inner">
          {error ? <div class="msg err">{error}</div> : null}
          <div class="chatbox">
            <textarea
              ref={area}
              rows={1}
              aria-label="Message"
              placeholder={`Message ${name}…`}
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div class="chatbox-bar">
              <label class="to">
                <span class="to-lbl">Agent</span>
                <AgentPicker
                  value={agent}
                  onChange={(id) => {
                    setAgent(id);
                    store.set("sideAgent", id);
                  }}
                />
              </label>
              {fromRun.length ? (
                <label class="to" title="Start from this run's result branch, so the agent sees that work">
                  <span class="to-lbl">From</span>
                  <select aria-label="Start from" value={base} onChange={(e) => setBase(e.currentTarget.value)}>
                    <option value="">HEAD</option>
                    {fromRun.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <span class="chatbox-hint" />
              <button class="send" aria-label="Send" title="Send (↵ — ⇧↵ for a new line)" disabled={busy || !text.trim() || !solo} onClick={send}>
                <Icon name="send" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- files
function FilesTab() {
  const [place, setPlace, places] = usePlace(true);
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

// ---------------------------------------------------------------- terminal
type Line = ShellEvent;

function TerminalTab() {
  const [place, setPlace, places] = usePlace(false);
  const cwd = place?.path ?? "";
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>(() => store.json("termHistory", []));
  const [at, setAt] = useState(-1);
  const [error, setError] = useState("");
  const out = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Opening a shell for a folder; a second request for the same folder waits for it. */
  const opening = useRef<Promise<ShellInfo> | null>(null);
  /** Bumped to connect again (after Restart); `fresh` says to open a new shell rather than reattach. */
  const [generation, setGeneration] = useState(0);
  const fresh = useRef(false);

  /** The shell for this folder: one that's already open there, or a new one. */
  const attach = async (fresh = false): Promise<ShellInfo | null> => {
    if (!cwd) return null;
    if (!fresh) {
      const open = await api<ShellInfo[]>("/api/shell").catch(() => [] as ShellInfo[]);
      const existing = open.find((s) => s.cwd === cwd && s.status === "running") ?? open.find((s) => s.status === "running" && s.cwd.startsWith(cwd + "/"));
      if (existing) return existing;
    }
    opening.current ??= post<ShellInfo>("/api/shell", { cwd }).finally(() => (opening.current = null));
    return opening.current;
  };

  useEffect(() => {
    if (!cwd) return;
    let source: EventSource | undefined;
    let closed = false;
    setLines([]);
    setShell(null);
    setError("");
    const connect = async (openNew = false) => {
      try {
        const s = await attach(openNew);
        if (!s || closed) return;
        setShell(s);
        source = new EventSource(`/api/shell/${s.id}/events`);
        source.onmessage = (msg) => {
          const ev = JSON.parse(msg.data) as ShellEvent | { type: "hello"; shell: ShellInfo; history: ShellEvent[] };
          if (ev.type === "hello") {
            setShell(ev.shell);
            setLines(ev.history);
            return;
          }
          setLines((l) => append(l, ev));
          if (ev.type === "done") setShell((cur) => (cur ? { ...cur, busy: false, cwd: ev.cwd } : cur));
          else if (ev.type === "exit") setShell((cur) => (cur ? { ...cur, status: "exited", exitCode: ev.code, busy: false } : cur));
          else if (ev.type === "input") setShell((cur) => (cur ? { ...cur, busy: true } : cur));
        };
        // The stream closed for good: the shell is gone (code-flow restarted). Open a new one.
        source.onerror = () => {
          if (source?.readyState !== EventSource.CLOSED || closed) return;
          source.close();
          api(`/api/shell/${s.id}`).then(
            () => setTimeout(() => void connect(), 2_000),
            () => void connect(true),
          );
        };
      } catch (err) {
        if (!closed) setError((err as Error).message);
      }
    };
    void connect(fresh.current);
    fresh.current = false;
    return () => {
      closed = true;
      source?.close();
    };
  }, [cwd, generation]);

  // Keep the newest output in view.
  useEffect(() => {
    const el = out.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = async () => {
    const text = command;
    if (!shell || !text.trim()) return;
    setCommand("");
    setAt(-1);
    const next = [text, ...history.filter((h) => h !== text)].slice(0, 100);
    setHistory(next);
    store.set("termHistory", JSON.stringify(next));
    try {
      await post(`/api/shell/${shell.id}/input`, { text });
    } catch (err) {
      showToast((err as Error).message, 4000);
    }
  };
  /** Stop whatever is running: the shell goes with it, and a new one opens in the same folder. */
  const restart = async () => {
    if (shell) await api(`/api/shell/${shell.id}`, { method: "DELETE" }).catch(() => {});
    fresh.current = true;
    setGeneration((n) => n + 1);
  };

  const prompt = shell ? `${baseName(shell.cwd)} $` : "$";
  return (
    <>
      <div class="side-toolbar">
        <PlacePicker label="Terminal folder" place={place} places={places} onChange={setPlace} />
        <button type="button" class="btn ghost small" title="Clear the output" onClick={() => setLines([])}>
          Clear
        </button>
        <button type="button" class={`btn ghost small ${shell?.busy ? "danger" : ""}`} title={shell?.busy ? "Stop what's running (the shell restarts in the same folder)" : "Start a new shell in this folder"} onClick={() => void restart()}>
          <Icon name={shell?.busy ? "stop" : "refresh"} /> {shell?.busy ? "Stop" : "Restart"}
        </button>
      </div>
      <div class="term" onClick={(e) => (e.target as HTMLElement).closest("pre") && !window.getSelection()?.toString() && input.current?.focus()}>
        <pre class="term-out" ref={out} aria-live="polite" aria-label="Terminal output">
          {!lines.length ? (
            <span class="help">
              {error || (shell ? `${shell.shell} in ${shell.cwd}. Commands run here, not in an interactive terminal: no pagers or full-screen programs.` : cwd ? "Opening a shell…" : "Choose a repository first.")}
            </span>
          ) : null}
          {lines.map((l, i) =>
            l.type === "input" ? (
              <span key={i} class="in">
                {`$ ${l.text}\n`}
              </span>
            ) : l.type === "output" ? (
              <span key={i}>{l.text}</span>
            ) : l.type === "done" ? (
              l.code ? (
                <span key={i} class="exit">{`exit ${l.code}\n`}</span>
              ) : null
            ) : (
              <span key={i} class="exit">{`\n[shell exited${l.code === null ? "" : ` with ${l.code}`} — Restart opens a new one]\n`}</span>
            ),
          )}
        </pre>
        <div class="term-row">
          <span class="prompt" title={shell?.cwd}>
            {shell?.busy ? <span class="term-busy" aria-label="Running" /> : null}
            {prompt}
          </span>
          <input
            ref={input}
            type="text"
            aria-label="Command"
            placeholder={shell?.status === "exited" ? "The shell exited — Restart" : "Type a command and press ↵"}
            autocomplete="off"
            spellcheck={false}
            disabled={!shell || shell.status === "exited"}
            value={command}
            onInput={(e) => setCommand(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void send();
              } else if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const n = Math.min(history.length - 1, at + 1);
                setAt(n);
                setCommand(history[n] ?? "");
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = Math.max(-1, at - 1);
                setAt(n);
                setCommand(n < 0 ? "" : history[n] ?? "");
              } else if (e.key === "c" && e.ctrlKey) {
                e.preventDefault();
                void restart();
              }
            }}
          />
        </div>
      </div>
    </>
  );
}

/** Output comes in many pieces: join runs of output so the list stays short. */
function append(lines: Line[], ev: ShellEvent): Line[] {
  const last = lines.at(-1);
  if (ev.type === "output" && last?.type === "output" && last.text.length < 8_192) return [...lines.slice(0, -1), { type: "output", text: last.text + ev.text }];
  return lines.length > 4_000 ? [...lines.slice(-3_000), ev] : [...lines, ev];
}

// ---------------------------------------------------------------- browser
function BrowserTab() {
  const [url, setUrl] = useState(store.get("sideUrl") ?? "");
  const [typed, setTyped] = useState(url);
  const [servers, setServers] = useState<Omit<DevServer, "logs">[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = () => api<Omit<DevServer, "logs">[]>("/api/serve").then((s) => alive && setServers(s), () => {});
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const go = (target: string) => {
    let next = target.trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) next = /^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/.test(next) ? `http://${next}` : `https://${next}`;
    // From the phone, the app is on the computer's Wi-Fi address — reachable if it listens there.
    if (onPhone) next = next.replace("//localhost:", `//${location.hostname}:`).replace("//127.0.0.1:", `//${location.hostname}:`);
    setUrl(next);
    setTyped(next);
    store.set("sideUrl", next);
    setNonce((n) => n + 1);
  };
  const running = servers.filter((s) => s.status === "running");
  return (
    <>
      <div class="side-toolbar browse-bar">
        <input
          type="url"
          class="field mono"
          aria-label="Address"
          placeholder="localhost:3000, or an address…"
          value={typed}
          onInput={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && go(typed)}
        />
        <button type="button" class="btn ghost small" title="Reload" aria-label="Reload" disabled={!url} onClick={() => setNonce((n) => n + 1)}>
          <Icon name="refresh" />
        </button>
        <a class={`btn ghost small ${url ? "" : "off"}`} href={url || "#"} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab" aria-disabled={!url}>
          <Icon name="external" />
        </a>
      </div>
      {running.length ? (
        <div class="browse-apps">
          <span class="lbl">Running</span>
          {running.map((s) => (
            <button key={s.key} type="button" class="chip-tpl" title={`${s.command} in ${s.cwd}`} aria-pressed={url === s.url} onClick={() => go(s.url)}>
              {baseName(s.cwd)} · :{s.port}
            </button>
          ))}
        </div>
      ) : null}
      <div class="browse">
        {url ? (
          <iframe key={`${url}#${nonce}`} src={url} title="Browser" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
        ) : (
          <div class="browse-empty">
            <p>Open the app a run started with <b>Run app</b>, or type an address.</p>
            <p class="help">Some sites refuse to be shown inside another page; those open in a new tab instead.</p>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- notes
function NotesTab() {
  const [scope, setScope] = useState<"repo" | "general">(repo.value ? "repo" : "general");
  const key = scope === "repo" && repo.value ? repo.value : "general";
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
        {repo.value ? (
          <div class="segmented small" role="group" aria-label="Which notes">
            <button type="button" class={scope === "repo" ? "on" : ""} aria-pressed={scope === "repo"} onClick={() => setScope("repo")} title={repo.value}>
              {baseName(repo.value)}
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
