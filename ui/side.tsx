import { useEffect, useRef, useState } from "preact/hooks";
import { addContext, FileTree } from "./composer.js";
import { AgentPicker, ChatThread, ConversationBar, useRunStream } from "./run.js";
import { AgentTag, Markdown } from "./bits.js";
import { Icon, type IconName } from "./icons.js";
import { ago, api, baseName, enc, fmtSize, onPhone, post, SHORT, showToast, store, STATUS_TEXT } from "./lib.js";
import {
  afterStart,
  agents,
  agentSettings,
  closeSide,
  limits,
  openSide,
  patterns,
  pinSide,
  projectFor,
  projectKeyOf,
  rememberSide,
  repo,
  restoreSideTab,
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
  sideMemo,
  sideMemory,
  sideOpen,
  sideScope,
  sideTab,
  sideWidth,
  task,
  trust,
  type SideScope,
  type SideTab,
} from "./state.js";
import type { AgentId, DevServer, FileContent, RunSummary, ShellEvent, ShellInfo } from "./types.js";

/**
 * The side panel: what you'd keep open next to the work in Claude's or Codex's app. A chat with
 * one agent (you pick which), the files of the repository or of a run's worktree, a terminal, a
 * browser for the app a run started, and your notes. It follows what you open (see `sideScope`):
 * on a run, every tab is that run's, and each run keeps its own chat, folders and address.
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
  const panes: Record<SideTab, () => preact.JSX.Element> = { chat: () => <ChatTab />, files: () => <FilesTab />, terminal: () => <TerminalTab />, browser: () => <BrowserTab />, notes: () => <NotesTab /> };
  return (
    <aside class={`side ${sideOpen.value ? "open" : ""}`} aria-label="Side panel" aria-hidden={!sideOpen.value}>
      <div class={`side-handle ${dragging ? "dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize" onPointerDown={startDrag} />
      <ScopeHeader />
      <div class="side-tabs" role="tablist" aria-label="Side panel tabs">
        {SIDE_TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`side-tab-${t}`} aria-selected={t === tab} aria-controls={`side-pane-${t}`} class={`side-tab ${t === tab ? "on" : ""}`} title={TABS[t].title} onClick={() => openSide(t)}>
            <Icon name={TABS[t].icon} />
            <span>{TABS[t].label}</span>
          </button>
        ))}
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

// ---------------------------------------------------------------- what the panel is about
/** The project and run the panel is showing, and the pin that keeps it there while you open others. */
function ScopeHeader() {
  const s = sideScope.value;
  const thing = s.run ? "run" : "project";
  const where = s.project?.name ?? (s.repo ? baseName(s.repo) : "");
  const task = s.run ? s.run.task.split("\n")[0] || "(no task)" : "";
  return (
    <div class={`side-scope ${s.pinned ? "pinned" : ""}`}>
      <span class="scope-state" title={s.pinned ? `The panel stays on this ${thing} while you open others` : "The panel follows what you open"}>
        {s.pinned ? <Icon name="pin" /> : <span class="scope-dot" aria-hidden="true" />}
        {s.pinned ? "Pinned" : "Following"}
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
      {s.pinned ? (
        <button type="button" class="btn ghost small" title="Follow what you open again" onClick={() => pinSide(false)}>
          Follow
        </button>
      ) : (
        <button type="button" class="icon-btn" aria-label={`Pin the panel to this ${thing}`} title={`Pin: keep the panel on this ${thing} while you open others`} disabled={!s.repo} onClick={() => pinSide(true)}>
          <Icon name="pin" />
        </button>
      )}
      <button type="button" class="icon-btn" aria-label="Close side panel" title="Close (\)" onClick={closeSide}>
        <Icon name="close" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- where: a run's worktrees, or the repository
interface Place {
  label: string;
  path: string;
  /** The run this worktree belongs to, when it's one. */
  runId?: string;
}

/** The folders the panel can show: a run's worktrees and its repository, or the project's repositories. */
function placesFor(s: SideScope): Place[] {
  const places: Place[] = [];
  if (s.run) for (const wt of s.run.worktrees) places.push({ label: `${wt.name} · ${wt.branch}`, path: wt.path, runId: s.run.id });
  const repos = s.run ? [s.run.repo] : [s.repo, ...(s.project?.repos ?? [])];
  for (const r of new Set(repos.filter(Boolean))) places.push({ label: `${baseName(r)} · repository`, path: r });
  return places;
}

/** The folder a tab shows, remembered per run or project. A run starts on its result's worktree. */
function usePlace(tab: "files" | "terminal"): [Place | undefined, (p: Place) => void, Place[]] {
  const s = sideScope.value;
  const places = placesFor(s);
  const result = s.run?.artifacts[0]?.path;
  const current = places.find((p) => p.path === sideMemo.value[tab]) ?? places.find((p) => p.path === result) ?? places[0];
  return [current, (p) => rememberSide({ [tab]: p.path }), places];
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
  const s = sideScope.value;
  const kinds = chatPatterns();
  // Not the run you're looking at itself, when it's a chat: it's open already.
  const chats = [...runs.value.values()].filter((r) => kinds.has(r.pattern) && !r.archived && r.id !== s.run?.id).sort((a, b) => b.createdAt - a.createdAt);
  // On a run, the chats started from it first; then the other chats in its project (or repository, without one).
  const about = s.run ? chats.filter((r) => r.parentRunId === s.run!.id) : [];
  const nearby = chats.filter((r) => !about.includes(r) && (s.project ? projectFor(r)?.id === s.project.id : !!s.repo && r.repo === s.repo));
  const where = s.project?.name ?? (s.repo ? baseName(s.repo) : "");
  // The chat you were in here stays listed even once it's archived, until you leave it.
  const id = sideChat.value;
  const current = id ? runs.value.get(id) : undefined;
  const shown = current && kinds.has(current.pattern) ? current : undefined;
  const stray = shown && !about.includes(shown) && !nearby.includes(shown) ? [shown] : [];
  const option = (r: RunSummary) => (
    <option key={r.id} value={r.id}>
      {r.status === "running" ? "● " : ""}
      {r.task.split("\n")[0]!.slice(0, 60)}
    </option>
  );
  return (
    <>
      <div class="side-toolbar">
        <select class="field" aria-label="Chat" value={shown?.id ?? ""} onChange={(e) => setSideChat(e.currentTarget.value || null)}>
          <option value="">New chat</option>
          {stray.length ? <optgroup label="This chat">{stray.map(option)}</optgroup> : null}
          {about.length ? <optgroup label="About this run">{about.map(option)}</optgroup> : null}
          {nearby.length ? <optgroup label={where ? `Chats in ${where}` : "Chats"}>{nearby.map(option)}</optgroup> : null}
        </select>
        {shown ? (
          <a class="btn ghost small" href={`#/run/${enc(shown.id)}`} title="Open this chat as a run, with its branch and result">
            Open
          </a>
        ) : null}
        <button type="button" class="btn ghost small" title="New chat" aria-label="New chat" onClick={() => setSideChat(null)}>
          <Icon name="plus" />
        </button>
      </div>
      {shown ? <ChatView key={shown.id} id={shown.id} /> : <NewChat key={s.key} scope={s} />}
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

/**
 * Where a new chat starts: a fresh Single-agent run, with the agent you pick, in the panel's
 * repository. On a run, it's about that run: it starts from the run's result unless you pick HEAD.
 */
function NewChat({ scope }: { scope: SideScope }) {
  const run = scope.run;
  /** The run's result branches the chat can start from, so the agent sees that work. */
  const fromRun = run ? run.artifacts.map((a) => a.branch) : [];
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<AgentId>(() => {
    const saved = store.get("sideAgent") as AgentId | null;
    return saved && agents.value.some((a) => a.id === saved && a.available) ? saved : (agents.value.find((a) => a.available)?.id ?? "claude");
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [base, setBase] = useState(fromRun[0] ?? "");
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
  const name = SHORT[agent] ?? agent;
  const where = scope.repo ? baseName(scope.repo) : "the repository";
  const send = async () => {
    if (!text.trim() || busy || !solo) return;
    if (!scope.repo) return setError("Choose a repository first.");
    setBusy(true);
    setError("");
    try {
      const { id, project } = await post<{ id: string; project?: string }>("/api/runs", {
        repo: scope.repo,
        // In the panel's project; a chat about a run goes in that run's project.
        project: run ? undefined : scope.project?.id,
        task: text.trim(),
        pattern: solo.id,
        roles: { agent: [agent] },
        options: {},
        baseRef: base || undefined,
        agentSettings: agentSettings.value,
        trust: trust.value,
        loop: { maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps },
        parentRunId: run?.id,
      });
      setText("");
      setSideChat(id);
      // A chat in a repo no project held made one: the panel is then about that project, so keep the chat open there.
      void afterStart(project).then(() => {
        if (sideScope.value.key !== scope.key && scope.key.startsWith("repo:")) setSideChat(id);
      });
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
            {run
              ? `Ask about this run or ask for a change. ${name} works on a branch of its own${base ? ", starting from the run's result" : ""}, and you keep talking to it; the chat is a run like any other.`
              : `Ask a question or ask for a change. ${name} works on its own branch of ${where} and you keep talking to it; its reply shows here and the chat is a run like any other.`}
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

// ---------------------------------------------------------------- terminal
type Line = ShellEvent;

function TerminalTab() {
  const [place, setPlace, places] = usePlace("terminal");
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
/** An address as the browser should load it: with a scheme, and from the phone, on the computer's Wi-Fi address. */
function address(target: string): string {
  let next = target.trim();
  if (!next) return "";
  if (!/^https?:\/\//i.test(next)) next = /^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/.test(next) ? `http://${next}` : `https://${next}`;
  // From the phone, the app is on the computer's Wi-Fi address — reachable if it listens there.
  if (onPhone) next = next.replace("//localhost:", `//${location.hostname}:`).replace("//127.0.0.1:", `//${location.hostname}:`);
  return next;
}

function BrowserTab() {
  const s = sideScope.value;
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
  const running = servers.filter((x) => x.status === "running");
  // The apps started in the panel's folders come first: a run's own worktrees (every run's sit inside
  // the repository), or anywhere in the project's repositories.
  const within = (cwd: string, folder: string) => cwd === folder || cwd.startsWith(`${folder}/`);
  const folders = s.run ? s.run.worktrees.map((w) => w.path) : placesFor(s).map((p) => p.path);
  const mine = running.filter((x) => folders.some((f) => within(x.cwd, f)));
  const apps = [...mine, ...running.filter((x) => !mine.includes(x))];
  // What you had open here; else the app this run or project started; else what you had open for the run's project.
  const url = sideMemo.value.url || (mine[0] ? address(mine[0].url) : "") || (s.run ? sideMemory.value[projectKeyOf(s.run)]?.url : "") || "";
  const [typed, setTyped] = useState(url);
  useEffect(() => setTyped(url), [url]);
  const go = (target: string) => {
    const next = address(target);
    if (!next) return;
    rememberSide({ url: next });
    setTyped(next);
    setNonce((n) => n + 1);
  };
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
      {apps.length ? (
        <div class="browse-apps">
          <span class="lbl">Running</span>
          {apps.map((x) => (
            <button key={x.key} type="button" class="chip-tpl" title={`${x.command} in ${x.cwd}`} aria-pressed={url === address(x.url)} onClick={() => go(x.url)}>
              {baseName(x.cwd)} · :{x.port}
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
