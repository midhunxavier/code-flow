import type { RunSummary } from "./types.js";

export interface WorkbenchFolder { path: string; name: string; run: RunSummary }
/** The run that owns a worktree folder: a chat owns the workspace its provider tabs and side chats share. */
const owns = (run: RunSummary) => (run.chatLink?.workspaceId ?? run.id) === run.id;

/**
 * One entry per run worktree folder the repository tools can open. An archived run's folder is listed
 * only once it is confirmed still on disk, as archiving can remove it while the run keeps its record.
 * A chat and its tabs share one folder; it is listed once, for the chat.
 */
export function workbenchFolders(runs: Iterable<RunSummary>, present: ReadonlySet<string>): WorkbenchFolder[] {
  const folders = new Map<string, WorkbenchFolder>();
  for (const run of runs) for (const tree of run.worktrees) {
    if (run.archived && !present.has(tree.path)) continue;
    const listed = folders.get(tree.path);
    if (!listed || !owns(listed.run) && owns(run)) folders.set(tree.path, { path: tree.path, name: tree.name, run });
  }
  return [...folders.values()];
}

type Listing = { names: string[]; truncated: boolean } | null;
const split = (path: string) => { const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")); return { parent: path.slice(0, at), name: path.slice(at + 1) }; };
/**
 * Which of `paths` are folders still on disk. Run worktrees share a parent per run and a grandparent per
 * repository, so this lists the grandparents first and only the parents still there, instead of one
 * request per folder. `list` gives a folder's subfolder names, or null when it is gone.
 */
export async function presentFolders(paths: readonly string[], list: (path: string) => Promise<Listing>): Promise<Set<string>> {
  const unique = [...new Set(paths)], parents = [...new Set(unique.map((path) => split(path).parent))];
  const grand = new Map(await Promise.all([...new Set(parents.map((parent) => split(parent).parent))].map(async (path) => [path, await list(path)] as const)));
  const live = parents.filter((parent) => { const { parent: above, name } = split(parent), listing = grand.get(above); return !!listing && (listing.truncated || listing.names.includes(name)); });
  const listed = new Map(await Promise.all(live.map(async (path) => [path, await list(path)] as const)));
  return new Set(unique.filter((path) => { const { parent, name } = split(path), listing = listed.get(parent); return !!listing && (listing.truncated ? true : listing.names.includes(name)); }));
}
