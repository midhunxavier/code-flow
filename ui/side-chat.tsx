import { useEffect, useRef, useState } from "preact/hooks";
import { AgentTag, Markdown } from "./bits.js";
import { Icon } from "./icons.js";
import { ChatControls, type ChatPermissions, type ChatSettings } from "./chat-controls.js";
import { baseName, post, SHORT, showToast, store, STATUS_TEXT } from "./lib.js";
import { Menu, MenuItem, MenuTitle, resultWorktree, Strip, type StripItem } from "./panel-bits.js";
import { ChatThread, ConversationBar, DraftImages, FollowUpBadges, teamSteps, TurnBody, useRunStream } from "./run.js";
import {
  afterStart,
  agents,
  agentSettings,
  chatDrafts,
  limits,
  markSeen,
  patterns,
  projectFor,
  rememberSide,
  runs,
  runState,
  setSideChat,
  setAgentSetting,
  setTrust,
  sideChat,
  sideDraft,
  sideMemo,
  sideOpen,
  sideScope,
  sideTab,
  takeDrafts,
  trust,
  type SideScope,
} from "./state.js";
import type { AgentId, Attachment, FollowUp, RunSummary } from "./types.js";

/**
 * The side panel's Chat tab. On a run, a side chat works in the run's own worktree: Ask reads it,
 * Change edits it (committed and checked like a reply), and each side chat is a conversation of its
 * own. Anywhere else, a chat is a Single-agent run on its own branch. Several can be open at once,
 * in a strip like browser tabs; each run or project remembers its own.
 */

/** Patterns that are a conversation with one agent (Single agent). */
const chatPatterns = () => new Set(patterns.value.filter((p) => p.chat).map((p) => p.id));

/** A side chat on a run: its turns, in order. */
export interface SideChat {
  key: string;
  chat: string;
  title: string;
  turns: FollowUp[];
  agent: AgentId;
  mode: "ask" | "change";
}

export function sideChatsOf(run: RunSummary): SideChat[] {
  const chats = new Map<string, SideChat>();
  for (const f of run.followUps) {
    if (!f.side) continue;
    const c = chats.get(f.side.chat) ?? { key: `side:${f.side.chat}`, chat: f.side.chat, title: f.side.title, turns: [], agent: f.agent, mode: f.side.mode };
    c.turns.push(f);
    c.agent = f.agent;
    c.mode = f.side.mode;
    chats.set(f.side.chat, c);
  }
  return [...chats.values()];
}

/**
 * A side chat and the run snapshot to show it from. The run's stream replays its history from the
 * start, and its first snapshots are older than the feed's and don't have the chat yet: until the
 * stream has it, the feed's snapshot stands in, so the view (and the text in its composer) stays put.
 */
export function sideChatIn(live: RunSummary | null, summary: RunSummary, chat: string): { run: RunSummary; chat: SideChat } | undefined {
  const streamed = live ? sideChatsOf(live).find((x) => x.chat === chat) : undefined;
  if (streamed) return { run: live!, chat: streamed };
  const fed = sideChatsOf(summary).find((x) => x.chat === chat);
  return fed ? { run: summary, chat: fed } : undefined;
}

/** A run can have side chats once there's a worktree to work in and it's going or finished. */
const takesSideChats = (run: RunSummary) => (run.status === "done" || run.status === "running") && !!resultWorktree(run);
/** Why a run's side chat can't work in the run's worktree, as a sentence. */
const whyNoSideChat = (run: RunSummary) => {
  const ended: Record<string, string> = { failed: "failed", cancelled: "was cancelled", stopped: "stopped at a limit", interrupted: "was interrupted" };
  return ended[run.status] ? `This run ${ended[run.status]}, so a side chat can't work in its worktree.` : "This run has no result worktree for a side chat to work in yet.";
};
const finishedTurns = (c: SideChat) => c.turns.filter((t) => t.status !== "pending").length;

function savedAgent(): AgentId {
  const saved = store.get("sideAgent") as AgentId | null;
  return saved && agents.value.some((a) => a.id === saved && a.available) ? saved : (agents.value.find((a) => a.available)?.id ?? "claude");
}

export function ChatTab() {
  const s = sideScope.value;
  const memo = sideMemo.value;
  const kinds = chatPatterns();
  const run = s.run;
  // Single-agent chats: not the run you're looking at itself, when it's one (it's open already).
  const solo = [...runs.value.values()].filter((r) => kinds.has(r.pattern) && !r.archived && r.id !== run?.id).sort((a, b) => b.createdAt - a.createdAt);
  const about = run ? solo.filter((r) => r.parentRunId === run.id) : [];
  const nearby = solo.filter((r) => !about.includes(r) && (s.project ? projectFor(r)?.id === s.project.id : !!s.repo && r.repo === s.repo));
  const sides = run ? sideChatsOf(run) : [];
  const closed = new Set(memo.closed ?? []);
  const where = s.project?.name ?? (s.repo ? baseName(s.repo) : "");

  const key = sideChat.value ?? "";
  const side = key.startsWith("side:") ? sides.find((c) => c.key === key) : undefined;
  const chat = !side && key && key !== "solo" ? runs.value.get(key) : undefined;
  const shown = side?.key ?? (chat && kinds.has(chat.pattern) ? chat.id : undefined);
  // Chats open in the strip, and the one shown even if it never got a place there.
  const ids = [...(memo.chats ?? []), ...(shown && !side && !memo.chats?.includes(shown) ? [shown] : [])];
  const opened = ids.map((id) => runs.value.get(id)).filter((r): r is RunSummary => !!r && kinds.has(r.pattern));

  // A reply you're looking at is seen.
  const doneCount = side ? finishedTurns(side) : 0;
  useEffect(() => {
    if (side && (memo.seen?.[side.key] ?? 0) < doneCount) rememberSide({ seen: { ...memo.seen, [side.key]: doneCount } });
  }, [side?.key, doneCount]);

  const items: StripItem[] = [
    ...sides
      .filter((c) => !closed.has(c.key))
      .map((c): StripItem => {
        const last = c.turns.at(-1)!;
        const pending = last.status === "pending";
        return {
          key: c.key,
          label: c.title,
          title: `${c.title}\n${SHORT[c.agent] ?? c.agent} · side chat in this run's worktree`,
          agent: c.agent,
          // A turn the run stopped in the middle of waits for the run to be resumed.
          state: pending ? (last.stepId && run?.status === "running" ? "working" : "queued") : last.status === "failed" ? "failed" : finishedTurns(c) > (memo.seen?.[c.key] ?? 0) && c.key !== shown ? "unread" : undefined,
        };
      }),
    ...opened.map(
      (r): StripItem => ({
        key: r.id,
        label: r.task.split("\n")[0]!.slice(0, 60) || "(no task)",
        title: `${r.task.split("\n")[0]}\nA chat on its own branch`,
        agent: Object.values(r.roles).flat()[0] as AgentId | undefined,
        state: r.status === "running" ? "working" : !r.seen && r.id !== shown ? "unread" : runState(r) === "failed" ? "failed" : undefined,
      }),
    ),
  ];
  const close = (k: string) => {
    const rest = items.filter((it) => it.key !== k);
    const next = k === shown ? rest.at(-1)?.key ?? "" : key;
    if (k.startsWith("side:")) rememberSide({ closed: [...(memo.closed ?? []), k], chat: next });
    else rememberSide({ chats: (memo.chats ?? []).filter((id) => id !== k), chat: next });
  };
  const option = (k: string, label: string, sub: string, done: () => void) => (
    <MenuItem
      key={k}
      on={k === shown}
      sub={sub}
      onClick={() => {
        setSideChat(k);
        done();
      }}
    >
      {label}
    </MenuItem>
  );

  return (
    <>
      <Strip items={items} active={shown} onPick={setSideChat} onClose={close} label="Open chats">
        <button type="button" class={`icon-btn ${!shown ? "on" : ""}`} aria-label="New chat" title={run ? "New side chat about this run" : "New chat"} onClick={() => setSideChat(null)}>
          <Icon name="plus" />
        </button>
        <Menu label="All chats" icon="menu" title="Every chat here, closed ones too">
          {(done) => (
            <>
              {sides.length ? <MenuTitle>Side chats on this run</MenuTitle> : null}
              {sides.map((c) => option(c.key, c.title, `${SHORT[c.agent] ?? c.agent} · ${c.turns.length} message${c.turns.length === 1 ? "" : "s"}`, done))}
              {about.length ? <MenuTitle>Chats from this run, on their own branch</MenuTitle> : null}
              {about.map((r) => option(r.id, r.task.split("\n")[0]!.slice(0, 60), `${STATUS_TEXT[r.status] ?? r.status}`, done))}
              {nearby.length ? <MenuTitle>{where ? `Chats in ${where}` : "Chats"}</MenuTitle> : null}
              {nearby.slice(0, 30).map((r) => option(r.id, r.task.split("\n")[0]!.slice(0, 60), `${STATUS_TEXT[r.status] ?? r.status}`, done))}
              {run ? (
                <>
                  <MenuTitle>New</MenuTitle>
                  <MenuItem
                    sub="A Single-agent run on a branch of its own, from this run's result"
                    onClick={() => {
                      setSideChat("solo");
                      done();
                    }}
                  >
                    Separate chat
                  </MenuItem>
                </>
              ) : null}
              {!sides.length && !about.length && !nearby.length && !run ? <div class="pop-title">No chats here yet</div> : null}
            </>
          )}
        </Menu>
      </Strip>
      {side && run ? (
        <SideChatView key={side.key} run={run} chat={side.chat} />
      ) : chat && kinds.has(chat.pattern) ? (
        <ChatView key={chat.id} id={chat.id} />
      ) : run && key !== "solo" && takesSideChats(run) ? (
        <NewSideChat key={run.id} run={run} />
      ) : (
        <NewChat key={s.key} scope={s} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- a side chat on a run
/** The Chat tab is in view: not behind another tab, nor in a closed panel. */
const chatShown = () => sideOpen.value && sideTab.value === "chat";

function useFollow(deps: unknown[]) {
  const scroll = useRef<HTMLDivElement>(null);
  // Follow the conversation unless you scrolled up to read.
  useEffect(() => {
    const el = scroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, deps);
  return scroll;
}

/** A side chat's turns, each your message and then the agent's turn in the run's worktree. */
function SideChatView({ run: summary, chat }: { run: RunSummary; chat: string }) {
  // Watched while you can see it: behind another tab, or in a closed panel, it catches up when shown.
  const { run: live, data, version } = useRunStream(summary.id, undefined, chatShown());
  const shown = sideChatIn(live, summary, chat);
  const scroll = useFollow([version, shown?.chat.turns.length, shown?.chat.turns.at(-1)?.status]);
  if (!shown) return <div class="side-empty help">Loading…</div>;
  const { run, chat: c } = shown;
  const wt = run.worktrees.find((w) => w.name === c.turns[0]!.worktree);
  return (
    <>
      <div class="chat-scroll" ref={scroll}>
        <div class="thread">
          <div class="chat-meta">
            <AgentTag id={c.agent} />
            <span class="help">Side chat in {wt ? <code title={wt.path}>{wt.branch}</code> : "the run's worktree"}</span>
          </div>
          {c.turns.map((f) => {
            const step = f.stepId ? data.current.steps.get(f.stepId) : undefined;
            const change = f.side?.mode === "change";
            return (
              <div key={f.id} class="fu">
                <div class="msg-you">
                  <div class="bubble">
                    <Markdown text={f.message} />
                    <div class={`side-mode ${change ? "change" : ""}`}>{change ? "Change" : "Ask"}</div>
                  </div>
                </div>
                <div class={`fu-answer ${f.status}`}>
                  <div class="fu-head">
                    <AgentTag id={f.agent} />
                    {f.status === "pending" && run.status !== "running" ? (
                      <span class="help">The run stopped before this turn finished: resume the run to finish it</span>
                    ) : f.status === "pending" && !step ? (
                      <span class="fu-live">{run.patternDone ? "Up next…" : "Waits for the team to finish…"}</span>
                    ) : (
                      <FollowUpBadges f={f} />
                    )}
                  </div>
                  {step ? <TurnBody run={run} step={step} data={data.current} answer={f.status === "pending" ? undefined : f.result} /> : f.result ? <Markdown text={f.result} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <SideComposer run={run} chat={c} />
    </>
  );
}

/** Where a side chat about a run starts. */
function NewSideChat({ run }: { run: RunSummary }) {
  const wt = resultWorktree(run)!;
  return (
    <>
      <div class="chat-scroll">
        <div class="side-empty">
          <h3>Chat about this run</h3>
          <p class="help">
            The agent works in this run's worktree (<code>{wt.branch}</code>), in a conversation of its own. <b>Ask</b> reads it and changes nothing; <b>Change</b> edits it, and code-flow commits the change on
            the run's branch and runs the check.
            {run.status === "running" ? " While the team is working, your message waits for it to finish." : ""}
          </p>
        </div>
      </div>
      <SideComposer run={run} />
    </>
  );
}

/** A side chat's message box: Ask or Change, the agent, and send. Without a chat, sending starts one. */
function SideComposer({ run, chat }: { run: RunSummary; chat?: SideChat }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"ask" | "change">(chat?.mode ?? "ask");
  const [agent, setAgent] = useState<AgentId>(chat?.agent ?? savedAgent);
  const [settings, setSettings] = useState<Record<string, ChatSettings>>({});
  const [permissions, setPermissions] = useState<ChatPermissions>({ trust: chat?.turns.at(-1)?.trust ?? run.trust, tools: chat?.turns.at(-1)?.tools ?? !!run.approvals.tools });
  const selectedSettings = settings[agent] ?? chat?.turns.filter((turn) => turn.agent === agent).at(-1)?.settings ?? run.agentSettings[agent] ?? {};
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const area = useDraft(text, setText);
  // Pins sent here from the Browser.
  useEffect(() => {
    const drafts = takeDrafts(chat ? chat.key : "side:new");
    if (!drafts.length) return;
    setText((t) => [t.trim(), ...drafts.map((d) => d.text)].filter(Boolean).join("\n\n"));
    setImages((i) => [...i, ...drafts.flatMap((d) => d.images)]);
    area.current?.focus();
  }, [chatDrafts.value, chat?.key]);
  const wt = chat ? run.worktrees.find((w) => w.name === chat.turns[0]!.worktree) : resultWorktree(run);
  const name = SHORT[agent] ?? agent;
  const send = async () => {
    if (!text.trim() || busy || !wt) return;
    setBusy(true);
    setError("");
    const id = chat?.chat ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const title = chat?.title ?? (text.trim().split("\n")[0]!.slice(0, 60) || "Side chat");
    try {
      await post(`/api/runs/${run.id}/followups`, { kind: "side", worktree: wt.name, agent, settings: selectedSettings, trust: permissions.trust, tools: permissions.tools, message: text.trim(), side: { chat: id, mode, title }, attachments: images.map(({ name, data }) => ({ name, data })) });
      setText("");
      setImages([]);
      // The run's own panel memory: the panel may be on another run or project by now.
      if (!chat) setSideChat(`side:${id}`, `run:${run.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="convo">
      <div class="convo-inner">
        {error ? <div class="msg err">{error}</div> : null}
        <DraftImages images={images} onRemove={(i) => setImages(images.filter((_, j) => j !== i))} />
        <div class="chatbox">
          <textarea
            ref={area}
            rows={1}
            aria-label="Message"
            placeholder={mode === "change" ? `Ask ${name} for a change…` : chat ? `Reply to ${name}…` : `Ask ${name} about this run…`}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="chatbox-bar chatbox-configurable">
            <Menu above label="Chat mode" icon="chat" class="chat-choice" trigger={<><span>{mode === "ask" ? "Ask" : "Change"}</span><Icon name="chevron" /></>}>
              {(close) => <>
                <MenuTitle>Chat mode</MenuTitle>
                <MenuItem on={mode === "ask"} sub="Read the worktree without changing files" onClick={() => { setMode("ask"); close(); }}>Ask</MenuItem>
                <MenuItem on={mode === "change"} sub="Edit the worktree, commit changes and run the check" onClick={() => { setMode("change"); close(); }}>Change</MenuItem>
              </>}
            </Menu>
            <ChatControls agent={agent} onAgent={(id) => { setAgent(id); store.set("sideAgent", id); }} settings={selectedSettings} onSettings={(value) => setSettings({ ...settings, [agent]: value })} permissions={permissions} onPermissions={setPermissions} restricted={!!run.lockdown || !!run.trigger} approvalsAvailable={!run.loop.remoteWorker && !run.loop.agentContainer} />
            <span class="chatbox-hint" />
            <button class="send" aria-label="Send" title="Send (↵ — ⇧↵ for a new line)" disabled={busy || !text.trim() || !wt} onClick={send}>
              <Icon name="send" />
            </button>
          </div>
        </div>
        <div class="side-hint help">
          {mode === "change" ? `Edits ${wt?.branch ?? "the run's worktree"}; code-flow commits it and runs the check.` : "Reads the run's worktree; changes nothing."}
          {run.status === "running" ? " Waits for the team to finish." : ""}
        </div>
      </div>
    </div>
  );
}

/** A message box that grows with its text, and takes text sent over from Notes or a file. */
function useDraft(text: string, setText: (fn: (t: string) => string) => void) {
  const area = useRef<HTMLTextAreaElement>(null);
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
    // In a hidden tab the box measures 0: leave it at its natural height rather than shrink it to nothing.
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  return area;
}

// ---------------------------------------------------------------- a chat on its own branch
/** A chat in progress: the Single-agent run's thread and its composer, compact. */
function ChatView({ id }: { id: string }) {
  const watched = chatShown();
  const { run, problem, data, version } = useRunStream(id, undefined, watched);
  const scroll = useFollow([version, run?.status, run?.followUps?.length]);
  // A reply you watch arrive here is seen, as in the run's own view; not behind another tab or a closed panel.
  useEffect(() => {
    if (watched && run && run.status !== "running" && !run.seen && !document.hidden) void markSeen(run.id);
  }, [watched, run?.status, run?.seen]);
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
  // Side chats' turns aren't this conversation's: replies go to the chat's own agent.
  const steps = teamSteps(run, data.current.steps.values());
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
            {branch ? <code title="The branch this chat works on">{branch}</code> : null}
            {state === "failing" ? <span class="note">Check fails</span> : state === "done" ? <span class="ok">Check passes</span> : state === "unverified" ? <span class="note">Not verified</span> : null}
            <a class="btn ghost small" href={`#/run/${encodeURIComponent(run.id)}`} title="Open this chat as a run, with its branch and result">
              Open
            </a>
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
 * Where a chat on its own branch starts: a fresh Single-agent run, with the agent you pick, in the
 * panel's repository. From a run, it starts from the run's result unless you pick HEAD.
 */
function NewChat({ scope }: { scope: SideScope }) {
  const run = scope.run;
  /** The run's result branches the chat can start from, so the agent sees that work. */
  const fromRun = run ? run.artifacts.map((a) => a.branch) : [];
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<AgentId>(savedAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [base, setBase] = useState(fromRun[0] ?? "");
  const area = useDraft(text, setText);
  const solo = patterns.value.find((p) => p.chat);
  const name = SHORT[agent] ?? agent;
  const where = scope.repo ? baseName(scope.repo) : "the repository";
  const [tools, setTools] = useState(store.get("interactiveApprovals") === "1");
  const send = async () => {
    if (!text.trim() || busy || !solo) return;
    if (!scope.repo) return setError("Choose a repository first.");
    setBusy(true);
    setError("");
    try {
      const { id, project } = await post<{ id: string; project?: string }>("/api/runs", {
        repo: scope.repo,
        // In the panel's project; a chat from a run goes in that run's project.
        project: run ? undefined : scope.project?.id,
        task: text.trim(),
        pattern: solo.id,
        roles: { agent: [agent] },
        options: {},
        baseRef: base || undefined,
        agentSettings: agentSettings.value,
        trust: trust.value,
        approvals: { tools },
        loop: { maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps },
        parentRunId: run?.id,
      });
      setText("");
      // Where it was started, also if the panel has moved on since.
      setSideChat(id, scope.key);
      // A chat in a repo no project held made one: the panel is then about that project, so keep the chat open there.
      void afterStart(project);
      if (project && scope.key.startsWith("repo:")) setSideChat(id, `project:${project}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const blocked = run && !takesSideChats(run);
  return (
    <>
      <div class="chat-scroll">
        <div class="side-empty">
          <h3>{run ? "A separate chat" : `Chat with ${name}`}</h3>
          <p class="help">
            {run
              ? `${blocked ? `${whyNoSideChat(run)} ` : ""}${name} works on a branch of its own${base ? ", starting from the run's result" : ""}, and you keep talking to it; the chat is a run like any other.`
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
            <div class="chatbox-bar chatbox-configurable">
              <ChatControls agent={agent} onAgent={(id) => { setAgent(id); store.set("sideAgent", id); }} settings={agentSettings.value[agent] ?? {}} onSettings={(value) => setAgentSetting(agent, value)} permissions={{ trust: trust.value, tools }} onPermissions={(value) => { setTrust(value.trust); setTools(value.tools); store.set("interactiveApprovals", value.tools ? "1" : "0"); }} />
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
