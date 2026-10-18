import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { CONTEXT_DIR, objectTypeAt, workingCopyDiffers } from "./git.js";
import { normalizeRepoPath, resolveInsideRepo } from "./repo-tree.js";
import { assertContextPathAllowed, assertNoContextSymlinks, sensitiveContextPath } from "./context-inspection.js";

/**
 * Context the user hands to every agent in a run: repo files/folders dragged from the
 * file tree, and files dropped in from outside the repo.
 *
 * Nothing is pasted into prompts. Repo paths are referenced directly (every worktree has
 * them), and anything an agent could not see in its worktree — the user's uncommitted or
 * modified version of a file, or an uploaded attachment — is copied into `.codeflow-context/`
 * inside each worktree. That folder is git-excluded, so it is never committed.
 */

export interface ContextInput {
  paths?: { path: string }[];
  /** Files from outside the repo; `data` is base64. */
  attachments?: { name: string; data: string }[];
}

export interface ContextPath {
  path: string;
  type: "file" | "dir";
  /** Where the user's working-copy version was copied, relative to the worktree. */
  workingCopy?: string;
  note?: "uncommitted" | "modified";
}

export interface ContextAttachment {
  name: string;
  size: number;
  /** Relative to the worktree. */
  file: string;
}

export interface RunContext {
  paths: ContextPath[];
  attachments: ContextAttachment[];
}

export const LIMITS = {
  paths: 50,
  attachments: 20,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
};

export const EMPTY_CONTEXT: RunContext = { paths: [], attachments: [] };

export function hasStagedFiles(ctx: RunContext): boolean {
  return ctx.attachments.length > 0 || ctx.paths.some((p) => p.workingCopy);
}

/**
 * Validate the user's context against the repo and the run's base commit, and stage the
 * files that need copying into `stageDir` (later copied into each worktree's CONTEXT_DIR).
 */
export async function prepareContext(repo: string, baseRef: string, input: ContextInput | undefined, stageDir: string): Promise<RunContext> {
  const ctx: RunContext = { paths: [], attachments: [] };
  const rawPaths = input?.paths ?? [];
  const rawAttachments = input?.attachments ?? [];
  if (rawPaths.length > LIMITS.paths) throw new Error(`Too many context paths (max ${LIMITS.paths})`);
  if (rawAttachments.length > LIMITS.attachments) throw new Error(`Too many attached files (max ${LIMITS.attachments})`);

  let total = 0;
  const seen = new Set<string>();

  for (const { path: raw } of rawPaths) {
    const path = normalizeRepoPath(String(raw ?? ""));
    if (!path || seen.has(path)) continue;
    assertContextPathAllowed(String(raw));
    await assertNoContextSymlinks(repo, path, baseRef);
    seen.add(path);

    const inBase = await objectTypeAt(repo, baseRef, path);
    const local = await resolveInsideRepo(repo, path)
      .then((abs) => stat(abs).then((s) => ({ abs, s })))
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
    if (!inBase && !local) throw new Error(`"${path}" was not found in the repository`);

    if (inBase === "tree" || local?.s.isDirectory()) {
      if (!inBase) throw new Error(`Folder "${path}" isn't in the base branch; commit it, or drop the individual files you need`);
      ctx.paths.push({ path, type: "dir" });
      continue;
    }

    // A file agents can already see unchanged in their worktree is just referenced.
    if (!local || (inBase && !(await workingCopyDiffers(repo, baseRef, path)))) {
      ctx.paths.push({ path, type: "file" });
      continue;
    }

    if (local.s.size > LIMITS.fileBytes) throw new Error(`"${path}" is larger than ${mb(LIMITS.fileBytes)}`);
    total += local.s.size;
    if (total > LIMITS.totalBytes) throw new Error(`Context files exceed ${mb(LIMITS.totalBytes)} in total`);
    const staged = join(stageDir, "repo", ...path.split("/"));
    await mkdir(dirname(staged), { recursive: true });
    await copyFile(local.abs, staged);
    ctx.paths.push({ path, type: "file", workingCopy: `${CONTEXT_DIR}/repo/${path}`, note: inBase ? "modified" : "uncommitted" });
  }

  const names = new Set<string>();
  for (const att of rawAttachments) {
    if (sensitiveContextPath(String(att.name ?? "file").replace(/\\/g, "/").split("/").at(-1)!)) throw new Error("Potential credential attachments are not allowed as explicit context");
    const data = Buffer.from(String(att.data ?? ""), "base64");
    if (data.length > LIMITS.fileBytes) throw new Error(`"${att.name}" is larger than ${mb(LIMITS.fileBytes)}`);
    total += data.length;
    if (total > LIMITS.totalBytes) throw new Error(`Context files exceed ${mb(LIMITS.totalBytes)} in total`);
    const name = uniqueName(safeFileName(String(att.name ?? "file")), names);
    await mkdir(join(stageDir, "attachments"), { recursive: true });
    await writeFile(join(stageDir, "attachments", name), data);
    ctx.attachments.push({ name, size: data.length, file: `${CONTEXT_DIR}/attachments/${name}` });
  }

  return ctx;
}

/**
 * Files sent with a message to a run (the Browser's screenshots, say): staged in the run's
 * `stageDir`, never in a worktree, which may not be attached right now (a folder made at its path
 * would stop it from being attached again). `copyMessageFiles` puts them in the worktree's
 * CONTEXT_DIR once the turn has it, where the agent can open them and nothing is committed.
 * Their paths there, relative to the worktree.
 */
export async function stageMessageFiles(stageDir: string, prefix: string, files: { name: string; data: string }[]): Promise<string[]> {
  if (files.length > LIMITS.attachments) throw new Error(`Too many attached files (max ${LIMITS.attachments})`);
  const names = new Set<string>();
  const paths: string[] = [];
  let total = 0;
  for (const f of files) {
    if (sensitiveContextPath(String(f.name ?? "file").replace(/\\/g, "/").split("/").at(-1)!)) throw new Error("Potential credential attachments are not allowed as message context");
    const data = Buffer.from(String(f.data ?? ""), "base64");
    if (data.length > LIMITS.fileBytes) throw new Error(`"${f.name}" is larger than ${mb(LIMITS.fileBytes)}`);
    total += data.length;
    if (total > LIMITS.totalBytes) throw new Error(`Attached files exceed ${mb(LIMITS.totalBytes)} in total`);
    const name = uniqueName(`${prefix}-${safeFileName(String(f.name ?? "file"))}`, names);
    const dir = join(stageDir, "messages");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), data);
    paths.push(`${CONTEXT_DIR}/messages/${name}`);
  }
  return paths;
}

/** Copy files staged by `stageMessageFiles` into an attached worktree, at the paths it returned. */
export async function copyMessageFiles(stageDir: string, worktree: string, files: string[]): Promise<void> {
  if (!files.length) return;
  const dir = join(worktree, CONTEXT_DIR, "messages");
  await mkdir(dir, { recursive: true });
  for (const file of files) await copyFile(join(stageDir, "messages", basename(file)), join(dir, basename(file)));
}

/** The prompt section every agent gets. Empty when the user gave no context. */
export function contextPrompt(ctx: RunContext): string {
  if (!ctx.paths.length && !ctx.attachments.length) return "";
  const lines = ["", "## Context from the user"];
  if (ctx.paths.length) {
    lines.push("The user pointed you to these. Read them before you start (paths are relative to the repository root):");
    for (const p of ctx.paths) {
      if (p.type === "dir") lines.push(`- \`${p.path}/\` (folder)`);
      else if (p.note === "uncommitted") lines.push(`- \`${p.path}\` — not committed yet; the user's copy is at \`${p.workingCopy}\``);
      else if (p.note === "modified") lines.push(`- \`${p.path}\` — the user has local changes; their version is at \`${p.workingCopy}\``);
      else lines.push(`- \`${p.path}\``);
    }
  }
  if (ctx.attachments.length) {
    lines.push("Files the user attached:");
    for (const a of ctx.attachments) lines.push(`- \`${a.file}\` (${kb(a.size)})`);
  }
  if (hasStagedFiles(ctx)) {
    lines.push(`\`${CONTEXT_DIR}/\` is reference material: read it, but don't edit it or copy it into the codebase unless the task asks for that.`);
  }
  return lines.join("\n") + "\n";
}

function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return cleaned || "file";
}

function uniqueName(name: string, taken: Set<string>): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
