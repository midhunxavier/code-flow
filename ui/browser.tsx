import { browserContextMessage } from "./browser-context.js";
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
  mode?: "off" | "pick" | "box";
  consoleDropped?: number;
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
  else if (m.type === "mode" && ["off","pick","box"].includes(m.mode)) setPage(pageKey,p=>({...p,mode:m.mode}));
  else if (m.type === "console-history") setPage(pageKey,p=>({...p,console:m.lines,consoleDropped:m.dropped}));
  else if (m.type === "record-action") recordAction(pageKey,m.action);
  else if (m.type === "recording-warning" && recording.value?.page === pageKey) recording.value={...recording.value,warning:String(m.text).slice(0,200)};
  else if (m.type === "console") setPage(pageKey,p=>({...p,consoleDropped:(p.consoleDropped??0)+(p.console.length>=300?1:0),console:[...p.console.slice(-299),{level:m.level,text:String(m.text).slice(0,2000),at:m.at}]}));
  else if (m.type === "pin-start") setPage(pageKey,p=>({...p,capturing:p.capturing+1}));
  else if (m.type === "pin") setPage(pageKey,p=>({...p,capturing:Math.max(0,p.capturing-1),pins:[...p.pins,{...m.pin,n:(p.pins.at(-1)?.n ?? 0)+1,comment:""}]}));
}
export function LiveBrowserTools({pageKey,url,width,send,clearConsole,visible}: {pageKey:string;url:string;width:number;visible:boolean;clearConsole:()=>Promise<unknown>;send:(message:Record<string,unknown>)=>Promise<unknown>}) {
  const state=pageState(pageKey), mode=state.mode??"off";
  const setMode=(mode:"off"|"pick"|"box")=>setPage(pageKey,p=>({...p,mode}));
  const [showConsole,setShowConsole]=useState(false);
  // Enqueue mode changes in the click handler, before a fast click on the live page.
  const changeMode = (next: "off" | "pick" | "box") => { setMode(next); void send({type:"mode",mode:next}).catch(()=>{}); };
  const errors=state.console.filter(line=>line.level!=="warn").length;
  const sendRef=useRef(send);sendRef.current=send;
  useEffect(()=>{
    const command=(message:Record<string,unknown>)=>{void sendRef.current(message).catch(()=>{});};
    overlays.set(pageKey,command); command({type:"hello"});
    return()=>{if(overlays.get(pageKey)===command)overlays.delete(pageKey);};
  },[pageKey]);
  useEffect(()=>{if(!visible) setMode("off");},[visible]);
  useEffect(()=>{if(state.ready){void send({type:"mode",mode:visible?mode:"off"}).catch(()=>{});void send({type:"recording",active:visible && recording.value?.page===pageKey && recording.value.active}).catch(()=>{});}},[mode,state.ready,state.document,recording.value?.page,recording.value?.active,visible]);
  useEffect(()=>{void send({type:"pins",pins:livePins(state.pins)}).catch(()=>{});},[state.pins]);
  const s=sideScope.value;
  return <>
    <div class="browse-tools live-annotation-tools"><button class="btn ghost small" aria-pressed={mode==="pick"} disabled={!state.ready} onClick={()=>changeMode(mode==="pick"?"off":"pick")}>Pick</button><button class="btn ghost small" aria-pressed={mode==="box"} disabled={!state.ready} onClick={()=>changeMode(mode==="box"?"off":"box")}>Box</button><button class="btn ghost small" aria-pressed={showConsole} onClick={()=>setShowConsole(!showConsole)}>Console{errors?` · ${errors}${state.consoleDropped?"+":""}`:""}</button></div>
    <JourneyRecorder key={pageKey} pageKey={pageKey} url={url} repository={s.repo} width={width} ready={state.ready===true} toggle={active=>{setMode("off");return send({type:"recording",active});}} />
    {showConsole ? <ConsoleDrawer lines={state.console} dropped={state.consoleDropped??0} clear={clearConsole} />:null}
  </>;
}
export function LiveBrowserTray({pageKey}: {pageKey:string}) {
  const state=pageState(pageKey);
  return state.pins.length || state.capturing ? <PinsTray scope={sideScope.value} pageKey={pageKey} state={state} onSent={()=>{setPage(pageKey,p=>({...p,mode:"off"}));overlays.get(pageKey)?.({type:"mode",mode:"off"});}} />:null;
}

/** Pins on the live page. Historical snapshot messages remain readable in browser-context.ts. */
const livePins = (pins: Pin[]) => pins.map(p => ({n:p.n,rect:p.rect,kind:p.kind}));
export const CONSOLE_ATTACHMENT_LIMIT = 20;
export function consoleAttachmentLabel(count:number, dropped=0) {
  return count > CONSOLE_ATTACHMENT_LIMIT || dropped ? `with last ${Math.min(count,CONSOLE_ATTACHMENT_LIMIT)} of ${count}${dropped?"+":""} console errors` : `with ${count} console error${count===1?"":"s"}`;
}

const LEVEL: Record<ConsoleLine["level"], string> = { error: "Error", warn: "Warn", network: "Net" };

function ConsoleDrawer({ lines, dropped, clear }: { lines: ConsoleLine[]; dropped: number; clear:()=>Promise<unknown> }) {
  return (
    <div class="browse-console">
      <div class="bc-head">
        <span class="bc-title">Console</span>
        <span class="help">{dropped ? `Latest ${lines.length} entries; ${dropped} older entries omitted` : "Errors, warnings and failed requests since navigation or Clear"}</span>
        <span class="spacer" />
        <button type="button" class="btn ghost small" disabled={!lines.length} onClick={() => void clear().catch(()=>{})}>
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
export function pinsMessage(pins: Pin[], console: ConsoleLine[], batch: string | number, dropped = 0): { text: string; images: Attachment[] } {
  const snapshot = (p: Pin) => `pin-${batch}-${p.n}.png`;
  const retainedErrors = console.filter(c => c.level !== "warn");
  const omitted = retainedErrors.length - Math.min(retainedErrors.length,CONSOLE_ATTACHMENT_LIMIT) + dropped;
  const errors = retainedErrors.slice(-CONSOLE_ATTACHMENT_LIMIT).map(e => e.text.split("\n")[0]!.slice(0, 300));
  const text = pins.map((p, index) => browserContextMessage({
    version: 1, comment: p.comment.trim(), url: p.url, selector: p.selector,
    text: p.text.slice(0, 120), html: p.html?.replace(/\s+/g, " ").slice(0, 240),
    viewport: p.viewport, rect: p.rect, tried: p.tried,
    snapshot: p.image ? snapshot(p) : undefined,
    selection: p.n,
    console: index === 0 && errors.length ? errors : undefined,
    consoleOmitted: index === 0 && omitted ? omitted : undefined,
  })).join("\n\n");
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
    const message = pinsMessage(state.pins, withConsole ? errors : [], batch, withConsole ? state.consoleDropped : 0);
    const {text,images} = message;
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
      showToast(`Added to chat${scope.run?.id === id ? there : ""}. Add a message, then send.`);
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
                {p.kind === "box" ? <span class="pin-label">Area {p.rect.w}×{p.rect.h}</span> : <span class="pin-label pin-sel">{p.text || "Selected element"}</span>}
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
            <input type="checkbox" checked={withConsole} onChange={(e) => setWithConsole(e.currentTarget.checked)} /> {consoleAttachmentLabel(errors.length,state.consoleDropped)}
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
          Add to {primary.key.startsWith("main:") && primary.label === "Main chat" ? "chat" : primary.key === "composer" ? "a new run" : primary.label.toLowerCase().startsWith("side chat") ? "side chat" : primary.label}
        </button>
      </div>
    </div>
  );
}
