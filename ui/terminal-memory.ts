import { store, workspaceKey } from "./lib.js";
import type { ShellEvent, ShellInfo } from "./types.js";

type Memory = { shell: ShellInfo; history: ShellEvent[] };
const memory = new Map<string, Memory>();
const key = (id: string) => workspaceKey(`terminal-session:${id}`);
/** Tab-local scrollback survives the stream's restart reload, never another browser's session. */
export function terminalMemory(id: string): Memory | undefined {
  if (memory.has(key(id))) return memory.get(key(id));
  try {
    const cached = JSON.parse(sessionStorage.getItem(key(id)) ?? "null");
    if (cached?.shell?.id === id && Array.isArray(cached.history)) { memory.set(key(id), cached); return cached; }
  } catch {}
}
export function rememberTerminal(shell: ShellInfo, history = terminalMemory(shell.id)?.history ?? []) {
  // Bound both event count and output bytes. A terminal is evidence, not an unbounded log archive.
  let bytes = 0;
  const tail: ShellEvent[] = [];
  for (let i = history.length - 1; i >= 0 && tail.length < 1000 && bytes < 200_000; i--) {
    const event = history[i]!;
    if (event.type === "output") { const text = event.text.slice(-(200_000 - bytes)); bytes += text.length; tail.unshift({ ...event, text }); }
    else tail.unshift(event);
  }
  const value = { shell, history: tail };
  memory.set(key(shell.id), value);
  try { sessionStorage.setItem(key(shell.id), JSON.stringify(value)); } catch {}
}
export function forgetTerminal(id: string) {
  memory.delete(key(id));
  try { sessionStorage.removeItem(key(id)); } catch {}
}
export function terminalHistoryKey(cwd: string, places: { path: string }[]) {
  const place = places.filter(p => cwd === p.path || cwd.startsWith(p.path.replace(/\/$/, "") + "/")).sort((a, b) => b.path.length - a.path.length)[0];
  return `termHistory:${place?.path ?? cwd}`;
}
export function loadTerminalHistory(key: string): string[] {
  const value = store.json<unknown>(key, []);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : [];
}
export function pushTerminalHistory(key: string, text: string) {
  const next = [text, ...loadTerminalHistory(key).filter(item => item !== text)].slice(0, 100);
  store.set(key, JSON.stringify(next));
  return next;
}
