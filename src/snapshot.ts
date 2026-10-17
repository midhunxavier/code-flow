import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { killGroup, trackGroup, untrackGroup } from "./adapters/process.js";
import { childEnv } from "./env.js";

/**
 * Snapshot mode for the side panel's Browser: a screenshot of any web page, to draw boxes on and
 * send to an agent, for sites the preview can't annotate (anything that isn't on this computer).
 *
 * The page is loaded in a headless Chrome (or Chromium, Edge or Brave) with a fresh, empty profile, so
 * it's what a signed-out visitor sees, at the width you pick. code-flow drives it over Chrome's
 * DevTools pipe (--remote-debugging-pipe): no extra packages, no debugging port anyone else could
 * reach. One snapshot at a time; each Chrome is gone when its snapshot is done.
 */

export interface Snapshot {
  /** PNG, base64. */
  image: string;
  width: number;
  height: number;
  /** Where the page ended up (after redirects), and its title. */
  url: string;
  title: string;
}

export interface SnapshotRequest {
  url: string;
  /** Viewport width in CSS pixels. */
  width: number;
  /** Viewport height; a full-page snapshot is as tall as the page (up to MAX_HEIGHT). */
  height?: number;
  full?: boolean;
}

/** Something about the request or this computer, with the HTTP status that says it. */
export class SnapshotError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const MIN_WIDTH = 240;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 12_000;
const LOAD_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 45_000;
/** After the load event: web fonts, late layout and the first animation frames. */
const SETTLE_MS = 700;

/** Where each platform keeps Chrome, Chromium, Edge and Brave: full paths, or names to look for on PATH. */
function chromes(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform === "win32") {
    // Machine-wide and per-user installs; a folder whose variable isn't set is skipped.
    const at = (variable: string, path: string) => (env[variable] ? `${env[variable]}\\${path}` : "");
    return [
      at("ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"),
      at("ProgramFiles(x86)", "Google\\Chrome\\Application\\chrome.exe"),
      at("LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"),
      at("LOCALAPPDATA", "Chromium\\Application\\chrome.exe"),
      at("ProgramFiles(x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      at("ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"),
      at("ProgramFiles", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      at("LOCALAPPDATA", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    ].filter(Boolean);
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The browser snapshots use: CODEFLOW_CHROME, else the first Chrome-like browser installed. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | undefined {
  // A folder (the .app bundle, say) exists but can't be run.
  if (env.CODEFLOW_CHROME) return isFile(env.CODEFLOW_CHROME) ? env.CODEFLOW_CHROME : undefined;
  for (const candidate of chromes(env, platform)) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (isFile(candidate)) return candidate;
      continue;
    }
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      if (isFile(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return undefined;
}

/** An http(s) address to snapshot, as given, or a SnapshotError saying why not. */
export function snapshotUrl(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SnapshotError("That isn't a web address", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SnapshotError("Snapshots are of http and https pages", 400);
  return url.href;
}

/** One at a time: each snapshot is a whole Chrome. */
let queue: Promise<unknown> = Promise.resolve();

export async function takeSnapshot(request: SnapshotRequest): Promise<Snapshot> {
  const url = snapshotUrl(request.url);
  const width = Math.round(request.width);
  if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) throw new SnapshotError(`The width must be between ${MIN_WIDTH} and ${MAX_WIDTH} pixels`, 400);
  if (request.height !== undefined && !Number.isFinite(request.height)) throw new SnapshotError("The height must be a number of pixels", 400);
  const height = Math.round(Math.min(Math.max(request.height ?? Math.round((width * 10) / 16), 240), 4000));
  const chrome = findChrome();
  if (!chrome) throw new SnapshotError("Snapshots need Google Chrome, Chromium, Edge or Brave on this computer: install one, or set CODEFLOW_CHROME to its path", 501);
  const next = queue.then(() => capture(chrome, url, width, height, !!request.full));
  queue = next.catch(() => undefined);
  return next;
}

async function capture(chrome: string, url: string, width: number, height: number, full: boolean): Promise<Snapshot> {
  const profile = await mkdtemp(join(tmpdir(), "codeflow-snapshot-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--mute-audio",
      "--hide-scrollbars",
      // Lighter: no GPU process, one renderer for the page, none of the background features.
      "--disable-gpu",
      "--renderer-process-limit=1",
      "--disable-site-isolation-trials",
      "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    // fd 3 is what Chrome reads commands from, fd 4 where it answers.
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true, env: childEnv() },
  );
  trackGroup(child.pid);
  let stderr = "";
  child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2_000)));
  const cdp = new DevTools(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const gone = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve()); // it never started: there's no exit to wait for
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new SnapshotError(`Chrome stopped before the snapshot was taken (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`, 502)));
    child.once("error", (err: NodeJS.ErrnoException) => reject(new SnapshotError(`Couldn't start ${chrome}: ${err.code ?? err.message}`, 502)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SnapshotError(`The page took longer than ${TOTAL_TIMEOUT_MS / 1000}s to snapshot`, 504)), TOTAL_TIMEOUT_MS);
  });
  const driven = drive(cdp, url, width, height, full).catch(async (err: unknown) => {
    if (err instanceof SnapshotError) throw err;
    // The pipe closing can beat Chrome's exit to it: give the exit a moment to say why (it wins the race below).
    await within(exited, 500);
    throw new SnapshotError(`Chrome couldn't take the snapshot: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  try {
    return await Promise.race([driven, exited, timeout]);
  } finally {
    clearTimeout(timer);
    // A Chrome that's gone answers nothing (send fails once its pipe closes); one that's stuck gets 2s.
    await within(cdp.send("Browser.close"), 2_000);
    cdp.dispose();
    killGroup(child.pid, 1_000);
    untrackGroup(child.pid);
    // Chrome and its helpers (the crash handler, say) write the profile as they shut down: removing the
    // folder before they're all gone leaves one behind.
    await within(gone, 2_000);
    await groupGone(child.pid, 2_000);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

/** Until every process in Chrome's group has exited, or `ms` at most. */
async function groupGone(pid: number | undefined, ms: number) {
  if (!pid || process.platform === "win32") return;
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Until `promise` settles, or `ms` at most; no timer is left behind either way. */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise.catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

async function drive(cdp: DevTools, url: string, width: number, height: number, full: boolean): Promise<Snapshot> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
  // An alert() or confirm() holds the page until someone answers it: answer OK, as a visitor would.
  cdp.on((msg) => {
    if (msg.method === "Page.javascriptDialogOpening" && msg.sessionId === sessionId) void page("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
  });
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  const loaded = cdp.waitFor("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
  const nav = await page("Page.navigate", { url });
  if (nav.errorText) throw new SnapshotError(`Couldn't open ${url}: ${nav.errorText}`, 502);
  // A page that never finishes loading (a stream, a stuck request) is still shown as it is by then.
  await loaded;
  await delay(SETTLE_MS);
  const { result } = await page("Runtime.evaluate", { expression: "JSON.stringify({ url: location.href, title: document.title })", returnByValue: true });
  const info = JSON.parse(String(result?.value ?? "{}")) as { url?: string; title?: string };
  if (!full) {
    const shot = await page("Page.captureScreenshot", { format: "png" });
    return { image: shot.data, width, height, url: info.url || url, title: info.title ?? "" };
  }
  // The whole page, at the zoom it's shown at: a phone-width page without a viewport tag is laid out
  // wider (980px) and zoomed out to fit, so the clip is in the page's CSS pixels at that scale.
  const metrics = await page("Page.getLayoutMetrics");
  const view = metrics.cssVisualViewport ?? {};
  const scale = view.scale > 0 ? (view.scale as number) : 1;
  const cssWidth = (view.clientWidth as number) || width / scale;
  const cssHeight = Math.min(Math.max(metrics.cssContentSize?.height ?? 0, (view.clientHeight as number) || height / scale), MAX_HEIGHT / scale);
  const shot = await page("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: cssWidth, height: cssHeight, scale },
  });
  return { image: shot.data, width: Math.round(cssWidth * scale), height: Math.round(cssHeight * scale), url: info.url || url, title: info.title ?? "" };
}

/** Chrome's DevTools protocol over its pipe: JSON messages, each ended by a NUL byte. */
class DevTools {
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(msg: any) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly out: Writable, input: Readable) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\0")) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        const waiting = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (waiting) {
          this.pending.delete(msg.id);
          if (msg.error) waiting.reject(new Error(msg.error.message ?? "DevTools error"));
          else waiting.resolve(msg.result ?? {});
        } else {
          for (const listener of this.listeners) listener(msg);
        }
      }
    });
    // Chrome is gone (it exited, or never started): nothing waiting will get an answer.
    input.on("close", () => this.close());
    input.on("end", () => this.close());
    input.on("error", () => this.close());
    out.on("error", () => undefined);
  }

  private close() {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("Chrome closed the DevTools pipe"));
    this.pending.clear();
  }

  /** Stops everything still waiting on this Chrome: commands, events and their timers. */
  dispose() {
    this.close();
    this.listeners.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Every event from now on. */
  on(listener: (msg: any) => void) {
    this.listeners.add(listener);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Chrome closed the DevTools pipe"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Resolves when the event arrives in this session, or after `ms` either way. */
  waitFor(method: string, sessionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.listeners.delete(listener);
        resolve();
      };
      const listener = (msg: any) => {
        if (msg.method === method && msg.sessionId === sessionId) done();
      };
      const timer = setTimeout(done, ms);
      this.timers.add(timer);
      this.listeners.add(listener);
    });
  }
}
