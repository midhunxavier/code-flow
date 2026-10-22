import { JourneyRecorder, recording, recordAction } from "./journeys.js";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { onPhone, showToast } from "./lib.js";
import { Menu, MenuItem, MenuTitle, resultWorktree } from "./panel-bits.js";
import { sideChatsOf } from "./side-chat.js";
import { draftTo, navigate, openSide, poppedScope, rememberSide, runs, setSideChat, sideMemo, sideScope, type SideScope } from "./state.js";
import type { Attachment, RunSummary } from "./types.js";

/** Shared live-browser annotations, console observations and chat attachments. */

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
  ready?: boolean;
  document?: string;
  snap?: Snap;
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
/**
 * The app's own address for one reported from the frame, which is on the preview's origin. The
 * page's own scripts can post these messages too, so anything else (another site, a javascript:
 * URL) is ignored: it would end up in the address bar and the "Open in a new tab" link.
 */
export function appAddress(reported: unknown, preview: string, app: string): string | undefined {
  if (typeof reported !== "string" || (reported !== preview && !reported.startsWith(`${preview}/`))) return undefined;
  return app + reported.slice(preview.length);
}


/** Annotation tools use the same Chrome page as human input and provider tools. */
export function receiveBrowserOverlay(pageKey: string, m: any) {
  if (m.type === "ready") setPage(pageKey, p => ({...p,ready:true,document:m.document,capturing:0,pins:p.document===m.document?p.pins:p.pins.map(pin=>({...pin,gone:true}))}));
  else if (m.type === "record-action") recordAction(pageKey,m.action);
  else if (m.type === "recording-warning" && recording.value?.page === pageKey) recording.value={...recording.value,warning:String(m.text).slice(0,200)};
  else if (m.type === "console") setPage(pageKey,p=>({...p,console:[...p.console.slice(-299),{level:m.level,text:String(m.text).slice(0,2000),at:m.at}]}));
  else if (m.type === "pin-start") setPage(pageKey,p=>({...p,capturing:p.capturing+1}));
  else if (m.type === "pin") setPage(pageKey,p=>({...p,capturing:Math.max(0,p.capturing-1),pins:[...p.pins,{...m.pin,n:(p.pins.at(-1)?.n ?? 0)+1,comment:""}]}));
}
export function LiveBrowserTools({pageKey,url,width,send}: {pageKey:string;url:string;width:number;send:(message:Record<string,unknown>)=>Promise<unknown>}) {
  const [mode,setMode]=useState<"off"|"pick"|"box">("off");
  const [showConsole,setShowConsole]=useState(false);
  const state=pageState(pageKey), errors=state.console.filter(line=>line.level!=="warn").length;
  const sendRef=useRef(send);sendRef.current=send;
  useEffect(()=>{
    const command=(message:Record<string,unknown>)=>{void sendRef.current(message).catch(()=>{});};
    overlays.set(pageKey,command); command({type:"hello"});
    return()=>{command({type:"mode",mode:"off"});command({type:"recording",active:false});if(overlays.get(pageKey)===command)overlays.delete(pageKey);};
  },[pageKey]);
  useEffect(()=>{if(state.ready){void send({type:"mode",mode}).catch(()=>{});void send({type:"recording",active:recording.value?.page===pageKey && recording.value.active}).catch(()=>{});}},[mode,state.ready,recording.value?.active]);
  useEffect(()=>{void send({type:"pins",pins:livePins(state.pins)}).catch(()=>{});},[state.pins]);
  const s=sideScope.value;
  return <>
    <div class="browse-tools live-annotation-tools"><button class="btn ghost small" aria-pressed={mode==="pick"} disabled={!state.ready} onClick={()=>setMode(mode==="pick"?"off":"pick")}>Pick</button><button class="btn ghost small" aria-pressed={mode==="box"} disabled={!state.ready} onClick={()=>setMode(mode==="box"?"off":"box")}>Box</button><button class="btn ghost small" aria-pressed={showConsole} onClick={()=>setShowConsole(!showConsole)}>Console{errors?` · ${errors}`:""}</button></div>
    <JourneyRecorder key={pageKey} pageKey={pageKey} url={url} repository={s.repo} width={width} ready={state.ready===true} toggle={active=>{setMode("off");return send({type:"recording",active});}} />
    {showConsole ? <ConsoleDrawer pageKey={pageKey} lines={state.console} />:null}
  </>;
}
export function LiveBrowserTray({pageKey}: {pageKey:string}) {
  const state=pageState(pageKey);
  return state.pins.length || state.capturing ? <PinsTray scope={sideScope.value} pageKey={pageKey} state={state} onSent={()=>overlays.get(pageKey)?.({type:"mode",mode:"off"})} />:null;
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
