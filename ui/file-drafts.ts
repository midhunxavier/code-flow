import { workspaceKey } from "./lib.js";
interface FileDraft { folder: string; path: string; text: string; hash: string; draft: string; at: number; mergeConflict?: boolean }
const KEY = workspaceKey("codeflow-file-drafts-v1");
const sensitive = (path: string) => /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key))$/.test(path);
function read(): FileDraft[] {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry): entry is FileDraft => !!entry && typeof entry.folder === "string" && typeof entry.path === "string" && typeof entry.text === "string" && typeof entry.draft === "string" && typeof entry.hash === "string" && Number.isFinite(entry.at) && entry.at > Date.now() - 86_400_000 && !sensitive(entry.path)).slice(-10) : [];
  } catch { return []; }
}
export function loadFileDraft(folder: string, path: string) { return read().find((entry) => entry.folder === folder && entry.path === path); }
/** Per-tab recovery only. Credential filenames are never retained; exports remain available. */
export function retainFileDraft(folder: string, file: { path: string; text: string; hash: string }, draft: string, mergeConflict = false): "saved" | "sensitive" | "full" {
  try {
    const other = read().filter((entry) => entry.folder !== folder || entry.path !== file.path);
    if (sensitive(file.path)) { sessionStorage.setItem(KEY, JSON.stringify(other)); return "sensitive"; }
    if (JSON.stringify({ ...file, draft }).length > 2_000_000) return "full";
    if (draft !== file.text) other.push({ folder, ...file, draft, at: Date.now(), mergeConflict });
    while (other.length > 10 || JSON.stringify(other).length > 2_000_000) other.shift();
    sessionStorage.setItem(KEY, JSON.stringify(other));
    return "saved";
  } catch { return "full"; }
}
