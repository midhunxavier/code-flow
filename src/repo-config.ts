import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSettings } from "./adapters/types.js";

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
 *     "trust": "standard"
 *   }
 */
export type Trust = "safe" | "standard" | "trusted";

export interface RepoConfig {
  check?: string;
  setup?: string;
  copy?: string[];
  run?: { command: string; port?: number };
  models?: AgentSettings;
  limits?: { maxMinutes?: number; maxSteps?: number };
  trust?: Trust;
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
    if (["safe", "standard", "trusted"].includes(raw.trust)) config.trust = raw.trust;
    return { config, found: true };
  } catch (err) {
    return { config: {}, found: true, error: `${CONFIG_PATH}: ${(err as Error).message}` };
  }
}

/**
 * Copy files that git doesn't carry (like `.env`) from your checkout into a new worktree.
 * Patterns are repo-relative; `*` matches within one path segment. Existing files in the
 * worktree are never overwritten. Returns the copied paths.
 */
export async function copyIntoWorktree(repo: string, worktree: string, patterns: string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pattern || pattern.startsWith("/") || pattern.split("/").includes("..")) continue;
    for (const rel of await expand(repo, pattern)) {
      const from = join(repo, rel);
      const to = join(worktree, rel);
      if (existsSync(to)) continue;
      const info = await stat(from).catch(() => null);
      if (!info?.isFile()) continue;
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      copied.push(rel);
    }
  }
  return copied;
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
