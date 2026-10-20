import { confirmAction } from "./confirm-state.js";
import { JourneyRecorder, recording, recordAction } from "./journeys.js";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, baseName, onPhone, post, showToast, usePoll } from "./lib.js";
import { Menu, MenuItem, MenuTitle, resultWorktree, Strip, type StripItem } from "./panel-bits.js";
import { sideChatsOf } from "./side-chat.js";
import { draftTo, navigate, openSide, poppedScope, projectKeyOf, rememberSide, runs, setSideChat, sideMemo, sideMemory, sideOpen, sideScope, sideTab, type SideScope } from "./state.js";
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
  /** The overlay's id for it (what Adjust refers to): opaque, and unique across the page's loads. */
  id: string | number;
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
  /** Picked in an earlier load of the page: its element is gone, so Adjust can't reach it. */
  gone?: boolean;
  /** A box drawn on a snapshot (its rect is in the snapshot's pixels), not on the live page. */
  source?: "snapshot";
}
/** A screenshot of the page from a headless Chrome (snapshot mode), to draw boxes on. */
interface Snap {
  /** The address it was taken of (where it ended up is `url`). */
  asked: string;
  /** PNG data URL. */
  image: string;
  width: number;
  height: number;
  url: string;
  title: string;
  full: boolean;
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
  /** The frame shows the page through the preview, where the overlay can be. */
  preview?: boolean;
  /** The overlay answered in the page as it is now: Pick, Box and Console work. */
  ready?: boolean;
  /** Why they don't, when they don't. */
  why?: string;
  /** Snapshot mode: the latest snapshot, whether it's shown instead of the live page, and how taking one went. */
  snap?: Snap;
  showSnap?: boolean;
  snapping?: boolean;
  snapError?: string;
  /** The latest snapshot asked for: a result for an older one (or for a page you've since left) is dropped. */
  snapAsk?: number;
  /** The address of the snapshot being taken. */
  snapAsking?: string;
}
/** Per page (scope|page id): pins and console survive switching tabs and pages. */
const pages = signal<Record<string, PageState>>({});
const pageState = (key: string): PageState => pages.value[key] ?? { pins: [], console: [], capturing: 0 };
const setPage = (key: string, fn: (p: PageState) => PageState) => (pages.value = { ...pages.value, [key]: fn(pageState(key)) });
/** Back to the live page, and any snapshot still on its way is dropped when it comes. */
const leaveSnap = (p: PageState): Partial<PageState> => ({ showSnap: false, snapping: false, snapError: undefined, snapAsk: (p.snapAsk ?? 0) + 1, snapAsking: undefined });
/** The same page, however it's written (`localhost:3000` and `http://localhost:3000/`). */
const sameAddress = (a: string | undefined, b: string | undefined) => {
  if (!a || !b) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};
/** A snapshot is of the page at `here`: the address it was asked for, or where the page ended up. */
const snapOf = (snap: Snap | undefined, here: string | undefined) => !!snap && (sameAddress(snap.asked, here) || sameAddress(snap.url, here));
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

/**
 * The app's own address for one reported from the frame, which is on the preview's origin. The
 * page's own scripts can post these messages too, so anything else (another site, a javascript:
 * URL) is ignored: it would end up in the address bar and the "Open in a new tab" link.
 */
export function appAddress(reported: unknown, preview: string, app: string): string | undefined {
  if (typeof reported !== "string" || (reported !== preview && !reported.startsWith(`${preview}/`))) return undefined;
  return app + reported.slice(preview.length);
}

export function BrowserTab() {
  const s = sideScope.value;
  const memo = sideMemo.value;
  const [servers, setServers] = useState<Omit<DevServer, "logs">[]>([]);
  const [mode, setMode] = useState<"off" | "pick" | "box">("off");
  const [showConsole, setShowConsole] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Only while you can see the tab: a closed panel, another tab or a hidden window asks for nothing.
  usePoll((current) => api<Omit<DevServer, "logs">[]>("/api/serve").then((x) => current() && setServers(x), () => {}), 5_000, [], sideOpen.value && sideTab.value === "browser");
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

  // Nothing ever opened here: the app this run (or project) started, else what its project had open.
  // Pages you closed stay closed.
  useEffect(() => {
    if (memo.pages || memo.url) return;
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
    // Where the old address had got to is no longer where the page is: until the new page says
    // (a page that isn't local never does), the address is the one you typed.
    // A snapshot shown, or still being taken, is of the old address: back to the live page. The last
    // one stays, for the boxes already drawn on it.
    setPage(`${s.key}|${active.id}`, (p) => ({ ...p, at: undefined, ...leaveSnap(p) }));
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
  // Annotating needs the overlay: the page shown through the preview (an https://localhost address,
  // say, is refused by it and shown as it is), and the overlay answering in the page as it is now.
  const local = !!active?.url && LOCAL.test(active.url) && !onPhone;
  const canAnnotate = !!active?.url && !!state?.preview && !!state?.ready && !state.showSnap;
  useEffect(() => setMode("off"), [key, canAnnotate]);
  const area = useRef<HTMLDivElement>(null);
  /** Snapshot mode: any page, in a headless Chrome at the width you're looking at it. */
  /** Takes one: false when you'd rather keep the boxes drawn on the one you have. */
  const snapshot = async (full = state?.snap?.full ?? false): Promise<boolean> => {
    if (!active?.url) return false;
    const at = key;
    const drawn = pageState(at).pins.filter((x) => x.source === "snapshot").length;
    if (drawn && !await confirmAction(`A new snapshot drops the ${drawn === 1 ? "box" : `${drawn} boxes`} drawn on this one. Take it anyway?`, {"title":"Replace annotated snapshot?","confirmLabel":"Take new snapshot","danger":true})) return false;
    const asked = pageState(at).at ?? active.url;
    // A phone's or a tablet's screen, or the space this page has in the panel (half of it, comparing
    // side by side): the live page, or the snapshot shown in its place.
    const slot = area.current?.querySelector<HTMLElement>(":scope > .browse-page:not([hidden])") ?? area.current;
    const width = device === "phone" ? 390 : device === "tablet" ? 768 : Math.min(2560, Math.max(320, slot?.clientWidth || 1280));
    const height = device === "phone" ? 844 : device === "tablet" ? 1024 : Math.min(1600, Math.max(480, slot?.clientHeight || 800));
    const ask = (pageState(at).snapAsk ?? 0) + 1;
    setPage(at, (p) => ({ ...p, showSnap: true, snapping: true, snapError: undefined, snapAsk: ask, snapAsking: asked }));
    try {
      const shot = await post<Omit<Snap, "full" | "asked">>("/api/snapshot", { url: asked, width, height, full });
      // Boxes drawn on the old snapshot point at its pixels: they go with it.
      setPage(at, (p) => (p.snapAsk !== ask ? p : { ...p, snapping: false, snapAsking: undefined, snap: { ...shot, image: `data:image/png;base64,${shot.image}`, full, asked }, pins: p.pins.filter((x) => x.source !== "snapshot") }));
    } catch (err) {
      setPage(at, (p) => (p.snapAsk !== ask ? p : { ...p, snapping: false, snapAsking: undefined, snapError: (err as Error).message }));
    }
    return true;
  };
  const here = state?.at ?? active?.url;
  // The Snapshot button: back to the live page; the snapshot of this page again (or the one on its
  // way); or a new one, and if you'd rather keep the boxes on the one you have, that one.
  const toggleSnapshot = () => {
    if (!state) return;
    const show = () => setPage(key, (p) => ({ ...p, showSnap: true }));
    if (state.showSnap) return setPage(key, (p) => ({ ...p, showSnap: false }));
    if (state.snapping ? sameAddress(state.snapAsking, here) : snapOf(state.snap, here)) return show();
    void snapshot().then((took) => !took && pageState(key).snap && show());
  };

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
          onReload={() => {
            setPage(key, (p) => ({ ...p, ...leaveSnap(p) }));
            setNonce((n) => n + 1);
          }}
          device={device}
          onDevice={(d) => rememberSide({ device: d })}
          mode={mode}
          onMode={setMode}
          canAnnotate={canAnnotate}
          why={state?.why ?? (local ? "Waiting for the page" : "Annotating works on apps on this computer (localhost)")}
          errors={errors}
          showConsole={showConsole}
          onConsole={() => setShowConsole(!showConsole)}
          snapshotOn={!!state?.showSnap}
          onSnapshot={toggleSnapshot}
        />
      ) : null}
      {active?.url ? <JourneyRecorder key={key} pageKey={key} url={here || active.url} repository={s.repo} width={device === "phone" ? 390 : device === "tablet" ? 768 : 1280} ready={canAnnotate} toggle={active => { setMode("off"); overlays.get(key)?.({ type: "recording", active }); }} /> : null}
      <div class={`browse ${second ? "compare" : ""}`} ref={area}>
        {!active || !active.url ? (
          <div class="browse-empty">
            <p>
              Open the app a run started with <b>Run app</b>, or type an address.
            </p>
            <p class="help">Apps on this computer (localhost) can be annotated: pick an element or draw a box, say what's wrong, and send it to the agent with a snapshot. For any other page, take a <b>Snapshot</b> and draw boxes on that.</p>
          </div>
        ) : (
          <>
            {state?.showSnap ? <SnapshotView pageKey={key} state={state} here={here} onTake={(full) => void snapshot(full)} onLive={() => setPage(key, (p) => ({ ...p, showSnap: false }))} /> : null}
            {/* The live page stays loaded behind a snapshot, so going back to it is instant. */}
            <PageFrame key={`${key}#${nonce}`} pageKey={key} url={active.url} device={device} mode={mode} onModeOff={() => setMode("off")} hidden={!!state?.showSnap} />
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
  snapshotOn: boolean;
  onSnapshot: () => void;
}) {
  const [typed, setTyped] = useState(props.url);
  useEffect(() => setTyped(props.url), [props.url]);
  const toggle = (m: "pick" | "box") => props.onMode(props.mode === m ? "off" : m);
  return (
    <>
      <div class="side-toolbar browse-bar">
        <input type="url" class="field mono" aria-label="Address" placeholder="localhost:3000, or an address…" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && props.onGo(typed)} />
        <button type="button" class="icon-btn" title="Reload" aria-label="Reload" disabled={!props.url} onClick={props.onReload}>
          <Icon name="refresh" />
        </button>
        <a class={`icon-btn ${props.url ? "" : "off"}`} href={props.url || "#"} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab" aria-disabled={!props.url}>
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
        <button type="button" class={`btn ghost small annotate ${props.mode === "pick" ? "on" : ""}`} aria-pressed={props.mode === "pick"} disabled={!props.canAnnotate} title={props.canAnnotate ? "Click an element in the page to comment on it (Esc stops)" : props.why} onClick={() => toggle("pick")}>
          Pick
        </button>
        <button type="button" class={`btn ghost small annotate ${props.mode === "box" ? "on" : ""}`} aria-pressed={props.mode === "box"} disabled={!props.canAnnotate} title={props.canAnnotate ? "Drag a box over an area of the page to comment on it" : props.why} onClick={() => toggle("box")}>
          Box
        </button>
        <button type="button" class={`btn ghost small ${props.errors ? "danger" : ""}`} aria-pressed={props.showConsole} disabled={!props.canAnnotate} title={props.canAnnotate ? "Console errors and failed requests from the page" : props.why} onClick={props.onConsole}>
          Console{props.errors ? ` · ${props.errors}` : ""}
        </button>
        <button
          type="button"
          class={`btn ghost small annotate ${props.snapshotOn ? "on" : ""}`}
          aria-pressed={props.snapshotOn}
          disabled={!/^https?:\/\//i.test(props.url)}
          title={props.snapshotOn ? "Back to the live page" : "A screenshot of the page, any page, to draw boxes on (taken by a headless Chrome, signed out)"}
          onClick={props.onSnapshot}
        >
          Snapshot
        </button>
      </div>
    </>
  );
}

/** One page: a local app through the preview (with the overlay), anything else as it is. */
function PageFrame({ pageKey, url, device, mode, onModeOff, hidden = false }: { pageKey: string; url: string; device: Device; mode: "off" | "pick" | "box"; onModeOff: () => void; hidden?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<{ src: string; origin?: string } | null>(null);
  const [problem, setProblem] = useState("");
  const local = LOCAL.test(url) && !onPhone;
  const targetOrigin = local ? new URL(url).origin : "";
  useEffect(() => {
    let alive = true;
    setProblem("");
    setPage(pageKey, (p) => ({ ...p, ready: false, why: local ? "Waiting for the page" : "Annotating works on apps on this computer (localhost)" }));
    if (!local) {
      setPage(pageKey, (p) => ({ ...p, preview: false }));
      return setView({ src: url });
    }
    post<{ url: string; origin: string }>("/api/preview", { url }).then(
      (p) => {
        if (!alive) return;
        setView({ src: p.url, origin: p.origin });
        setPage(pageKey, (page) => ({ ...page, preview: true }));
      },
      (err) => {
        if (!alive) return;
        // code-flow's own page is never proxied: annotating is for your app.
        const why = /code-flow itself/.test((err as Error).message)
          ? "This is code-flow itself, so it can't be annotated here. Open your app: Run app on a run, or its localhost address."
          : `${(err as Error).message}: showing it without annotations.`;
        setProblem(why);
        setPage(pageKey, (p) => ({ ...p, why }));
        setView({ src: url });
        setPage(pageKey, (p) => ({ ...p, preview: false }));
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
      const mode = modeNow.current;
      const m = e.data;
      if (m.type === "ready" || m.type === "location") {
        const at = appAddress(m.url, from, targetOrigin);
        if (at) setPage(pageKey, (p) => ({ ...p, at }));
        if (m.type === "ready") setPage(pageKey, (p) => ({ ...p, ready: true, why: undefined }));
        if (m.type === "ready") {
          // A new document: nothing is being captured in it yet, and what was pinned went with the old one.
          setPage(pageKey, (p) => ({ ...p, capturing: 0, pins: p.pins.map((x) => ({ ...x, gone: true })) }));
          send({ type: "recording", active: recording.value?.page === pageKey && recording.value.active });
          send({ type: "mode", mode });
          send({ type: "pins", pins: livePins(pageState(pageKey).pins) });
        }
      } else if (m.type === "record-action") {
        recordAction(pageKey, m.action);
        if (!recording.value?.active) send({ type: "recording", active: false });
      } else if (m.type === "recording-warning" && recording.value?.page === pageKey) {
        recording.value = { ...recording.value, warning: String(m.text).slice(0, 200) };
      } else if (m.type === "console") {
        setPage(pageKey, (p) => ({ ...p, console: [...p.console.slice(-299), { level: m.level, text: m.text, at: m.at }] }));
      } else if (m.type === "pin-start") {
        setPage(pageKey, (p) => ({ ...p, capturing: p.capturing + 1 }));
      } else if (m.type === "pin") {
        setPage(pageKey, (p) => ({ ...p, capturing: Math.max(0, p.capturing - 1), pins: [...p.pins, { ...m.pin, url: appAddress(m.pin.url, from, targetOrigin) ?? p.at ?? url, n: (p.pins.at(-1)?.n ?? 0) + 1, comment: "" }] }));
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
  useEffect(() => send({ type: "pins", pins: livePins(pins) }), [pins.length, view?.origin]);

  return (
    <div class="browse-page" hidden={hidden}>
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

/** What the overlay draws on the live page: the pins picked there, not boxes drawn on a snapshot. */
const livePins = (pins: Pin[]) => pins.filter((p) => p.source !== "snapshot").map((p) => ({ n: p.n, rect: p.rect, kind: p.kind }));

/** An image, once loaded (load, not decode(): Chrome can leave decode() waiting in a hidden tab). */
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The snapshot couldn't be read"));
    img.src = src;
  });
/** A box's part of the snapshot, as its own PNG: the close-up that goes with the pin. */
async function cropSnap(src: string, r: Rect): Promise<string | undefined> {
  try {
    const img = await loadImage(src);
    const canvas = Object.assign(document.createElement("canvas"), { width: r.w, height: r.h });
    canvas.getContext("2d")!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}
/** The whole snapshot with the boxes drawn on it and numbered, as the agent should see it. */
async function annotatedSnap(snap: Snap, pins: Pin[]): Promise<string | undefined> {
  try {
    const img = await loadImage(snap.image);
    const canvas = Object.assign(document.createElement("canvas"), { width: snap.width, height: snap.height });
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    // The marks the overlay draws on the live page: mint boxes, ink numbers (src/preview-overlay.js).
    for (const p of pins) {
      ctx.strokeStyle = "#2a9b72";
      ctx.lineWidth = 3;
      ctx.strokeRect(p.rect.x + 1.5, p.rect.y + 1.5, Math.max(0, p.rect.w - 3), Math.max(0, p.rect.h - 3));
      const cx = Math.min(snap.width - 14, p.rect.x + p.rect.w);
      const cy = Math.max(14, p.rect.y);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#343932";
      ctx.beginPath();
      ctx.arc(cx, cy, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fbfaf6";
      ctx.font = "600 14px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(p.n), cx, cy + 0.5);
    }
    return canvas.toDataURL("image/png");
  } catch {
    return undefined;
  }
}

/**
 * Snapshot mode: the page as a headless Chrome saw it. Drag to draw a box; each is a pin with its
 * own close-up, in the same tray as the live page's pins, and goes to the agent the same way.
 */
function SnapshotView({ pageKey, state, here, onTake, onLive }: { pageKey: string; state: PageState; here?: string; onTake: (full: boolean) => void; onLive: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // A finger scrolls the snapshot; it draws once Draw is on. A mouse or a pen always draws.
  const [draw, setDraw] = useState(false);
  const touch = typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
  const snap = state.snap;
  /** Where the pointer is on the snapshot, in its own pixels. */
  const at = (e: PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    const k = snap!.width / r.width;
    return { x: Math.max(0, Math.min(snap!.width, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(snap!.height, (e.clientY - r.top) * k)) };
  };
  const box = (d: { x0: number; y0: number; x1: number; y1: number }): Rect => ({
    x: Math.round(Math.min(d.x0, d.x1)),
    y: Math.round(Math.min(d.y0, d.y1)),
    w: Math.round(Math.abs(d.x1 - d.x0)),
    h: Math.round(Math.abs(d.y1 - d.y0)),
  });
  const pct = (r: Rect) => `left:${(r.x / snap!.width) * 100}%;top:${(r.y / snap!.height) * 100}%;width:${(r.w / snap!.width) * 100}%;height:${(r.h / snap!.height) * 100}%`;
  const finish = async () => {
    if (!drag || !snap) return;
    const r = box(drag);
    setDrag(null);
    if (r.w < 6 || r.h < 6) return;
    const image = await cropSnap(snap.image, r);
    setPage(pageKey, (p) =>
      // A new snapshot came while the close-up was made: the box was on the old one.
      p.snap !== snap
        ? p
        : {
            ...p,
            pins: [...p.pins, { n: (p.pins.at(-1)?.n ?? 0) + 1, id: `snap-${Date.now().toString(36)}`, kind: "box", source: "snapshot", selector: "", text: "", rect: r, url: snap.url, viewport: { w: snap.width, h: snap.height }, image, comment: "" }],
          },
    );
  };
  const boxes = state.pins.filter((p) => p.source === "snapshot");
  return (
    <div class="browse-page snap-page">
      <div class="snap-bar">
        <span class="snap-what" title={snap ? `${snap.title}\n${snap.url}` : undefined}>
          {state.snapping ? "Taking a snapshot…" : snap ? `Snapshot · ${snap.width}×${snap.height}${snap.full ? " · whole page" : ""}` : "No snapshot yet"}
        </span>
        <span class="spacer" />
        {touch ? (
          <button type="button" class={`btn ghost small ${draw ? "on" : ""}`} aria-pressed={draw} title="Draw boxes with your finger (off: it scrolls)" onClick={() => setDraw(!draw)}>
            Draw
          </button>
        ) : null}
        <button type="button" class={`btn ghost small ${snap?.full ? "on" : ""}`} aria-pressed={!!snap?.full} disabled={state.snapping} title="Take it again, as tall as the page" onClick={() => onTake(!snap?.full)}>
          Whole page
        </button>
        <button type="button" class="btn ghost small" disabled={state.snapping} title="Take it again, as the page is now" onClick={() => onTake(!!snap?.full)}>
          <Icon name="refresh" /> Retake
        </button>
        <button type="button" class="btn ghost small" onClick={onLive}>
          Live page
        </button>
      </div>
      {state.snapError ? <div class="msg err browse-note">{state.snapError}</div> : null}
      {snap && !state.snapping && !snapOf(snap, here) ? (
        <div class="msg browse-note">
          This snapshot is of {snap.url}, not the page you're on: <b>Retake</b> takes one of this page.
        </div>
      ) : null}
      {snap ? (
        <div class={`snap-scroll ${state.snapping ? "dim" : ""}`}>
          <div class="help snap-hint">{touch && !draw ? "Turn on Draw, then drag on the snapshot to box what's wrong." : "Drag on the snapshot to box what's wrong."}</div>
          <div
            class={`snap-stage ${draw ? "draw" : ""}`}
            ref={stage}
            style={`max-width:${snap.width}px`}
            // A pen draws: the stage stops panning as soon as one comes near it, before its gesture starts.
            onPointerOver={(e) => e.pointerType === "pen" && stage.current && (stage.current.style.touchAction = "none")}
            onPointerLeave={(e) => e.pointerType === "pen" && stage.current && (stage.current.style.touchAction = "")}
            onPointerDown={(e) => {
              if (e.button !== 0 || state.snapping || (e.pointerType === "touch" && !draw)) return;
              e.preventDefault();
              // Keeps the drag going outside the snapshot; a browser that can't capture still draws.
              try {
                stage.current?.setPointerCapture(e.pointerId);
              } catch {
                // nothing to capture
              }
              const p = at(e);
              setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const p = at(e);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }}
            onPointerUp={() => void finish()}
            onPointerCancel={() => setDrag(null)}
          >
            <img src={snap.image} alt={`Snapshot of ${snap.url}`} draggable={false} />
            {boxes.map((p) => (
              <div key={p.n} class="snap-box" style={pct(p.rect)}>
                <span class="snap-n">{p.n}</span>
              </div>
            ))}
            {drag ? <div class="snap-box drawing" style={pct(box(drag))} /> : null}
          </div>
        </div>
      ) : state.snapping ? (
        <div class="side-empty help">Loading the page in a headless Chrome… a few seconds.</div>
      ) : null}
    </div>
  );
}

const LEVEL: Record<ConsoleLine["level"], string> = { error: "Error", warn: "Warn", network: "Net" };

function ConsoleDrawer({ pageKey, lines }: { pageKey: string; lines: ConsoleLine[] }) {
  return (
    <div class="browse-console">
      <div class="bc-head">
        <span class="bc-title">Console</span>
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
              <span class="bc-level">{LEVEL[l.level]}</span>
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

/**
 * Where pins can go from this scope: the run's main chat first, its side chats, a new side chat, a
 * new run. Only places with a message box to take them: a run or chat that failed or stopped has
 * none, and a new side chat needs a worktree to work in (as the Chat tab decides).
 */
export function destinations(s: SideScope): { key: string; label: string; sub: string }[] {
  const out: { key: string; label: string; sub: string }[] = [];
  const open = (r: RunSummary) => r.status === "done" || r.status === "running";
  const run = s.run;
  if (run && open(run)) {
    out.push({ key: `main:${run.id}`, label: "Main chat", sub: run.status === "running" ? "To the team while it works" : "A reply to the agent that built it" });
    for (const c of sideChatsOf(run)) out.push({ key: c.key, label: `Side chat: ${c.title}`, sub: "In this run's worktree" });
    if (resultWorktree(run)) out.push({ key: "side:new", label: "New side chat", sub: "A conversation of its own, in this run's worktree" });
  }
  for (const id of sideMemo.value.chats ?? []) {
    const chat = runs.value.get(id);
    if (chat && open(chat)) out.push({ key: `main:${chat.id}`, label: `Chat: ${chat.task.split("\n")[0]!.slice(0, 40)}`, sub: "A chat on its own branch" });
  }
  out.push({ key: "composer", label: "New run", sub: "The task of a new run, in the composer" });
  return out;
}

/**
 * The pins as a message: what each one points at and what you said, then the snapshots. Pins can
 * be on different pages of the app, so each says where it was when that isn't the first one's.
 * Snapshot names carry the batch: a second lot added to the same message box starts at 1 again.
 */
export function pinsMessage(pins: Pin[], console: ConsoleLine[], batch: string | number, onSnap?: { name: string; snap: Pick<Snap, "url" | "width" | "height" | "full"> }): { text: string; images: Attachment[] } {
  const url = pins[0]?.url ?? "";
  const snapshot = (p: Pin) => `pin-${batch}-${p.n}.png`;
  const lines = pins.map((p) => {
    const what =
      p.source === "snapshot"
        ? `an area ${p.rect.w}×${p.rect.h} at ${p.rect.x},${p.rect.y} on the snapshot${onSnap ? ` (box ${p.n} on ${onSnap.name})` : ""}`
        : p.kind === "box"
          ? `an area ${p.rect.w}×${p.rect.h} at ${p.rect.x},${p.rect.y} (around \`${p.selector}\`)`
          : `\`${p.selector}\``;
    const parts = [`${p.n}. ${what}: ${p.comment.trim() || "(no comment)"}`];
    if (p.url !== url) parts.push(`   On: ${p.url}`);
    if (p.text) parts.push(`   Text: "${p.text.slice(0, 120)}"`);
    if (p.html) parts.push(`   HTML: ${p.html.replace(/\s+/g, " ").slice(0, 240)}`);
    if (p.tried && Object.values(p.tried).some(Boolean)) parts.push(`   Tried in the browser: ${Object.entries(p.tried).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
    if (p.image) parts.push(`   Snapshot: ${snapshot(p)}`);
    return parts.join("\n");
  });
  const errors = console.filter((c) => c.level !== "warn").slice(-20);
  const head =
    onSnap && pins.every((p) => p.source === "snapshot")
      ? `From a snapshot of ${onSnap.snap.url} (${onSnap.snap.width}px wide${onSnap.snap.full ? ", the whole page" : ""}, as a signed-out visitor sees it); the boxes are numbered on ${onSnap.name}:`
      : url
        ? `From the app in the browser (${url}${pins[0] ? `, ${pins[0].viewport.w}px wide` : ""}):`
        : "From the app in the browser:";
  const text = [head, ...lines, errors.length ? `Console errors and failed requests:\n${errors.map((e) => `- ${e.text.split("\n")[0]!.slice(0, 300)}`).join("\n")}` : ""].filter(Boolean).join("\n");
  const images = pins
    .filter((p) => p.image)
    .map((p) => {
      const data = p.image!.replace(/^data:image\/png;base64,/, "");
      return { name: snapshot(p), size: Math.round((data.length * 3) / 4), data };
    });
  return { text, images };
}
/** A name for one lot of pins, so its snapshots' names don't repeat, whichever window (a popped-out panel) sent it. */
const batchName = () => Date.now().toString(36).slice(-6);

function PinsTray({ scope, pageKey, state, onSent }: { scope: SideScope; pageKey: string; state: PageState; onSent: () => void }) {
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [withConsole, setWithConsole] = useState(false);
  const errors = state.console.filter((c) => c.level !== "warn");
  const options = destinations(scope);
  const remembered = options.find((o) => o.key === sideMemo.value.sendTo);
  const primary = remembered ?? options[0]!;
  const update = (n: number, patch: Partial<Pin>) => setPage(pageKey, (p) => ({ ...p, pins: p.pins.map((x) => (x.n === n ? { ...x, ...patch } : x)) }));
  // A pin from an earlier load of the page has nothing to put back: its element went with that page.
  const remove = (pin: Pin) => {
    if (!pin.gone) overlays.get(pageKey)?.({ type: "reset", id: pin.id });
    setPage(pageKey, (p) => ({ ...p, pins: p.pins.filter((x) => x.n !== pin.n) }));
  };
  const sendTo = async (to: string) => {
    const batch = batchName();
    const boxes = state.pins.filter((p) => p.source === "snapshot");
    // Boxes drawn on a snapshot go with the whole snapshot, numbered, so the agent sees where each one is.
    const whole = boxes.length && state.snap ? await annotatedSnap(state.snap, boxes) : undefined;
    const onSnap = whole && state.snap ? { name: `snapshot-${batch}.png`, snap: state.snap } : undefined;
    const message = pinsMessage(state.pins, withConsole ? errors : [], batch, onSnap);
    const text = message.text;
    const images = whole && onSnap ? [{ name: onSnap.name, size: Math.round((whole.length * 3) / 4), data: whole.replace(/^data:image\/png;base64,/, "") }, ...message.images] : message.images;
    const draft = { to, text, images };
    rememberSide({ sendTo: to });
    for (const p of state.pins) if (!p.gone) overlays.get(pageKey)?.({ type: "reset", id: p.id });
    setPage(pageKey, (p) => ({ ...p, pins: [] }));
    onSent();
    // The run's page and the composer are the main window's: a popped-out panel hands the draft over with them.
    const there = poppedScope.value ? " in the main window" : "";
    if (to.startsWith("main:")) {
      const id = to.slice(5);
      if (scope.run?.id === id) navigate({ view: "run", id }, [draft]);
      else {
        draftTo(to, text, images);
        setSideChat(id);
        openSide("chat");
      }
      showToast(`Added to the message box${scope.run?.id === id ? there : ""}: add a line if you like, then send`);
    } else if (to.startsWith("side:")) {
      draftTo(to, text, images);
      setSideChat(to === "side:new" ? null : to);
      openSide("chat");
    } else {
      navigate({ view: "composer" }, [draft]);
      showToast(`Added to the task in the composer${there}`);
    }
  };
  return (
    <div class="pins-tray">
      {/* The pins scroll; the send row stays put below them, so its menu can open upward over the page. */}
      <div class="pins-list">
        {state.pins.map((p) => (
          <div key={p.n} class="pin-row">
            <span class="pin-n">{p.n}</span>
            <div class="pin-main">
              <div class="pin-what" title={p.html ?? p.selector}>
                {p.kind === "box" ? <span class="pin-label">Area {p.rect.w}×{p.rect.h}</span> : <span class="pin-label pin-sel">{p.selector}</span>}
                {p.image ? <img class="pin-thumb" src={p.image} alt={`Snapshot of pin ${p.n}`} /> : <span class="help"> · no snapshot</span>}
              </div>
              <input class="field" aria-label={`What about pin ${p.n}?`} placeholder="What's wrong, or what should change?" value={p.comment} onInput={(e) => update(p.n, { comment: e.currentTarget.value })} />
              {adjusting === p.n && p.kind === "element" && !p.gone ? (
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
                <button
                  type="button"
                  class={`btn ghost small ${adjusting === p.n && !p.gone ? "on" : ""}`}
                  disabled={p.gone}
                  title={p.gone ? "The page has loaded again since you picked this, so its element is gone" : "Try style changes on the page; what you try goes with the pin"}
                  onClick={() => setAdjusting(adjusting === p.n ? null : p.n)}
                >
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
      </div>
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
                    void sendTo(o.key);
                  }}
                >
                  {o.label}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <button type="button" class="btn primary small" disabled={!state.pins.length} onClick={() => void sendTo(primary.key)}>
          Add to {primary.key.startsWith("main:") && primary.label === "Main chat" ? "main chat" : primary.key === "composer" ? "a new run" : primary.label.toLowerCase().startsWith("side chat") ? "side chat" : primary.label}
        </button>
      </div>
    </div>
  );
}
