import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, baseName, onPhone, post, showToast } from "./lib.js";
import { Menu, MenuItem, MenuTitle, Strip, type StripItem } from "./panel-bits.js";
import { sideChatsOf } from "./side-chat.js";
import { draftTo, openSide, projectKeyOf, rememberSide, route, runs, setSideChat, sideMemo, sideMemory, sideScope, type SideScope } from "./state.js";
import type { Attachment, DevServer, RunSummary } from "./types.js";

/**
 * The side panel's Browser: pages of its own (tabs) per run or project, the app a run started
 * first. A local app is shown through code-flow's preview proxy (src/preview.ts), which lets you
 * annotate it: pick an element or draw a box, say what's wrong, try a style change (Adjust), and
 * send it all, with snapshots, to the run's main chat (or a side chat, or a new run). It also
 * collects the page's console errors and failed requests.
 */

type Device = "phone" | "tablet" | "full";
const WIDTHS: Record<Device, string> = { phone: "390px", tablet: "768px", full: "100%" };
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Something you pointed at on the page, and what you said about it. */
interface Pin {
  n: number;
  /** The overlay's id for it (what Adjust refers to). */
  id: number;
  kind: "element" | "box";
  selector: string;
  text: string;
  html?: string;
  styles?: Record<string, string>;
  rect: Rect;
  url: string;
  viewport: { w: number; h: number };
  /** A PNG data URL, when the page could be drawn. */
  image?: string;
  comment: string;
  /** Style changes you tried (Adjust). */
  tried?: Record<string, string>;
}
interface ConsoleLine {
  level: "error" | "warn" | "network";
  text: string;
  at: number;
}
interface PageState {
  pins: Pin[];
  console: ConsoleLine[];
  capturing: number;
  /** The page's address as you'd type it (the app's own, not the preview's). */
  at?: string;
  /** The overlay answered in the page as it is now: Pick, Box and Console work. */
  ready?: boolean;
  /** Why they don't, when they don't. */
  why?: string;
}
/** Per page (scope|page id): pins and console survive switching tabs and pages. */
const pages = signal<Record<string, PageState>>({});
const pageState = (key: string): PageState => pages.value[key] ?? { pins: [], console: [], capturing: 0 };
const setPage = (key: string, fn: (p: PageState) => PageState) => (pages.value = { ...pages.value, [key]: fn(pageState(key)) });
/** How to reach each page's overlay (set while its frame is shown). */
const overlays = new Map<string, (msg: Record<string, unknown>) => void>();

/** An address as the browser should load it: with a scheme, and from the phone, on the computer's Wi-Fi address. */
export function address(target: string): string {
  let next = target.trim();
  if (!next) return "";
  if (!/^https?:\/\//i.test(next)) next = /^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/.test(next) ? `http://${next}` : `https://${next}`;
  if (onPhone) next = next.replace("//localhost:", `//${location.hostname}:`).replace("//127.0.0.1:", `//${location.hostname}:`);
  return next;
}
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "") || "New page";
const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function BrowserTab() {
  const s = sideScope.value;
  const memo = sideMemo.value;
  const [servers, setServers] = useState<Omit<DevServer, "logs">[]>([]);
  const [mode, setMode] = useState<"off" | "pick" | "box">("off");
  const [showConsole, setShowConsole] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = () => api<Omit<DevServer, "logs">[]>("/api/serve").then((x) => alive && setServers(x), () => {});
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
  const folders = s.run ? s.run.worktrees.map((w) => w.path) : [s.repo, ...(s.project?.repos ?? [])].filter(Boolean);
  const mine = running.filter((x) => folders.some((f) => within(x.cwd, f)));

  const list = memo.pages ?? (memo.url ? [{ id: "p0", url: memo.url }] : []);
  const active = list.find((p) => p.id === memo.page) ?? list[0];
  const second = memo.compare && memo.compare !== active?.id ? list.find((p) => p.id === memo.compare) : undefined;
  const device: Device = memo.device ?? "full";

  // Nothing open here yet: the app this run (or project) started, else what its project had open.
  useEffect(() => {
    if (list.length) return;
    const start = (mine[0] ? address(mine[0].url) : "") || (s.run ? sideMemory.value[projectKeyOf(s.run)]?.pages?.[0]?.url : "") || "";
    if (start) rememberSide({ pages: [{ id: newId(), url: start }] });
  }, [s.key, list.length, mine[0]?.url]);

  const openPage = (url: string) => {
    const existing = list.find((p) => p.url === url);
    if (existing) return rememberSide({ page: existing.id });
    const id = newId();
    rememberSide({ pages: [...list, { id, url }], page: id });
  };
  const go = (target: string) => {
    const url = address(target);
    if (!url) return;
    if (!active) return openPage(url);
    rememberSide({ pages: list.map((p) => (p.id === active.id ? { ...p, url } : p)) });
    setNonce((n) => n + 1);
  };
  const close = (id: string) => {
    const rest = list.filter((p) => p.id !== id);
    rememberSide({ pages: rest, page: active?.id === id ? rest.at(-1)?.id : active?.id, compare: memo.compare === id ? undefined : memo.compare });
  };
  const runApp = async (run: RunSummary, worktree: string) => {
    try {
      const server = await post<DevServer>(`/api/runs/${run.id}/worktrees/${encodeURIComponent(worktree)}/serve`, {});
      openPage(address(server.url));
    } catch (err) {
      showToast((err as Error).message, 6000);
    }
  };
  const key = active ? `${s.key}|${active.id}` : "";
  const state = key ? pageState(key) : undefined;
  const errors = state?.console.filter((c) => c.level !== "warn").length ?? 0;
  const local = !!active?.url && LOCAL.test(active.url) && !onPhone;
  // Pick, Box and Console need the overlay in the page: only once it has answered.
  const annotatable = local && !!state?.ready;
  useEffect(() => setMode("off"), [key]);
  useEffect(() => {
    if (!annotatable) setMode("off");
  }, [annotatable]);

  const items: StripItem[] = list.map((p) => ({ key: p.id, label: shortUrl(pageState(`${s.key}|${p.id}`).at ?? p.url), title: p.url || "New page", below: p.id === second?.id }));
  const idle = s.run ? s.run.worktrees.filter((w) => !running.some((x) => x.key === `${s.run!.id}/${w.name}`)) : [];
  return (
    <>
      <Strip items={items} active={active?.id} onPick={(id) => rememberSide({ page: id })} onClose={close} label="Open pages">
        <Menu label="New page" icon="plus" title="Open a page: an app that's running, or any address">
          {(done) => (
            <>
              <MenuItem
                sub="Type an address"
                onClick={() => {
                  done();
                  const id = newId();
                  rememberSide({ pages: [...list, { id, url: "" }], page: id });
                }}
              >
                New page
              </MenuItem>
              {running.length ? <MenuTitle>Running apps</MenuTitle> : null}
              {[...mine, ...running.filter((x) => !mine.includes(x))].map((x) => (
                <MenuItem
                  key={x.key}
                  sub={`${x.command} in ${baseName(x.cwd)}`}
                  onClick={() => {
                    done();
                    openPage(address(x.url));
                  }}
                >
                  {shortUrl(x.url)}
                </MenuItem>
              ))}
              {s.run && idle.length ? <MenuTitle>Run the app in</MenuTitle> : null}
              {s.run
                ? idle.map((w) => (
                    <MenuItem
                      key={w.name}
                      disabled={!s.run!.app?.command}
                      sub={s.run!.app?.command ? `${s.run!.app.command} on a free port` : "Set how to start it under the result (Run app) first"}
                      onClick={() => {
                        done();
                        void runApp(s.run!, w.name);
                      }}
                    >
                      ▶ {w.name}
                    </MenuItem>
                  ))
                : null}
            </>
          )}
        </Menu>
        <button
          type="button"
          class={`icon-btn ${second ? "on" : ""}`}
          aria-pressed={!!second}
          aria-label="Compare"
          title={list.length < 2 ? "Open a second page (another worktree's app, say) to compare side by side" : second ? "One page" : "Side by side with the next page"}
          disabled={list.length < 2}
          onClick={() => rememberSide({ compare: second ? undefined : list.find((p) => p.id !== active?.id)?.id })}
        >
          <Icon name="compare" />
        </button>
      </Strip>
      {active ? (
        <AddressBar
          key={`${active.id}:${active.url}`}
          url={state?.at ?? active.url}
          onGo={go}
          onReload={() => setNonce((n) => n + 1)}
          device={device}
          onDevice={(d) => rememberSide({ device: d })}
          mode={mode}
          onMode={setMode}
          canAnnotate={annotatable}
          why={state?.why ?? (local ? "Waiting for the page" : "Annotating works on apps on this computer (localhost)")}
          errors={errors}
          showConsole={showConsole}
          onConsole={() => setShowConsole(!showConsole)}
        />
      ) : null}
      <div class={`browse ${second ? "compare" : ""}`}>
        {!active || !active.url ? (
          <div class="browse-empty">
            <p>
              Open the app a run started with <b>Run app</b>, or type an address.
            </p>
            <p class="help">Apps on this computer (localhost) can be annotated: pick an element or draw a box, say what's wrong, and send it to the agent with a snapshot.</p>
          </div>
        ) : (
          <>
            <PageFrame key={`${key}#${nonce}`} pageKey={key} url={active.url} device={device} mode={mode} onModeOff={() => setMode("off")} />
            {second?.url ? <PageFrame key={`${s.key}|${second.id}#${nonce}`} pageKey={`${s.key}|${second.id}`} url={second.url} device={device} mode="off" onModeOff={() => {}} /> : null}
          </>
        )}
      </div>
      {showConsole && state ? <ConsoleDrawer pageKey={key} lines={state.console} /> : null}
      {state && (state.pins.length || state.capturing) ? <PinsTray scope={s} pageKey={key} state={state} onSent={() => setMode("off")} /> : null}
    </>
  );
}

function AddressBar(props: {
  url: string;
  onGo: (url: string) => void;
  onReload: () => void;
  device: Device;
  onDevice: (d: Device) => void;
  mode: "off" | "pick" | "box";
  onMode: (m: "off" | "pick" | "box") => void;
  canAnnotate: boolean;
  /** Why Pick, Box and Console are off. */
  why: string;
  errors: number;
  showConsole: boolean;
  onConsole: () => void;
}) {
  const [typed, setTyped] = useState(props.url);
  useEffect(() => setTyped(props.url), [props.url]);
  const toggle = (m: "pick" | "box") => props.onMode(props.mode === m ? "off" : m);
  return (
    <>
      <div class="side-toolbar browse-bar">
        <input type="url" class="field mono" aria-label="Address" placeholder="localhost:3000, or an address…" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && props.onGo(typed)} />
        <button type="button" class="btn ghost small" title="Reload" aria-label="Reload" disabled={!props.url} onClick={props.onReload}>
          <Icon name="refresh" />
        </button>
        <a class={`btn ghost small ${props.url ? "" : "off"}`} href={props.url || "#"} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab" aria-disabled={!props.url}>
          <Icon name="external" />
        </a>
      </div>
      <div class="browse-tools">
        <div class="segmented small" role="group" aria-label="Width">
          {(["phone", "tablet", "full"] as const).map((d) => (
            <button key={d} type="button" class={props.device === d ? "on" : ""} aria-pressed={props.device === d} title={d === "full" ? "As wide as the panel" : `${WIDTHS[d]} wide`} onClick={() => props.onDevice(d)}>
              {d === "phone" ? "Phone" : d === "tablet" ? "Tablet" : "Full"}
            </button>
          ))}
        </div>
        <span class="spacer" />
        <button type="button" class={`btn small annotate ${props.mode === "pick" ? "on" : ""}`} aria-pressed={props.mode === "pick"} disabled={!props.canAnnotate} title={props.canAnnotate ? "Click an element in the page to comment on it (Esc stops)" : props.why} onClick={() => toggle("pick")}>
          Pick
        </button>
        <button type="button" class={`btn small annotate ${props.mode === "box" ? "on" : ""}`} aria-pressed={props.mode === "box"} disabled={!props.canAnnotate} title={props.canAnnotate ? "Drag a box over an area of the page to comment on it" : props.why} onClick={() => toggle("box")}>
          Box
        </button>
        <button type="button" class={`btn small ${props.errors ? "danger" : ""}`} aria-pressed={props.showConsole} disabled={!props.canAnnotate} title={props.canAnnotate ? "Console errors and failed requests from the page" : props.why} onClick={props.onConsole}>
          Console{props.errors ? ` · ${props.errors}` : ""}
        </button>
      </div>
    </>
  );
}

/** One page: a local app through the preview (with the overlay), anything else as it is. */
function PageFrame({ pageKey, url, device, mode, onModeOff }: { pageKey: string; url: string; device: Device; mode: "off" | "pick" | "box"; onModeOff: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<{ src: string; origin?: string } | null>(null);
  const [problem, setProblem] = useState("");
  const local = LOCAL.test(url) && !onPhone;
  const targetOrigin = local ? new URL(url).origin : "";
  useEffect(() => {
    let alive = true;
    setProblem("");
    setPage(pageKey, (p) => ({ ...p, ready: false, why: local ? "Waiting for the page" : "Annotating works on apps on this computer (localhost)" }));
    if (!local) return setView({ src: url });
    post<{ url: string; origin: string }>("/api/preview", { url }).then(
      (p) => alive && setView({ src: p.url, origin: p.origin }),
      (err) => {
        if (!alive) return;
        // code-flow's own page is never proxied: annotating is for your app.
        const why = /code-flow itself/.test((err as Error).message)
          ? "This is code-flow itself, so it can't be annotated here. Open your app: Run app on a run, or its localhost address."
          : `${(err as Error).message}: showing it without annotations.`;
        setProblem(why);
        setPage(pageKey, (p) => ({ ...p, why }));
        setView({ src: url });
      },
    );
    return () => {
      alive = false;
    };
  }, [url]);

  // The listener is in place before the frame exists: a fast page says hello back before effects would run.
  const origin = useRef<string | undefined>();
  origin.current = view?.origin;
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const send = (msg: Record<string, unknown>) => {
    if (origin.current) frame.current?.contentWindow?.postMessage({ codeflow: 1, ...msg }, origin.current);
  };
  useEffect(() => {
    overlays.set(pageKey, send);
    const onMessage = (e: MessageEvent) => {
      const from = origin.current;
      if (!from || e.source !== frame.current?.contentWindow || e.origin !== from || e.data?.codeflow !== 1) return;
      const view = { origin: from };
      const mode = modeNow.current;
      const m = e.data;
      if (m.type === "ready" || m.type === "location") {
        setPage(pageKey, (p) => ({ ...p, at: String(m.url).replace(view.origin!, targetOrigin), ...(m.type === "ready" ? { ready: true, why: undefined } : {}) }));
        if (m.type === "ready") {
          send({ type: "mode", mode });
          send({ type: "pins", pins: pageState(pageKey).pins.map((p) => ({ n: p.n, rect: p.rect, kind: p.kind })) });
        }
      } else if (m.type === "console") {
        setPage(pageKey, (p) => ({ ...p, console: [...p.console.slice(-299), { level: m.level, text: m.text, at: m.at }] }));
      } else if (m.type === "pin-start") {
        setPage(pageKey, (p) => ({ ...p, capturing: p.capturing + 1 }));
      } else if (m.type === "pin") {
        setPage(pageKey, (p) => ({ ...p, capturing: Math.max(0, p.capturing - 1), pins: [...p.pins, { ...m.pin, url: String(m.pin.url).replace(view.origin!, targetOrigin), n: (p.pins.at(-1)?.n ?? 0) + 1, comment: "" }] }));
      } else if (m.type === "mode") {
        onModeOff();
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (overlays.get(pageKey) === send) overlays.delete(pageKey);
    };
  }, [pageKey]);
  useEffect(() => send({ type: "mode", mode }), [mode, view?.origin]);
  const pins = pageState(pageKey).pins;
  useEffect(() => send({ type: "pins", pins: pins.map((p) => ({ n: p.n, rect: p.rect, kind: p.kind })) }), [pins.length, view?.origin]);

  return (
    <div class="browse-page">
      {problem ? <div class="msg warn browse-note">{problem}</div> : null}
      <div class="browse-frame" style={`width:${WIDTHS[device]}`}>
        {view ? (
          <iframe
            ref={frame}
            src={view.src}
            title="Browser"
            referrerpolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            onLoad={() => {
              if (!origin.current) return;
              // A new document: its overlay answers the hello, or this page can't be annotated.
              setPage(pageKey, (p) => ({ ...p, ready: false, why: "Waiting for the page" }));
              send({ type: "hello" });
              setTimeout(() => {
                if (!pageState(pageKey).ready) setPage(pageKey, (p) => ({ ...p, why: "The page didn't load code-flow's annotation script, so it can't be annotated" }));
              }, 3_000);
            }}
          />
        ) : (
          <div class="side-empty help">Opening…</div>
        )}
      </div>
    </div>
  );
}

function ConsoleDrawer({ pageKey, lines }: { pageKey: string; lines: ConsoleLine[] }) {
  return (
    <div class="browse-console">
      <div class="bc-head">
        <span class="lbl">Console</span>
        <span class="help">errors, warnings and failed requests since the page opened</span>
        <span class="spacer" />
        <button type="button" class="btn ghost small" disabled={!lines.length} onClick={() => setPage(pageKey, (p) => ({ ...p, console: [] }))}>
          Clear
        </button>
      </div>
      <div class="bc-lines">
        {lines.length ? (
          lines.map((l, i) => (
            <div key={i} class={`bc-line ${l.level}`}>
              <span class="bc-level">{l.level === "network" ? "net" : l.level}</span>
              <span class="bc-text">{l.text}</span>
            </div>
          ))
        ) : (
          <div class="help">Nothing yet.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pins: what you say, and where it goes
const ADJUST = ["font-size", "font-weight", "color", "background-color", "padding", "margin", "border-radius", "gap"];

/** Where pins can go from this scope: the run's main chat first, its side chats, a new side chat, a new run. */
function destinations(s: SideScope): { key: string; label: string; sub: string }[] {
  const out: { key: string; label: string; sub: string }[] = [];
  const run = s.run;
  if (run && (run.status === "done" || run.status === "running")) {
    out.push({ key: `main:${run.id}`, label: "Main chat", sub: run.status === "running" ? "To the team while it works" : "A reply to the agent that built it" });
    for (const c of sideChatsOf(run)) out.push({ key: c.key, label: `Side chat: ${c.title}`, sub: "In this run's worktree" });
    out.push({ key: "side:new", label: "New side chat", sub: "A conversation of its own, in this run's worktree" });
  }
  for (const id of sideMemo.value.chats ?? []) {
    const chat = runs.value.get(id);
    if (chat) out.push({ key: `main:${chat.id}`, label: `Chat: ${chat.task.split("\n")[0]!.slice(0, 40)}`, sub: "A chat on its own branch" });
  }
  out.push({ key: "composer", label: "New run", sub: "The task of a new run, in the composer" });
  return out;
}

/** The pins as a message: what each one points at and what you said, then the snapshots. */
function pinsMessage(pins: Pin[], console: ConsoleLine[]): { text: string; images: Attachment[] } {
  const url = pins[0]?.url ?? "";
  const lines = pins.map((p) => {
    const what = p.kind === "box" ? `an area ${p.rect.w}×${p.rect.h} at ${p.rect.x},${p.rect.y} (around \`${p.selector}\`)` : `\`${p.selector}\``;
    const parts = [`${p.n}. ${what}: ${p.comment.trim() || "(no comment)"}`];
    if (p.text) parts.push(`   Text: "${p.text.slice(0, 120)}"`);
    if (p.html) parts.push(`   HTML: ${p.html.replace(/\s+/g, " ").slice(0, 240)}`);
    if (p.tried && Object.values(p.tried).some(Boolean)) parts.push(`   Tried in the browser: ${Object.entries(p.tried).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    if (p.image) parts.push(`   Snapshot: pin-${p.n}.png`);
    return parts.join("\n");
  });
  const errors = console.filter((c) => c.level !== "warn").slice(-20);
  const head = url ? `From the app in the browser (${url}${pins[0] ? `, ${pins[0].viewport.w}px wide` : ""}):` : "From the app in the browser:";
  const text = [head, ...lines, errors.length ? `Console errors and failed requests:\n${errors.map((e) => `- ${e.text.split("\n")[0]!.slice(0, 300)}`).join("\n")}` : ""].filter(Boolean).join("\n");
  const images = pins
    .filter((p) => p.image)
    .map((p) => {
      const data = p.image!.replace(/^data:image\/png;base64,/, "");
      return { name: `pin-${p.n}.png`, size: Math.round((data.length * 3) / 4), data };
    });
  return { text, images };
}

function PinsTray({ scope, pageKey, state, onSent }: { scope: SideScope; pageKey: string; state: PageState; onSent: () => void }) {
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [withConsole, setWithConsole] = useState(false);
  const errors = state.console.filter((c) => c.level !== "warn");
  const options = destinations(scope);
  const remembered = options.find((o) => o.key === sideMemo.value.sendTo);
  const primary = remembered ?? options[0]!;
  const update = (n: number, patch: Partial<Pin>) => setPage(pageKey, (p) => ({ ...p, pins: p.pins.map((x) => (x.n === n ? { ...x, ...patch } : x)) }));
  const remove = (pin: Pin) => {
    overlays.get(pageKey)?.({ type: "reset", id: pin.id });
    setPage(pageKey, (p) => ({ ...p, pins: p.pins.filter((x) => x.n !== pin.n) }));
  };
  const sendTo = (to: string) => {
    const { text, images } = pinsMessage(state.pins, withConsole ? errors : []);
    draftTo(to, text, images);
    rememberSide({ sendTo: to });
    for (const p of state.pins) overlays.get(pageKey)?.({ type: "reset", id: p.id });
    setPage(pageKey, (p) => ({ ...p, pins: [] }));
    onSent();
    if (to.startsWith("main:")) {
      const id = to.slice(5);
      if (scope.run?.id === id) route.value = { view: "run", id };
      else {
        setSideChat(id);
        openSide("chat");
      }
      showToast("Added to the message box: add a line if you like, then send");
    } else if (to.startsWith("side:")) {
      setSideChat(to === "side:new" ? null : to);
      openSide("chat");
    } else {
      route.value = { view: "composer" };
      showToast("Added to the task in the composer");
    }
  };
  return (
    <div class="pins-tray">
      {state.pins.map((p) => (
        <div key={p.n} class="pin-row">
          <span class="pin-n">{p.n}</span>
          <div class="pin-main">
            <div class="pin-what" title={p.html ?? p.selector}>
              {p.kind === "box" ? `Area ${p.rect.w}×${p.rect.h}` : p.selector}
              {p.image ? <img class="pin-thumb" src={p.image} alt={`Snapshot of pin ${p.n}`} /> : <span class="help"> · no snapshot</span>}
            </div>
            <input class="field" aria-label={`What about pin ${p.n}?`} placeholder="What's wrong, or what should change?" value={p.comment} onInput={(e) => update(p.n, { comment: e.currentTarget.value })} />
            {adjusting === p.n && p.kind === "element" ? (
              <div class="adjust">
                {ADJUST.map((prop) => (
                  <label key={prop} class="adj">
                    <span>{prop}</span>
                    <input
                      class="field mono"
                      placeholder={p.styles?.[prop] ?? ""}
                      value={p.tried?.[prop] ?? ""}
                      onInput={(e) => {
                        const tried = { ...p.tried, [prop]: e.currentTarget.value };
                        update(p.n, { tried });
                        overlays.get(pageKey)?.({ type: "adjust", id: p.id, styles: { [prop]: e.currentTarget.value } });
                      }}
                    />
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <div class="pin-actions">
            {p.kind === "element" ? (
              <button type="button" class={`btn ghost small ${adjusting === p.n ? "on" : ""}`} title="Try style changes on the page; what you try goes with the pin" onClick={() => setAdjusting(adjusting === p.n ? null : p.n)}>
                Adjust
              </button>
            ) : null}
            <button type="button" class="icon-btn" aria-label={`Remove pin ${p.n}`} title="Remove" onClick={() => remove(p)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
      ))}
      {state.capturing ? <div class="help">Taking a snapshot…</div> : null}
      <div class="pins-actions">
        {errors.length ? (
          <label class="check">
            <input type="checkbox" checked={withConsole} onChange={(e) => setWithConsole(e.currentTarget.checked)} /> with {errors.length} console error{errors.length === 1 ? "" : "s"}
          </label>
        ) : null}
        <span class="spacer" />
        <Menu label="Send to" icon="chevron" title="Send the pins somewhere else">
          {(done) => (
            <>
              <MenuTitle>Send to</MenuTitle>
              {options.map((o) => (
                <MenuItem
                  key={o.key}
                  on={o.key === primary.key}
                  sub={o.sub}
                  onClick={() => {
                    done();
                    sendTo(o.key);
                  }}
                >
                  {o.label}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <button type="button" class="btn primary small" disabled={!state.pins.length} onClick={() => sendTo(primary.key)}>
          Add to {primary.key.startsWith("main:") && primary.label === "Main chat" ? "main chat" : primary.key === "composer" ? "a new run" : primary.label.toLowerCase().startsWith("side chat") ? "side chat" : primary.label}
        </button>
      </div>
    </div>
  );
}
