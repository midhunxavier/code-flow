import { signal } from "@preact/signals";
import { useCallback, useEffect, useRef } from "preact/hooks";
import type { AgentId } from "./types.js";

/** An API error; `confirm` names a choice the server needs from you before it can go ahead. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly confirm?: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  } catch {
    // The browser only says "Failed to fetch": the server is down or restarting.
    throw new ApiError("Can't reach code-flow. Is the server still running?", 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; confirm?: string; signIn?: boolean };
  if (res.status === 401 && body.signIn) signInAgain();
  if (!res.ok) throw new ApiError(body.error || res.statusText, res.status, body.confirm);
  return body as T;
}

/**
 * The server restarted (its session is new): reload, which signs this browser in again if it
 * still can, or shows how to. Once per minute at most, so a locked server can't loop.
 */
export function signInAgain() {
  try {
    const last = Number(sessionStorage.getItem("signInReload") ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem("signInReload", String(Date.now()));
  } catch {
    // no storage: reload anyway
  }
  location.reload();
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

const workspaceKey = (key: string) => {
  const id = (window as Window & { __CODEFLOW_WORKSPACE?: string }).__CODEFLOW_WORKSPACE;
  return id ? `ssh:${id}:${key}` : key;
};
export const store = {
  remove(k: string) { try { localStorage.removeItem(workspaceKey(k)); } catch {} },
  get(k: string): string | null {
    try {
      return localStorage.getItem(workspaceKey(k));
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(workspaceKey(k), v);
    } catch {
      // private mode or blocked storage: settings just won't persist
    }
  },
  json<T>(k: string, fallback: T): T {
    try {
      return (JSON.parse(localStorage.getItem(workspaceKey(k)) ?? "null") as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
};

/** This page came from the phone link (code-flow's Wi-Fi listener), not from the computer itself. */
export const onPhone = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

export const enc = encodeURIComponent;

/** A link from the server (a PR, an issue, a posted review) only as an http(s) address; anything else gets no link. */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answers that can arrive out of order: `begin()` starts a request and returns a check that stays
 * true only until the next `begin()`, so a slow, older answer never replaces a newer one.
 */
export function latestOnly(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}

/** `latestOnly` for a component: unmounting it also makes every answer still on its way stale. */
export function useLatest(): () => () => boolean {
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  return useCallback(() => {
    const mine = ++seq.current;
    return () => mine === seq.current;
  }, []);
}

/**
 * Call `fn` now and every `ms` while `active` and the page is in view: a hidden tab (or a closed
 * panel) polls nothing, and catches up with one call when it's shown again. `ms` 0 means no
 * interval at all (the call still happens on mount, when `deps` change and when the page is shown
 * again), for pages that reload on an event stream instead: a shared account's session ends after
 * 30 minutes idle, and a timer that asks the server every 15 s would keep it alive for ever. `fn`
 * gets a check that turns false once `deps` change or the component goes, for answers that come
 * back after that.
 */
export function usePoll(fn: (current: () => boolean) => unknown, ms: number, deps: unknown[], active = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const current = () => live;
    const tick = () => {
      if (!document.hidden) void latest.current(current);
    };
    tick();
    const timer = ms > 0 ? setInterval(tick, ms) : undefined;
    document.addEventListener("visibilitychange", tick);
    return () => {
      live = false;
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, ms, ...deps]);
}
export const baseName = (p: string) => (p || "").replace(/\/+$/, "").split("/").pop() ?? "";
export const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const duration = (ms: number) =>
  ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60000)}m`;
/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export const fmtTokens = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);
/** What Claude reports a turn would cost on the API (subscription use isn't billed per token). */
export const fmtCost = (usd: number) => (usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? "<$0.01" : "$0");
export const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

export const SHORT: Record<AgentId | "auto", string> = { claude: "Claude", codex: "Codex", agy: "Antigravity", auto: "Auto" };
export const FLOWS: Record<string, string> = {
  pipeline: "One plans, one builds, another reviews",
  loop: "Fix → run check → repeat until green",
  race: "Everyone solves it → Judge picks",
  debate: "Propose → Debate → Synthesize",
  supervisor: "Split → Build in parallel → Integrate",
  tdd: "Tests first → Implement → Verify",
  council: "Review independently → Chair merges",
  solo: "One agent, and you keep talking to it",
};
export const STATUS_TEXT: Record<string, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  stopped: "Stopped at limit",
  interrupted: "Interrupted",
};

// ---- toasts
export const toast = signal<{ text: string; id: number } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(text: string, ms = 2000) {
  toast.value = { text, id: Date.now() };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), ms);
}

export async function copy(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    return showToast(label);
  } catch {
    // Clipboard API can be blocked (unfocused or embedded windows); fall back to a selection copy.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    showToast(ok ? label : `Copy this: ${text}`, ok ? 2000 : 6000);
  }
}

export const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
