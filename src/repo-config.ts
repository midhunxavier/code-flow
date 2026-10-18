import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AgentSettings } from "./adapters/types.js";
import { COPIED_FILES, git, gitWithInput } from "./git.js";

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
 * Nor is anything written through a link in the worktree. The copied paths are recorded so
 * commits leave them out (commitAll). Returns the copied paths and the ones refused (with why).
 */
export async function copyIntoWorktree(
  repo: string,
  worktree: string,
  patterns: string[],
): Promise<{ copied: string[]; refused: { path: string; why: string }[] }> {
  const copied: string[] = [];
  const refused: { path: string; why: string }[] = [];
  const root = await realpath(repo).catch(() => repo);
  const candidates: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern || pattern.startsWith("/") || pattern.split("/").includes("..")) continue;
    for (const rel of await expand(repo, pattern)) {
      const from = join(repo, rel);
      if (existsSync(join(worktree, rel))) continue;
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
      candidates.push(rel);
    }
  }
  const ignored = new Set(
    candidates.length
      ? (await gitWithInput(["check-ignore", "--stdin", "-z"], repo, candidates.join("\0") + "\0")).stdout.split("\0").filter(Boolean)
      : [],
  );
  for (const rel of candidates) {
    if (!ignored.has(rel)) {
      refused.push({ path: rel, why: "git doesn't ignore it, so it would be committed with the agents' work" });
      continue;
    }
    // The worktree is the agents' (a re-attached one holds whatever they committed): a link there
    // would send your `.env` wherever it points.
    const done = await copyFileInside(worktree, rel, join(repo, rel), { overwrite: false });
    if (done.copied) copied.push(rel);
    else if (done.why) refused.push({ path: rel, why: done.why });
  }
  await recordCopied(worktree, copied);
  return { copied, refused };
}

/**
 * Note in the worktree's git dir (where agents don't write) which files were copied in, so
 * committing leaves them out even after an agent un-ignores one or `git add -f`s it (commitAll).
 */
async function recordCopied(worktree: string, copied: string[]): Promise<void> {
  if (!copied.length) return;
  const res = await git(["rev-parse", "--git-path", COPIED_FILES], worktree);
  if (res.code !== 0 || !res.stdout.trim()) return;
  const file = resolve(worktree, res.stdout.trim());
  const known = (await readFile(file, "utf8").catch(() => "")).split("\0").filter(Boolean);
  await writeFile(file, [...new Set([...known, ...copied])].map((p) => `${p}\0`).join(""));
}

/**
 * Copy `from` to `rel` inside `root` without following a symbolic link on the way there, like
 * writeFileInside (fs.ts) does for a write: a worktree holds whatever an agent put in it, and a
 * link it made at `.env` or `.codeflow-context` would otherwise send the copy anywhere, over your
 * own files included. Folders that don't exist are created one at a time. With `overwrite: false`
 * a file already there is left as it is (`copied: false` and no `why`). Returns why it refused.
 */
export async function copyFileInside(
  root: string,
  rel: string,
  from: string,
  opts: { overwrite?: boolean } = {},
): Promise<{ copied: true } | { copied: false; why?: string }> {
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..")) return { copied: false, why: `\`${rel}\` isn't a path inside the worktree` };
  const realRoot = await realpath(root);
  let dir = root;
  for (const [i, part] of parts.slice(0, -1).entries()) {
    dir = join(dir, part);
    const info = await lstat(dir).catch(() => undefined);
    const at = parts.slice(0, i + 1).join("/");
    if (!info) await mkdir(dir);
    else if (info.isSymbolicLink()) return { copied: false, why: `the worktree has a symbolic link at \`${at}\`` };
    else if (!info.isDirectory()) return { copied: false, why: `\`${at}\` in the worktree isn't a folder` };
  }
  // Checked part by part above; this catches a link that appeared in between.
  const realDir = await realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) return { copied: false, why: `\`${rel}\` leads outside the worktree` };
  const target = join(dir, parts.at(-1)!);
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) return { copied: false, why: `the worktree has a symbolic link at \`${rel}\`` };
  if (existing && !existing.isFile()) return { copied: false, why: `\`${rel}\` in the worktree isn't a file` };
  if (existing && opts.overwrite === false) return { copied: false };
  const [data, mode] = await Promise.all([readFile(from), stat(from).then((s) => s.mode & 0o777)]);
  // O_NOFOLLOW: if a link shows up at the last moment, opening fails instead of following it.
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await file.writeFile(data);
  } finally {
    await file.close();
  }
  return { copied: true };
}

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
