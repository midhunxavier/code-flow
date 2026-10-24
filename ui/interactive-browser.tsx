import { BrowserTransfers, type BrowserChooser, type BrowserDownload } from "./browser-transfers.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiPath, post, usePoll } from "./lib.js";
import { Icon } from "./icons.js";
import type { DevServer } from "./types.js";
import { LiveBrowserTools, LiveBrowserTray, receiveBrowserOverlay } from "./browser.js";
import { Strip } from "./panel-bits.js";
import { rememberSide, sideMemo, sideOpen, sideScope, sideTab } from "./state.js";

type Tab = {id:string;url:string;title:string};
type State = {type:"state";tabs:Tab[];selected?:string;width:number;height:number;view:number;chooser?:BrowserChooser;downloads?:BrowserDownload[];dialog?:{type:string;message:string;defaultPrompt:string}};
type Frame = {type:"frame";data:string;width:number;height:number;tab:string;view:number};
const modifiers = (event:KeyboardEvent | MouseEvent) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

export function BrowserTab() { return <InteractiveBrowser key={sideScope.value.key} />; }

/** A live Chrome viewport. Frames, input and agent tools all belong to the same task session. */
export function InteractiveBrowser() {
  const scope = sideScope.value.key;
  const endpoint = `/api/browser?scope=${encodeURIComponent(scope)}`;
  const visible = sideOpen.value && sideTab.value === "browser";
  const [control,setControl] = useState<{owner?:string;user:boolean;waiting:number}>({user:false,waiting:0});
  const [controlBusy,setControlBusy] = useState(false);
  const changeControl = async (action: "takeover" | "release") => { setControlBusy(true); try { setControl(await post(`/api/browser/control?scope=${encodeURIComponent(scope)}`, {action})); } catch (error) { setError((error as Error).message); } finally { setControlBusy(false); } };
  const [state,setState] = useState<State>();
  const [servers,setServers] = useState<Omit<DevServer,"logs">[]>([]);
  const autoOff = useRef(false);
  usePoll(current=>api<Omit<DevServer,"logs">[]>("/api/serve").then(value=>current()&&setServers(value),()=>{}),5000,[],visible);
  const [frame,setFrame] = useState<Frame>();
  const [drawn,setDrawn] = useState<{tab:string;view:number}>();
  const [connected,setConnected] = useState(false);
  const [error,setError] = useState("");
  const [address,setAddress] = useState("");
  const [prompt,setPrompt] = useState("");
  const [device,setDevice] = useState("full");
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const hoverAt = useRef(0);
  const addressEditing = useRef(false);
  const displayed = useRef<Frame>();
  const pending = useRef<Promise<any>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const send = (input:Record<string,unknown>) => {
    const work = pending.current.catch(() => {}).then(async () => {
      if (!mounted.current) return;
      try { const result = await post<any>(endpoint,input); if (mounted.current) setError(""); return result; }
      catch (error) { if (mounted.current) setError((error as Error).message); throw error; }
    });
    pending.current = work.catch(() => {}); return work;
  };
  const act = (action:string, extra:Record<string,unknown> = {}) => {
    const shown = action === "dialog" && state?.selected ? {tab:state.selected,view:state.view} : displayed.current;
    if (!shown) return;
    void send({action,tab:shown.tab,view:shown.view,...extra}).catch(() => {});
  };
  useEffect(() => {
    if (!visible) return;
    const events = new EventSource(apiPath(`/api/browser/events?scope=${encodeURIComponent(scope)}`));
    events.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.type === "control") setControl(value);
      else if (value.type === "state") {
        setState(value); setConnected(true);
        if (value.selected !== displayed.current?.tab) { setFrame(previous=>previous?.tab===value.selected?previous:undefined); displayed.current = undefined; setDrawn(undefined); }
      } else if (value.type === "frame") { setFrame(value); setConnected(true); }
      else if (value.type === "overlay") receiveBrowserOverlay(`${scope}|${value.tab}`,value.message);
      else if (value.type === "error") setError(value.message);
      else if (value.type === "closed") { events.close(); setConnected(false); setError("The browser session ended. Reopen the Browser panel to reconnect."); }
    };
    events.onerror = () => setConnected(false);
    return () => { events.close(); setConnected(false); };
  }, [visible,scope]);
  const selected = state?.tabs.find(tab => tab.id === state.selected);
  useEffect(() => {
    if (!addressEditing.current) setAddress(selected?.url === "about:blank" ? "" : selected?.url ?? "");
    if (selected?.url && selected.url !== "about:blank") rememberSide({url:selected.url},scope);
  }, [selected?.url,selected?.id]);
  useEffect(() => { setPrompt(state?.dialog?.defaultPrompt ?? ""); }, [state?.dialog?.message]);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive || !canvas.current) return;
      canvas.current.width = image.width; canvas.current.height = image.height;
      canvas.current.getContext("2d")!.drawImage(image,0,0);
      canvas.current.dataset.frames = String(Number(canvas.current.dataset.frames ?? 0) + 1);
      displayed.current = frame; setDrawn({tab:frame.tab,view:frame.view});
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
    return () => { alive = false; };
  }, [frame]);
  useEffect(() => {
    if (!visible || !surface.current || !state?.selected) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const box = surface.current?.getBoundingClientRect(); if (!box?.width || !box.height) return;
        void send({action:"resize",width:Math.min(2560,Math.max(240,device === "phone" ? 390 : device === "tablet" ? 768 : Math.round(box.width))),height:Math.min(1600,Math.max(200,Math.round(box.height)))}).catch(() => {});
      },100);
    };
    const observer = new ResizeObserver(resize); observer.observe(surface.current); resize();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [visible,state?.selected,device]);
  const navigate = (url:string) => { autoOff.current=true; void send({action:"navigate",url:/^https?:\/\//i.test(url) ? url : /^(localhost|127\.|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`}).catch(() => {}); };
  const opened = useRef("");
  const restored = useRef(false);
  const memo = sideMemo.value;
  useEffect(() => {
    if (!state?.selected) return;
    const request = memo.browserRequest;
    const saved = memo.pages?.find(page => page.id === memo.page)?.url ?? memo.url ?? memo.pages?.[0]?.url;
    const id = request && request.id !== memo.browserHandled ? request.id : !restored.current && selected?.url === "about:blank" && saved ? "restore" : "";
    restored.current = true;
    const url = id === "restore" ? saved : request?.url;
    if (!id || !url || opened.current === id) return;
    opened.current = id;
    const existing = state.tabs.find(tab => tab.url === url);
    void send(existing ? {action:"tabs",operation:"select",tab:existing.id} : {action:"navigate",url}).then(() => {
      if (request?.id === id) rememberSide({browserHandled:id},scope);
    }, () => { opened.current = ""; });
  }, [state?.selected,memo.browserRequest?.id,selected?.url]);
  useEffect(()=>{
    if(autoOff.current || !state?.selected || selected?.url !== "about:blank" || memo.url || memo.browserRequest) return;
    const folders=sideScope.value.run?.worktrees.map(tree=>tree.path) ?? [sideScope.value.repo];
    const own=servers.find(server=>server.status==="running" && folders.some(folder=>folder && (server.cwd===folder || server.cwd.startsWith(`${folder}/`))));
    if(own){autoOff.current=true;void send({action:"navigate",url:own.url}).catch(()=>{});}
  },[state?.selected,selected?.url,servers]);
  const pointer = (event:PointerEvent | WheelEvent, type:string) => {
    const shown = displayed.current, box = canvas.current?.getBoundingClientRect();
    if (!shown || !box) return;
    const scale = Math.min(box.width / shown.width,box.height / shown.height);
    const x = (event.clientX - box.x - (box.width - shown.width * scale) / 2) / scale;
    const y = (event.clientY - box.y - (box.height - shown.height * scale) / 2) / scale;
    if (x < 0 || y < 0 || x > shown.width || y > shown.height) return;
    const wheel = event instanceof WheelEvent;
    act("mouse",{type,x,y,button:wheel || type === "mouseMoved" && !event.buttons ? "none" : event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",buttons:wheel ? 0 : event.buttons,clickCount:Math.max(1,Math.min(3,event.detail || 1)),modifiers:modifiers(event),...(wheel ? {deltaX:Math.round(Math.max(-10000,Math.min(10000,event.deltaX))),deltaY:Math.round(Math.max(-10000,Math.min(10000,event.deltaY)))} : {})});
  };
  const key = (event:KeyboardEvent) => {
    if (event.isComposing || ["Shift","Control","Meta","Alt"].includes(event.key)) return;
    if ((event.metaKey || event.ctrlKey) && ["l","r"].includes(event.key.toLowerCase())) {
      event.preventDefault(); if (event.key.toLowerCase() === "l") { addressInput.current?.focus(); addressInput.current?.select(); } else act("reload"); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();event.stopPropagation();const shown=displayed.current;
      if(shown) void send({action:"selection",tab:shown.tab,view:shown.view}).then(value=>navigator.clipboard.writeText(value.text)).catch(error=>setError(error.message));
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return; // text/IME goes through input
    event.preventDefault();
    act("key",{key:event.key,code:event.code,keyCode:event.keyCode,modifiers:modifiers(event)});
    if (event.key === "Escape") keyboard.current?.blur(); else event.stopPropagation();
  };
  return <div class="interactive-browser">
    <Strip label="Open pages" active={state?.selected} items={(state?.tabs ?? []).map(tab => ({key:tab.id,label:tab.url === "about:blank" ? "New tab" : tab.title || tab.url,title:tab.url}))} onPick={tab => void send({action:"tabs",operation:"select",tab}).catch(() => {})} onClose={tab => void send({action:"tabs",operation:"close",tab}).catch(() => {})}>
      <button class="icon-btn" aria-label="New browser tab" title="New browser tab" onClick={() => {autoOff.current=true;void send({action:"tabs",operation:"new"}).catch(() => {});}}><Icon name="plus" /></button>
    </Strip>
    <form class="live-browser-address" onSubmit={event => { event.preventDefault(); addressEditing.current=false; if (address.trim()) navigate(address.trim()); }}>
      <button type="button" class="icon-btn" aria-label="Back" onClick={() => act("back")}><span aria-hidden="true">←</span></button>
      <button type="button" class="icon-btn" aria-label="Forward" onClick={() => act("forward")}><span aria-hidden="true">→</span></button>
      <button type="button" class="icon-btn" aria-label="Reload" onClick={() => act("reload")}><Icon name="refresh" /></button>
      <input ref={addressInput} class="field" aria-label="Address" placeholder="Enter a website address" value={address} onInput={event => {addressEditing.current=true;setAddress(event.currentTarget.value);}} />
      <button class="btn small" type="submit">Go</button>
    </form>
    <div class="live-browser-toolbar"><span class="help" role="status">{connected ? control.user ? "You have control" : control.owner ? `${control.owner} is using the browser` : "Live browser · shared with agents" : "Connecting to Chrome…"}{control.waiting ? ` · ${control.waiting} waiting` : ""}</span><button type="button" class="btn small" disabled={controlBusy} onClick={() => void changeControl(control.user ? "release" : "takeover")}>{controlBusy ? "Handing over…" : control.user ? "Let agents continue" : "Take control"}</button><select class="field" aria-label="Browser viewport" value={device} onChange={event => setDevice(event.currentTarget.value)}><option value="full">Fit panel</option><option value="tablet">Tablet</option><option value="phone">Phone</option></select></div>
    <BrowserTransfers scope={scope} chooser={state?.chooser} downloads={state?.downloads??[]} send={send} />
    {error ? <div class="msg err" role="alert">{error}</div> : null}
    {selected && /^https?:\/\//.test(selected.url) ? <LiveBrowserTools key={selected.id} pageKey={`${scope}|${selected.id}`} url={selected.url} width={state!.width} send={message=>send({action:"overlay",tab:selected.id,message})} />:null}
    <div class="live-browser-surface" ref={surface}>
      {state?.dialog ? <form class="live-browser-dialog" aria-label="Website dialog" onSubmit={event => {event.preventDefault();act("dialog",{accept:true,text:prompt});}}><p>{state.dialog.message}</p>{state.dialog.type === "prompt" ? <input class="field" aria-label="Website prompt" value={prompt} onInput={event => setPrompt(event.currentTarget.value)} /> : null}<button class="btn primary">OK</button><button type="button" class="btn" onClick={() => act("dialog",{accept:false})}>Cancel</button></form> : null}
      <canvas ref={canvas} hidden={!frame} role="img" aria-label="Live browser page" data-tab={drawn?.tab} data-view={drawn?.view} data-frame-width={frame?.width} data-frame-height={frame?.height} data-ready={connected && drawn?.view === state?.view && drawn?.tab === state?.selected} onContextMenu={event => event.preventDefault()} onPointerDown={event => {event.preventDefault();keyboard.current?.focus({preventScroll:true}); event.currentTarget.setPointerCapture(event.pointerId);pointer(event,"mousePressed");}} onPointerUp={event => {pointer(event,"mouseReleased");if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerMove={event => {if(event.buttons || performance.now()-hoverAt.current>80) {hoverAt.current=performance.now();pointer(event,"mouseMoved");}}} onWheel={event => {event.preventDefault();pointer(event,"mouseWheel");}} />
      <textarea ref={keyboard} class="live-browser-keyboard" aria-label="Type in browser page" autoComplete="off" autoCapitalize="off" spellcheck={false} onKeyDown={key} onInput={event => {if ((event as InputEvent).isComposing) return;const text=event.currentTarget.value; event.currentTarget.value="";if(text) act("text",{text});}} onCompositionEnd={event => {const text=event.currentTarget.value;event.currentTarget.value="";if(text) act("text",{text});}} onPaste={event => {event.preventDefault();const text=event.clipboardData?.getData("text/plain");if(text) act("text",{text});}} />
      {!frame ? <div class="live-browser-empty">{connected ? "Open a website to start browsing" : "Starting your browser…"}</div> : null}
    </div>
    {selected ? <LiveBrowserTray pageKey={`${scope}|${selected.id}`} />:null}
  </div>;
}
