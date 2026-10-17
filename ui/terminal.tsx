import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, baseName, enc, post, showToast, store } from "./lib.js";
import { defaultPlace, Menu, MenuItem, MenuTitle, placeName, placesFor, Strip, type StripItem } from "./panel-bits.js";
import { rememberSide, sideMemo, sideScope } from "./state.js";
import type { DevServer, ShellEvent, ShellInfo } from "./types.js";

/** As in src/shell.ts: past this, a new terminal takes the place of the oldest idle one. */
const MAX_SHELLS = 12;
const APP = "app:";

/**
 * The side panel's Terminal tab: shells in a run's worktrees or the repository, several at once in
 * a strip, one or two shown (split), plus the log of an app a run started with Run app. Each run
 * or project remembers its own.
 */
export function TerminalTab() {
  const s = sideScope.value;
  const memo = sideMemo.value;
  const places = placesFor(s);
  const [list, setList] = useState<ShellInfo[] | null>(null);
  const [apps, setApps] = useState<Omit<DevServer, "logs">[]>([]);
  const [focus, setFocus] = useState<"top" | "bottom">("top");
  const [ratio, setRatio] = useState(0.5);
  const panes = useRef<HTMLDivElement>(null);
  const refresh = () => api<ShellInfo[]>("/api/shell").then(setList, () => {});
  useEffect(() => {
    void refresh();
    const poll = () => api<Omit<DevServer, "logs">[]>("/api/serve").then(setApps, () => {});
    void poll();
    const timer = setInterval(() => void (refresh(), poll()), 3_000);
    return () => clearInterval(timer);
  }, []);

  // The apps this run started with Run app: their logs can be shown like a terminal.
  const runApps = s.run ? apps.filter((a) => a.key.startsWith(`${s.run!.id}/`) && a.status === "running") : [];
  const alive = (k?: string): k is string => !!k && (k.startsWith(APP) ? runApps.some((a) => APP + a.key === k) : !!list?.some((x) => x.id === k));
  const open = (memo.shells ?? []).filter(alive);
  const top = alive(memo.shell) && open.includes(memo.shell) ? memo.shell : open[0];
  const bottom = memo.split && alive(memo.below) && memo.below !== top ? memo.below : undefined;

  const create = async (cwd: string): Promise<string | undefined> => {
    try {
      const sh = await post<ShellInfo>("/api/shell", { cwd });
      setList((l) => [...(l ?? []).filter((x) => x.id !== sh.id), sh]);
      void refresh(); // a shell may have closed to make room
      return sh.id;
    } catch (err) {
      showToast((err as Error).message, 6000);
      return undefined;
    }
  };
  /** Show a session in the pane you're working in (the lower one when it has focus). */
  const show = (k: string, shells = open) => {
    const list = shells.includes(k) ? shells : [...shells, k];
    if (bottom && focus === "bottom") rememberSide({ shells: list, below: k, shell: k === top ? bottom : top });
    else rememberSide({ shells: list, shell: k, below: k === bottom ? top : memo.below });
  };
  const add = async (cwd: string) => {
    const id = await create(cwd);
    if (id) show(id);
  };

  // The first time here: the shell already open in the panel's folder, or a new one.
  const started = useRef("");
  useEffect(() => {
    if (!list || open.length || started.current === s.key) return;
    const start = defaultPlace(s, places);
    if (!start) return;
    started.current = s.key;
    const key = s.key;
    const existing = list.find((x) => x.status === "running" && x.cwd === start.path);
    void (existing ? Promise.resolve(existing.id) : create(start.path)).then((id) => id && rememberSide({ shells: [id], shell: id }, key));
  }, [list, s.key, open.length]);

  const close = async (k: string) => {
    const shell = list?.find((x) => x.id === k);
    if (shell?.busy && !confirm(`Stop what's running in ${placeName(shell.cwd, places)} and close it?`)) return;
    if (!k.startsWith(APP)) await api(`/api/shell/${k}`, { method: "DELETE" }).catch(() => {});
    const rest = open.filter((x) => x !== k);
    rememberSide({ shells: rest, shell: top === k ? rest.find((x) => x !== bottom) ?? rest[0] : top, below: bottom === k ? undefined : bottom });
    setList((l) => l?.filter((x) => x.id !== k) ?? l);
  };
  /** A fresh shell in the same folder takes a stopped one's place. */
  const replace = async (old: string, cwd: string) => {
    await api(`/api/shell/${old}`, { method: "DELETE" }).catch(() => {});
    const id = await create(cwd);
    if (!id) return;
    rememberSide({ shells: open.map((x) => (x === old ? id : x)), shell: top === old ? id : top, below: bottom === old ? id : bottom });
  };
  const split = async () => {
    if (memo.split) return rememberSide({ split: false });
    // The lower half shows another open terminal, or a new one where the upper one is.
    const other = open.find((x) => x !== top);
    const cwd = list?.find((x) => x.id === top)?.cwd ?? defaultPlace(s, places)?.path;
    const below = other ?? (cwd ? await create(cwd) : undefined);
    if (below) rememberSide({ split: true, below, shells: open.includes(below) ? open : [...open, below] });
    setFocus("bottom");
  };
  const startDrag = (e: PointerEvent) => {
    e.preventDefault();
    const box = panes.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => setRatio(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const items: StripItem[] = open.map((k) => {
    if (k.startsWith(APP)) {
      const app = runApps.find((a) => APP + a.key === k)!;
      return { key: k, label: `▶ app :${app.port}`, title: `${app.command} in ${app.cwd} (read-only log)`, below: k === bottom };
    }
    const sh = list!.find((x) => x.id === k)!;
    return {
      key: k,
      label: placeName(sh.cwd, places),
      title: sh.cwd,
      state: sh.busy ? "working" : undefined,
      note: sh.status === "exited" ? "exited" : undefined,
      below: k === bottom,
    };
  });
  const total = list?.length ?? 0;
  const pane = (k: string | undefined, where: "top" | "bottom") =>
    !k ? (
      <div class="side-empty help">{places.length ? (list ? "Opening a shell…" : "Loading…") : "Choose a repository first."}</div>
    ) : k.startsWith(APP) ? (
      <AppLog key={k} appKey={k.slice(APP.length)} split={!!bottom} focused={focus === where} onFocus={() => setFocus(where)} />
    ) : (
      <ShellView key={k} id={k} places={places} split={!!bottom} focused={focus === where} onFocus={() => setFocus(where)} onReplace={(cwd) => void replace(k, cwd)} />
    );
  return (
    <>
      <Strip items={items} active={bottom && focus === "bottom" ? bottom : top} onPick={show} onClose={(k) => void close(k)} label="Open terminals">
        <Menu label="New terminal" icon="plus" title={total >= MAX_SHELLS - 2 ? `${total} of ${MAX_SHELLS} terminals open: past that, the oldest idle one closes` : "A new terminal"}>
          {(done) => (
            <>
              <MenuTitle>New terminal in</MenuTitle>
              {places.map((p) => (
                <MenuItem
                  key={p.path}
                  sub={p.path}
                  onClick={() => {
                    done();
                    void add(p.path);
                  }}
                >
                  {p.label}
                </MenuItem>
              ))}
              {runApps.length ? <MenuTitle>Apps this run started</MenuTitle> : null}
              {runApps.map((a) => (
                <MenuItem
                  key={a.key}
                  sub={`${a.command} · read-only log`}
                  onClick={() => {
                    done();
                    show(APP + a.key);
                  }}
                >
                  ▶ app :{a.port}
                </MenuItem>
              ))}
              {total >= MAX_SHELLS - 2 ? <div class="pop-title">{`${total} of ${MAX_SHELLS} open; past that, the oldest idle one closes`}</div> : null}
            </>
          )}
        </Menu>
        <button type="button" class={`icon-btn ${memo.split ? "on" : ""}`} aria-pressed={!!memo.split} aria-label="Split" title={memo.split ? "One terminal" : "Two terminals, one above the other"} disabled={!top} onClick={() => void split()}>
          <Icon name="split" />
        </button>
      </Strip>
      <div class={`term-panes ${bottom ? "split" : ""}`} ref={panes} style={bottom ? `--top:${ratio}` : undefined}>
        {pane(top, "top")}
        {bottom ? (
          <>
            <div class="term-divider" role="separator" aria-orientation="horizontal" aria-label="Resize the terminals" title="Drag to resize" onPointerDown={startDrag} />
            {pane(bottom, "bottom")}
          </>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- one shell
type Line = ShellEvent;

/** A shell's output and its command line. It reattaches after a reload; Stop and Restart open a new one in the same folder. */
function ShellView({ id, places, split, focused, onFocus, onReplace }: { id: string; places: ReturnType<typeof placesFor>; split: boolean; focused: boolean; onFocus: () => void; onReplace: (cwd: string) => void }) {
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>(() => store.json("termHistory", []));
  const [at, setAt] = useState(-1);
  const [error, setError] = useState("");
  const out = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let closed = false;
    const source = new EventSource(`/api/shell/${enc(id)}/events`);
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
    // The stream closed for good: the shell is gone (code-flow restarted).
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || closed) return;
      setError("This terminal is gone (code-flow restarted?). Restart opens a new one in the same folder.");
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [id]);

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
      await post(`/api/shell/${enc(id)}/input`, { text });
    } catch (err) {
      showToast((err as Error).message, 4000);
    }
  };
  const restart = () => shell && onReplace(shell.cwd);
  const where = shell ? placeName(shell.cwd, places) : "";
  return (
    <div class={`term-pane ${focused && split ? "focused" : ""}`} onMouseDown={onFocus}>
      <div class="term-head">
        <span class="th-name" title={shell?.cwd}>
          {where || "…"}
        </span>
        <button type="button" class="btn ghost small" title="Clear the output" onClick={() => setLines([])}>
          Clear
        </button>
        <button type="button" class={`btn ghost small ${shell?.busy ? "danger" : ""}`} title={shell?.busy ? "Stop what's running (a new shell opens in the same folder)" : "Start a new shell in this folder"} disabled={!shell} onClick={restart}>
          <Icon name={shell?.busy ? "stop" : "refresh"} /> {shell?.busy ? "Stop" : "Restart"}
        </button>
      </div>
      <div class="term" onClick={(e) => (e.target as HTMLElement).closest("pre") && !window.getSelection()?.toString() && input.current?.focus()}>
        <pre class="term-out" ref={out} aria-live="polite" aria-label="Terminal output">
          {!lines.length ? (
            <span class="help">{error || (shell ? `${shell.shell} in ${shell.cwd}. Commands run here, not in an interactive terminal: no pagers or full-screen programs.` : "Connecting…")}</span>
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
          {error && lines.length ? <span class="exit">{`\n${error}\n`}</span> : null}
        </pre>
        <div class="term-row">
          <span class="prompt" title={shell?.cwd}>
            {shell?.busy ? <span class="term-busy" aria-label="Running" /> : null}
            {shell ? `${baseName(shell.cwd)} $` : "$"}
          </span>
          <input
            ref={input}
            type="text"
            aria-label="Command"
            placeholder={shell?.status === "exited" || error ? "This shell is gone — Restart" : "Type a command and press ↵"}
            autocomplete="off"
            spellcheck={false}
            disabled={!shell || shell.status === "exited" || !!error}
            value={command}
            onFocus={onFocus}
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
                restart();
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Output comes in many pieces: join runs of output so the list stays short. */
function append(lines: Line[], ev: ShellEvent): Line[] {
  const last = lines.at(-1);
  if (ev.type === "output" && last?.type === "output" && last.text.length < 8_192) return [...lines.slice(0, -1), { type: "output", text: last.text + ev.text }];
  return lines.length > 4_000 ? [...lines.slice(-3_000), ev] : [...lines, ev];
}

// ---------------------------------------------------------------- an app's log
/** The output of an app a run started with Run app, read-only, newest at the bottom. */
function AppLog({ appKey, split, focused, onFocus }: { appKey: string; split: boolean; focused: boolean; onFocus: () => void }) {
  const [runId, name] = [appKey.slice(0, appKey.indexOf("/")), appKey.slice(appKey.indexOf("/") + 1)];
  const [server, setServer] = useState<DevServer | null>(null);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<DevServer | null>(`/api/runs/${enc(runId)}/worktrees/${enc(name)}/serve`).then((s) => alive && setServer(s), () => {});
    void load();
    const timer = setInterval(load, 2_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [appKey]);
  useEffect(() => {
    const el = out.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [server?.logs.length]);
  return (
    <div class={`term-pane ${focused && split ? "focused" : ""}`} onMouseDown={onFocus}>
      <div class="term-head">
        <span class="th-name" title={server ? `${server.command} in ${server.cwd}` : undefined}>
          ▶ {server ? `${server.command} · :${server.port}` : "app"}
        </span>
        <span class="help">{server?.status === "exited" ? `exited${server.exitCode == null ? "" : ` with ${server.exitCode}`}` : "read-only log"}</span>
      </div>
      <div class="term">
        <pre class="term-out" ref={out} aria-live="polite" aria-label="App log">
          {server?.logs.length ? server.logs.join("\n") : <span class="help">{server ? "No output yet." : "Loading…"}</span>}
        </pre>
      </div>
    </div>
  );
}
