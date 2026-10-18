import { effect } from "@preact/signals";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, baseName, copy, enc, post, showToast, store, usePoll } from "./lib.js";
import { defaultPlace, Menu, MenuItem, MenuTitle, placeName, placesFor, Strip, type StripItem } from "./panel-bits.js";
import { rememberSide, sideMemo, sideOpen, sideScope, sideTab } from "./state.js";
import { subscribe } from "./stream.js";
import { theme } from "./theme.js";
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
  // Only while you can see the tab: a closed panel, another tab or a hidden window asks for nothing.
  usePoll(() => Promise.all([refresh(), api<Omit<DevServer, "logs">[]>("/api/serve").then(setApps, () => {})]), 3_000, [], sideOpen.value && sideTab.value === "terminal");

  // The apps this run started with Run app: their logs can be shown like a terminal, an app that
  // exited too (its last output says why).
  const runApps = s.run ? apps.filter((a) => a.key.startsWith(`${s.run!.id}/`)) : [];
  const alive = (k?: string): k is string => !!k && (k.startsWith(APP) ? runApps.some((a) => APP + a.key === k) : !!list?.some((x) => x.id === k));
  const open = (memo.shells ?? []).filter(alive);
  const top = alive(memo.shell) && open.includes(memo.shell) ? memo.shell : open[0];
  const bottom = memo.split && alive(memo.below) && memo.below !== top ? memo.below : undefined;

  const create = async (cwd: string): Promise<string | undefined> => {
    try {
      // A real terminal (the server falls back to a line-based shell without python3), about the
      // size of the pane; the terminal fits itself exactly once it's drawn.
      const box = panes.current?.getBoundingClientRect();
      const size = box?.width ? { cols: Math.floor((box.width - 16) / 7.2), rows: Math.floor(((memo.split ? box.height / 2 : box.height) - 36) / 15) } : {};
      const sh = await post<ShellInfo>("/api/shell", { cwd, pty: true, ...size });
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

  // The first time here: the shell already open in the panel's folder, or a new one. Only once the
  // tab is in view: a tab behind another, or in a closed panel, stays mounted as the panel follows
  // you from run to run, and would open a shell in each.
  const shown = sideOpen.value && sideTab.value === "terminal";
  const started = useRef("");
  useEffect(() => {
    if (!shown || !list || open.length || started.current === s.key) return;
    const start = defaultPlace(s, places);
    if (!start) return;
    started.current = s.key;
    const key = s.key;
    const existing = list.find((x) => x.status === "running" && x.cwd === start.path);
    void (existing ? Promise.resolve(existing.id) : create(start.path)).then((id) => id && rememberSide({ shells: [id], shell: id }, key));
  }, [list, s.key, open.length, shown]);

  const close = async (k: string) => {
    const shell = list?.find((x) => x.id === k);
    if (shell?.busy && !confirm(`Stop ${shell.running ?? "what's running"} in ${placeName(shell.cwd, places)} and close it?`)) return;
    if (!k.startsWith(APP)) await api(`/api/shell/${k}`, { method: "DELETE" }).catch(() => {});
    const rest = open.filter((x) => x !== k);
    // Closing one of the two shown leaves the other on its own: no split, nothing kept for below.
    if (bottom && (k === top || k === bottom)) rememberSide({ shells: rest, shell: k === top ? bottom : top, below: undefined, split: false });
    else rememberSide({ shells: rest, shell: top === k ? rest[0] : top, below: bottom });
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
    if (bottom) return rememberSide({ split: false });
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
      return { key: k, label: `▶ app :${app.port}`, title: `${app.command} in ${app.cwd} (read-only log)`, note: app.status === "exited" ? "exited" : undefined, below: k === bottom };
    }
    const sh = list!.find((x) => x.id === k)!;
    return {
      key: k,
      label: placeName(sh.cwd, places),
      title: sh.cwd,
      state: sh.busy ? "working" : undefined,
      note: sh.status === "exited" ? "exited" : sh.running,
      below: k === bottom,
    };
  });
  const total = list?.length ?? 0;
  const pane = (k: string | undefined, where: "top" | "bottom") =>
    !k ? (
      <div class="side-empty help">{places.length ? (list ? "Opening a shell…" : "Loading…") : "Choose a repository first."}</div>
    ) : k.startsWith(APP) ? (
      <AppLog key={k} appKey={k.slice(APP.length)} split={!!bottom} focused={focus === where} onFocus={() => setFocus(where)} />
    ) : list?.find((x) => x.id === k)?.interactive ? (
      <TermView key={k} id={k} places={places} split={!!bottom} focused={focus === where} shown={shown} onFocus={() => setFocus(where)} onReplace={(cwd) => void replace(k, cwd)} />
    ) : (
      <ShellView key={k} id={k} places={places} split={!!bottom} focused={focus === where} shown={shown} onFocus={() => setFocus(where)} onReplace={(cwd) => void replace(k, cwd)} />
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
                  sub={`${a.command} · ${a.status === "exited" ? `exited${a.exitCode == null ? "" : ` with ${a.exitCode}`}` : "read-only log"}`}
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
        <button type="button" class={`icon-btn ${bottom ? "on" : ""}`} aria-pressed={!!bottom} aria-label="Split" title={bottom ? "One terminal" : "Two terminals, one above the other"} disabled={!top} onClick={() => void split()}>
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

// ---------------------------------------------------------------- one terminal
/** `shown`: the Terminal tab is in view. Only then is the shell's output watched; shown again, it's drawn afresh. */
type ViewProps = { id: string; places: ReturnType<typeof placesFor>; split: boolean; focused: boolean; shown: boolean; onFocus: () => void; onReplace: (cwd: string) => void };
type Hello = { type: "hello"; shell: ShellInfo; history: ShellEvent[] };
/** A terminal that can't be watched: it's gone (code-flow restarted, or it was closed). */
type Gone = { type: "error"; status: number; message: string };

/** Typed into a terminal's own screen, dimmed: a note from code-flow, not the shell's output. */
const note = (text: string) => `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;
const exitNote = (code: number | null) => note(`shell exited${code === null ? "" : ` with ${code}`} — Restart opens a new one`);
const GONE = "This terminal is gone (code-flow restarted?). Restart opens a new one in the same folder.";

/**
 * A real terminal (xterm): keystrokes go to the shell as typed, a few milliseconds' worth per
 * request and in order; it fits its pane and tells the shell its size. It reattaches after a
 * reload with what the terminal showed so far; Stop and Restart open a new one in the same folder.
 */
function TermView({ id, places, split, focused, shown, onFocus, onReplace }: ViewProps) {
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal>();
  /** What to do with a message from the shell: set up with the terminal it draws in. */
  const receive = useRef<(ev: ShellEvent | Hello | Gone) => void>(() => {});
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  /** The pane you're working in takes the keyboard after you act in the side panel (Split, a pick in the strip, the Terminal tab), never from elsewhere on the page. */
  const takeKeys = () => {
    const active = document.activeElement;
    if (active && active !== document.body && box.current?.closest(".side")?.contains(active)) term.current?.focus();
  };
  useEffect(() => {
    if (focused) takeKeys();
  }, [focused]);

  useEffect(() => {
    const el = box.current!;
    const t = new Terminal({ fontFamily: TERM_FONT, fontSize: 12, lineHeight: 1.2, cursorBlink: true, scrollback: 5_000, theme: termTheme(), allowProposedApi: false });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    let closed = false;
    let exited = false;
    let replaying = false; // xterm answers queries in replayed output: those answers aren't keystrokes

    // Keystrokes: ~16 ms of them per request, one request at a time, so they arrive in order. Mouse
    // reports in xterm's default encoding come as bytes (`binary`, not UTF-8: vim's mouse), in
    // their place among the keys.
    const queued: { kind: "data" | "binary"; text: string }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sending = false;
    const flush = async () => {
      timer = undefined;
      if (sending || !queued.length || closed) return;
      const { kind, text } = queued.shift()!;
      sending = true;
      try {
        await post(`/api/shell/${enc(id)}/input`, { [kind]: text });
      } catch (err) {
        if (!exited && !closed) showToast((err as Error).message, 4000);
      } finally {
        sending = false;
        if (queued.length) void flush();
      }
    };
    const queue = (kind: "data" | "binary", text: string) => {
      if (replaying || exited) return;
      const last = queued.at(-1);
      if (last?.kind === kind) last.text += text;
      else queued.push({ kind, text });
      timer ??= setTimeout(() => void flush(), 16);
    };
    t.onData((data) => queue("data", data));
    t.onBinary((data) => queue("binary", data));

    // Copy and paste with Ctrl+Shift+C / Ctrl+Shift+V too (Ctrl+C is the shell's); ⌘C/⌘V work as they are.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.metaKey) return true;
      if (e.code === "KeyC") {
        if (t.hasSelection()) void copy(t.getSelection());
        e.preventDefault();
        return false;
      }
      return e.code !== "KeyV"; // the browser pastes, and xterm takes the paste
    });
    t.textarea?.addEventListener("focus", () => focusRef.current());

    // The size: fit the pane, then tell the shell (programs in it redraw).
    let size = "";
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sendSize = () => {
      const next = `${t.cols}x${t.rows}`;
      if (next === size || exited || closed) return;
      size = next;
      post(`/api/shell/${enc(id)}/resize`, { cols: t.cols, rows: t.rows }).catch(() => {});
    };
    t.onResize(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(sendSize, 80);
    });
    const refit = () => {
      // A hidden tab or a closed panel has no size: fit when it's shown again.
      if (replaying || el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    };
    const resized = new ResizeObserver(refit);
    resized.observe(el);
    refit();

    // Light or dark, as the app is (the theme button, or the system).
    const unTheme = effect(() => {
      if (theme.value) t.options.theme = termTheme();
    });

    receive.current = (ev) => {
      if (closed) return;
      // The stream closed for good: the shell is gone (code-flow restarted).
      if (ev.type === "error") {
        if (exited) return;
        exited = true;
        t.options.disableStdin = true;
        t.write(note(GONE));
        return;
      }
      if (ev.type === "hello") {
        // (Re)connected, or shown again: draw what the terminal showed so far, from a clean screen.
        setShell(ev.shell);
        exited = ev.shell.status === "exited";
        t.options.disableStdin = exited;
        size = `${ev.shell.cols}x${ev.shell.rows}`;
        t.reset();
        // Replay at the size the shell has (what its output was drawn for), then fit the pane.
        if (ev.shell.cols && ev.shell.rows) t.resize(ev.shell.cols, ev.shell.rows);
        replaying = true;
        t.write(ev.history.map((e) => (e.type === "output" ? e.text : e.type === "exit" ? exitNote(e.code) : "")).join(""), () => {
          replaying = false;
          refit();
          sendSize();
        });
        return;
      }
      if (ev.type === "output") t.write(ev.text);
      else if (ev.type === "busy") setShell((cur) => (cur ? { ...cur, busy: ev.busy, running: ev.running } : cur));
      else if (ev.type === "exit") {
        exited = true;
        t.options.disableStdin = true;
        t.write(exitNote(ev.code));
        setShell((cur) => (cur ? { ...cur, status: "exited", exitCode: ev.code, busy: false, running: undefined } : cur));
      }
    };
    if (focusedRef.current) takeKeys();
    return () => {
      closed = true;
      resized.disconnect();
      unTheme();
      clearTimeout(timer);
      clearTimeout(sizeTimer);
      term.current = undefined;
      t.dispose();
    };
  }, [id]);
  useEffect(() => (shown ? subscribe(`shell:${id}`, (ev) => receive.current(ev)) : undefined), [id, shown]);

  return (
    <div class={`term-pane ${focused && split ? "focused" : ""}`} onMouseDown={onFocus}>
      <ShellHead shell={shell} places={places} onClear={() => term.current?.clear()} onRestart={() => shell && onReplace(shell.cwd)} />
      <div class="term-x" ref={box} />
    </div>
  );
}

/** A terminal's name, Clear, and Stop (while something runs) or Restart: both open a new shell in the same folder. */
function ShellHead({ shell, places, onClear, onRestart }: { shell: ShellInfo | null; places: ReturnType<typeof placesFor>; onClear: () => void; onRestart: () => void }) {
  const where = shell ? placeName(shell.cwd, places) : "";
  const stop = shell?.busy && shell.status === "running";
  return (
    <div class="term-head">
      <span class="th-name" title={shell?.cwd}>
        {where || "…"}
      </span>
      {stop && shell.running ? <span class="th-running">{shell.running}</span> : null}
      <button type="button" class="btn ghost small" title="Clear the output" onClick={onClear}>
        Clear
      </button>
      <button
        type="button"
        class={`btn ghost small ${stop ? "danger" : ""}`}
        title={stop ? `Stop ${shell.running ?? "what's running"} (a new shell opens in the same folder)${shell.interactive ? "; Ctrl-C in the terminal stops just the command" : ""}` : "Start a new shell in this folder"}
        disabled={!shell}
        onClick={onRestart}
      >
        <Icon name={stop ? "stop" : "refresh"} /> {stop ? "Stop" : "Restart"}
      </button>
    </div>
  );
}

/** System monospace fonts first: they have the box-drawing and other symbols full-screen programs draw with. */
const TERM_FONT = 'Menlo, "SF Mono", "SFMono-Regular", Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

/** The terminal's colours from the app's own (light or dark), with ANSI colours readable on each. */
function termTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = theme.value === "dark";
  const base = { background: v("--sunken", dark ? "#121310" : "#f0efe9"), foreground: v("--text", dark ? "#ecebe4" : "#292a26"), cursor: v("--ink", dark ? "#e9e8df" : "#343932") };
  return dark
    ? {
        ...base,
        cursorAccent: base.background,
        selectionBackground: "#4fd0a04d",
        black: "#26281f", red: "#e47a62", green: "#4fd0a0", yellow: "#e0b35a", blue: "#74a6d8", magenta: "#c792ea", cyan: "#5fc8c8", white: "#c9c8be",
        brightBlack: "#8a8b80", brightRed: "#f0a08d", brightGreen: "#8fe3c4", brightYellow: "#eac77f", brightBlue: "#a3c6ea", brightMagenta: "#dbb0f5", brightCyan: "#8ae0e0", brightWhite: "#ecebe4",
      }
    : {
        ...base,
        cursorAccent: base.background,
        selectionBackground: "#36b98a40",
        black: "#292a26", red: "#a44a36", green: "#2d6a4b", yellow: "#87662e", blue: "#36608a", magenta: "#8e44ad", cyan: "#13808a", white: "#d4d2c7",
        brightBlack: "#6b6d64", brightRed: "#b5503b", brightGreen: "#2a9b72", brightYellow: "#a8802f", brightBlue: "#4f82b3", brightMagenta: "#a35bc4", brightCyan: "#1a9aa6", brightWhite: "#fdfcf9",
      };
}

// ---------------------------------------------------------------- a line-based shell
type Line = ShellEvent;

/**
 * Without python3 there's no pseudo-terminal: a shell's output and a command line. It reattaches
 * after a reload; Stop and Restart open a new one in the same folder.
 */
function ShellView({ id, places, split, focused, shown, onFocus, onReplace }: ViewProps) {
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>(() => store.json("termHistory", []));
  const [at, setAt] = useState(-1);
  const [error, setError] = useState("");
  const out = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shown) return;
    return subscribe(`shell:${id}`, (ev: ShellEvent | Hello | Gone) => {
      // The shell is gone (code-flow restarted).
      if (ev.type === "error") return setError(GONE);
      if (ev.type === "hello") {
        setShell(ev.shell);
        setLines(ev.history);
        return;
      }
      if (ev.type === "busy") return;
      setLines((l) => append(l, ev));
      if (ev.type === "done") setShell((cur) => (cur ? { ...cur, busy: false, cwd: ev.cwd } : cur));
      else if (ev.type === "exit") setShell((cur) => (cur ? { ...cur, status: "exited", exitCode: ev.code, busy: false } : cur));
      else if (ev.type === "input") setShell((cur) => (cur ? { ...cur, busy: true } : cur));
    });
  }, [id, shown]);

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
  return (
    <div class={`term-pane ${focused && split ? "focused" : ""}`} onMouseDown={onFocus}>
      <ShellHead shell={shell} places={places} onClear={() => setLines([])} onRestart={restart} />
      <div class="term" onClick={(e) => (e.target as HTMLElement).closest("pre") && !window.getSelection()?.toString() && input.current?.focus()}>
        <pre class="term-out" ref={out} aria-live="polite" aria-label="Terminal output">
          {!lines.length ? (
            <span class="help">{error || (shell ? `${shell.shell} in ${shell.cwd}. code-flow found no python3 for a real terminal, so commands run one at a time: no pagers, prompts or full-screen programs.` : "Connecting…")}</span>
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
            ) : l.type === "exit" ? (
              <span key={i} class="exit">{`\n[shell exited${l.code === null ? "" : ` with ${l.code}`} — Restart opens a new one]\n`}</span>
            ) : null,
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
  usePoll(
    (current) => api<DevServer | null>(`/api/runs/${enc(runId)}/worktrees/${enc(name)}/serve`).then((s) => current() && setServer(s), () => {}),
    2_000,
    [appKey],
    sideOpen.value && sideTab.value === "terminal",
  );
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
        {/* Read out when the app exits; the log itself isn't (it's replaced every poll). */}
        <span class="help" role="status">
          {server?.status === "exited" ? `exited${server.exitCode == null ? "" : ` with ${server.exitCode}`}` : "read-only log"}
        </span>
      </div>
      <div class="term">
        <pre class="term-out" ref={out} tabIndex={0} aria-label="App log">
          {server?.logs.length ? server.logs.join("\n") : <span class="help">{server ? "No output yet." : "Loading…"}</span>}
        </pre>
      </div>
    </div>
  );
}
