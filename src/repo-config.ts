import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
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
 *     "learn": true                                // pass on problems reviewers keep raising
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
      config.limits = { maxMinutes: Number(raw.limits.maxMinutes) || undefined, maxSteps: Number(raw.limits.maxSteps) || undefined };
    }
    // Not "full": a repo's own file mustn't be able to turn off the agents' sandboxes.
    if (["safe", "standard", "trusted"].includes(raw.trust)) config.trust = raw.trust;
    if (typeof raw.image === "string" && /^[\w./:@-]{1,200}$/.test(raw.image.trim())) config.image = raw.image.trim();
    if (typeof raw.learn === "boolean") config.learn = raw.learn;
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
    const to = join(worktree, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(repo, rel), to);
    copied.push(rel);
  }
  return { copied, refused };
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
