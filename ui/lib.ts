import { signal } from "@preact/signals";
import type { AgentId } from "./types.js";

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode or blocked storage: settings just won't persist
    }
  },
  json<T>(k: string, fallback: T): T {
    try {
      return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? fallback;
    } catch {
      return fallback;
    }
  },
};

export const enc = encodeURIComponent;
export const baseName = (p: string) => (p || "").replace(/\/+$/, "").split("/").pop() ?? "";
export const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
export const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const duration = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

export const SHORT: Record<AgentId, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };
export const FLOWS: Record<string, string> = {
  pipeline: "One plans, one builds, another reviews",
  loop: "Fix → run check → repeat until green",
  race: "Everyone solves it → Judge picks",
  debate: "Propose → Debate → Synthesize",
  supervisor: "Split → Build in parallel → Integrate",
  tdd: "Tests first → Implement → Verify",
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
