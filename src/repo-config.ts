import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentSettings } from "./adapters/types.js";
import { gitWithInput } from "./git.js";

/**
 * Optional per-repo settings, committed with the project at `.codeflow/config.json`, so every
 * worktree works like your checkout and every teammate gets the same defaults:
 *
 *   {
 *     "check": "npm test",                         // "done when" command
 *     "setup": "npm ci",                           // runs in every new worktree
 *     "copy": [".env", ".env.local", "config/*.local.json"],  // gitignored files to copy in
 *     "run": { "command": "npm run dev", "port": 3000 },      // "Run app" (gets $PORT)
 *     "models": { "claude": { "model": "opus", "effort": "high" } },
 *     "limits": { "maxMinutes": 90, "maxSteps": 60 },
 *     "trust": "standard",
 *     "image": "node:22",                          // Docker image for isolated checks
 *     "learn": true,                               // pass on problems reviewers keep raising
 *     "prove": true                                // prove results fail-to-pass
 *   }
 */
/** "full": any command, no sandbox, for every agent. Picked per run, never from a repo's config file. */
export type Trust = "safe" | "standard" | "trusted" | "full";

export interface RepoConfig {
  check?: string;
  setup?: string;
  copy?: string[];
  run?: { command: string; port?: number };
  models?: AgentSettings;
  limits?: { maxMinutes?: number; maxSteps?: number };
  trust?: Trust;
  /** Docker image for running checks in isolation (untrusted sources, automations). */
  image?: string;
  /** Tell agents about problems reviewers raised in more than one earlier run (default on). */
  learn?: boolean;
  /** Prove each result fail-to-pass: its tests must fail on the base code (default on). */
  prove?: boolean;
}

export const CONFIG_PATH = ".codeflow/config.json";

export async function readRepoConfig(repo: string): Promise<{ config: RepoConfig; found: boolean; error?: string }> {
  const file = join(repo, CONFIG_PATH);
  if (!existsSync(file)) return { config: {}, found: false };
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const config: RepoConfig = {};
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    config.check = str(raw.check);
    config.setup = str(raw.setup);
    if (Array.isArray(raw.copy)) config.copy = raw.copy.filter((p: unknown): p is string => typeof p === "string" && !!p.trim());
    if (raw.run && str(raw.run.command)) config.run = { command: str(raw.run.command)!, port: Number(raw.run.port) || undefined };
    if (raw.models && typeof raw.models === "object") config.models = raw.models;
    if (raw.limits && typeof raw.limits === "object") {
      // Positive numbers only: a negative or absurd budget would stop every run at once.
      const positive = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
      const steps = positive(raw.limits.maxSteps);
      config.limits = { maxMinutes: positive(raw.limits.maxMinutes), maxSteps: steps === undefined ? undefined : Math.max(1, Math.round(steps)) };
    }
    // Not "full": a repo's own file mustn't be able to turn off the agents' sandboxes.
    if (["safe", "standard", "trusted"].includes(raw.trust)) config.trust = raw.trust;
    if (typeof raw.image === "string" && /^[\w./:@-]{1,200}$/.test(raw.image.trim())) config.image = raw.image.trim();
    if (typeof raw.learn === "boolean") config.learn = raw.learn;
    if (typeof raw.prove === "boolean") config.prove = raw.prove;
    return { config, found: true };
  } catch (err) {
    return { config: {}, found: true, error: `${CONFIG_PATH}: ${(err as Error).message}` };
  }
}

/**
 * Copy files that git doesn't carry (like `.env`) from your checkout into a new worktree.
 * Patterns are repo-relative; `*` matches within one path segment. Existing files in the
 * worktree are never overwritten. Only regular, gitignored files inside the repo are copied:
 * a symlink could point anywhere (a cloned repo's `.env` → your cloud credentials), and a file
 * git doesn't ignore would be committed with the agents' work and pushed in a pull request.
 * Returns the copied paths and the ones refused (with why).
 */
export async function copyIntoWorktree(
  repo: string,
  worktree: string,
  patterns: string[],
): Promise<{ copied: string[]; refused: { path: string; why: string }[] }> {
  const copied: string[] = [];
  const refused: { path: string; why: string }[] = [];
  const root = await realpath(repo);
  const destination = resolve(worktree);
  const destinationRoot = await realpath(worktree);
  const candidates = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern || pattern.startsWith("/") || pattern.includes("\0") || pattern.split("/").some((part) => !part || part === ".." || part === ".")) continue;
    for (const rel of await expand(repo, pattern)) {
      const from = join(repo, rel);
      const info = await lstat(from).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        refused.push({ path: rel, why: "it's a symbolic link" });
        continue;
      }
      if (!info.isFile()) continue;
      // A folder on the way could itself be a link out of the repo.
      const real = await realpath(from).catch(() => "");
      if (!real.startsWith(root + sep)) {
        refused.push({ path: rel, why: "it's outside the repository" });
        continue;
      }
      candidates.add(rel);
    }
  }
  const ignored = new Set(
    candidates.size
      ? (await gitWithInput(["check-ignore", "--stdin", "-z"], repo, [...candidates].join("\0") + "\0")).stdout.split("\0").filter(Boolean)
      : [],
  );
  for (const rel of candidates) {
    if (!ignored.has(rel)) {
      refused.push({ path: rel, why: "git doesn't ignore it, so it would be committed with the agents' work" });
      continue;
    }
    const result = copyWithoutLinks(root, destination, destinationRoot, rel);
    if (result === "copied") copied.push(rel);
    else if (result !== "exists") refused.push({ path: rel, why: result });
  }
  return { copied, refused };
}

/**
 * No awaits occur between checking ancestry, opening exclusively and copying through file
 * descriptors. A dangling link counts as existing; neither it nor an existing file is ever
 * followed or replaced. Directory links are refused even when they point inside the tree.
 * Worktrees must remain exclusively owned during preparation, as for git checkout itself.
 */
function copyWithoutLinks(sourceRoot: string, destination: string, destinationRoot: string, rel: string): string {
  let from: number | undefined;
  let to: number | undefined;
  let created: Stats | undefined;
  const target = join(destinationRoot, rel);
  try {
    // Refuse a linked root and detect replacement since the canonical path was obtained.
    if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory() || realpathSync(destination) !== destinationRoot) return "the worktree root is a symbolic link or has changed";
    verifyParents(sourceRoot, dirname(rel), false);
    verifyParents(destinationRoot, dirname(rel), true);
    const source = join(sourceRoot, rel);
    const sourceInfo = lstatSync(source);
    if (sourceInfo.isSymbolicLink()) return "it's a symbolic link";
    if (!sourceInfo.isFile() || !realpathSync(source).startsWith(sourceRoot + sep)) return "it's outside the repository or isn't a regular file";
    from = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(sourceInfo, fstatSync(from))) return "the source file changed while preparing the copy";
    const existing = statIfPresent(target);
    if (existing?.isSymbolicLink()) return "the destination is a symbolic link";
    if (existing) return "exists";
    // O_EXCL, rather than an exists-then-copy check, makes the no-overwrite rule atomic.
    to = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = fstatSync(to);
    verifyParents(destinationRoot, dirname(rel), false);
    if (!sameFile(created, lstatSync(target))) throw new Error("the destination changed while preparing the copy");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes: number;
    while ((bytes = readSync(from, buffer, 0, buffer.length, null))) {
      let written = 0;
      while (written < bytes) written += writeSync(to, buffer, written, bytes - written);
    }
    return "copied";
  } catch (error) {
    // If someone won exclusive creation, leave their file alone.
    if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    if (created && sameFile(created, statIfPresent(target))) {
      try { unlinkSync(target); } catch { /* Preserve the original error. */ }
    }
    return (error as Error).message;
  } finally {
    if (from !== undefined) closeSync(from);
    if (to !== undefined) closeSync(to);
  }
}

function verifyParents(root: string, relative: string, create: boolean): void {
  let path = root;
  const expectedRoot = lstatSync(root);
  if (!expectedRoot.isDirectory() || expectedRoot.isSymbolicLink()) throw new Error("the copy root is not a regular directory");
  for (const part of relative === "." ? [] : relative.split(sep)) {
    path = join(path, part);
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("a parent directory is a symbolic link");
    if (!info.isDirectory() || realpathSync(path) !== path) throw new Error("a parent directory is outside the copy root or isn't a directory");
  }
  if (!sameFile(expectedRoot, lstatSync(root))) throw new Error("the copy root changed while preparing the copy");
}

function statIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const sameFile = (a: Stats, b: Stats | undefined) => !!b && a.dev === b.dev && a.ino === b.ino;

async function expand(repo: string, pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) return [pattern];
  const parts = pattern.split("/");
  let current = [""];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of current) {
      if (!part.includes("*")) {
        next.push(base ? `${base}/${part}` : part);
        continue;
      }
      const re = new RegExp(`^${part.split("*").map(escape).join("[^/]*")}$`);
      const entries = await readdir(join(repo, base)).catch(() => [] as string[]);
      for (const e of entries) if (re.test(e)) next.push(base ? `${base}/${e}` : e);
    }
    current = next;
  }
  return current;
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
