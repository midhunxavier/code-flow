import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * The page is loaded in a headless Chrome (or Chromium, or Edge) with a fresh, empty profile, so
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

const CHROMES: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/** The browser snapshots use: CODEFLOW_CHROME, else the first Chrome-like browser installed. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  if (env.CODEFLOW_CHROME) return existsSync(env.CODEFLOW_CHROME) ? env.CODEFLOW_CHROME : undefined;
  for (const candidate of CHROMES[platform] ?? CHROMES.linux!) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      if (existsSync(join(dir, candidate))) return join(dir, candidate);
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
  const height = Math.round(Math.min(Math.max(request.height ?? Math.round((width * 10) / 16), 240), 4000));
  const chrome = findChrome();
  if (!chrome) throw new SnapshotError("Snapshots need Google Chrome, Chromium or Edge on this computer: install one, or set CODEFLOW_CHROME to its path", 501);
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
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code) => reject(new SnapshotError(`Chrome stopped before the snapshot was taken (exit ${code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`, 502))),
  );
  child.once("error", () => undefined); // the exit above says what happened
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SnapshotError(`The page took longer than ${TOTAL_TIMEOUT_MS / 1000}s to snapshot`, 504)), TOTAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([drive(cdp, url, width, height, full), exited, timeout]);
  } finally {
    clearTimeout(timer);
    await cdp.send("Browser.close").catch(() => undefined);
    killGroup(child.pid, 1_000);
    untrackGroup(child.pid);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function drive(cdp: DevTools, url: string, width: number, height: number, full: boolean): Promise<Snapshot> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
  await page("Page.enable");
  await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  const loaded = cdp.waitFor("Page.loadEventFired", sessionId, LOAD_TIMEOUT_MS);
  const nav = await page("Page.navigate", { url });
  if (nav.errorText) throw new SnapshotError(`Couldn't open ${url}: ${nav.errorText}`, 502);
  // A page that never finishes loading (a stream, a stuck request) is still shown as it is by then.
  await loaded;
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const { result } = await page("Runtime.evaluate", {
    expression: "JSON.stringify({ url: location.href, title: document.title, h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })",
    returnByValue: true,
  });
  const info = JSON.parse(String(result?.value ?? "{}")) as { url?: string; title?: string; h?: number };
  const shotHeight = full ? Math.min(Math.max(info.h ?? height, height), MAX_HEIGHT) : height;
  const shot = await page("Page.captureScreenshot", {
    format: "png",
    ...(full ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: shotHeight, scale: 1 } } : {}),
  });
  return { image: shot.data, width, height: shotHeight, url: info.url || url, title: info.title ?? "" };
}

/** Chrome's DevTools protocol over its pipe: JSON messages, each ended by a NUL byte. */
class DevTools {
  private nextId = 0;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(msg: any) => void>();

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
    input.on("error", () => undefined);
    out.on("error", () => undefined);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
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
        this.listeners.delete(listener);
        resolve();
      };
      const listener = (msg: any) => {
        if (msg.method === method && msg.sessionId === sessionId) done();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(listener);
    });
  }
}
