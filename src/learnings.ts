import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { git } from "./git.js";

/**
 * What the team should already know about a repo before it starts:
 * - its own conventions files (AGENTS.md, CLAUDE.md, …). Each CLI reads only its own vendor's
 *   file, so on a mixed team Codex never sees CLAUDE.md and Claude never sees AGENTS.md;
 * - lessons: problems reviewers flagged in more than one earlier run in this repo. A problem
 *   found once is about that change; one that keeps coming back is about how to work here.
 */

const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursorrules"];
const MAX_CONVENTIONS = 6_000;

/** The repo's conventions files at `ref`, combined (or "" when it has none). */
export async function readConventions(repo: string, ref: string): Promise<string> {
  const parts: string[] = [];
  let size = 0;
  for (const path of CONVENTION_FILES) {
    const res = await git(["show", `${ref}:${path}`], repo);
    const text = res.code === 0 ? res.stdout.trim() : "";
    if (!text) continue;
    const room = MAX_CONVENTIONS - size;
    if (room < 200) break;
    const body = text.length > room ? `${text.slice(0, room)}\n… (${path} is longer; read the file for the rest)` : text;
    parts.push(`### ${path}\n${body}`);
    size += body.length;
  }
  return parts.join("\n\n");
}

export interface Lesson {
  problem: string;
  file: string;
  /** Distinct runs that raised it. */
  runs: string[];
  at: number;
}

const DIR = join(CODEFLOW_HOME, "learnings");
const MAX_LESSONS = 200;
/** Only problems raised in at least this many runs are passed on. */
const RECURRING = 2;

const fileFor = (repo: string) => join(DIR, `${createHash("sha1").update(repo).digest("hex").slice(0, 16)}.json`);

async function load(repo: string): Promise<Lesson[]> {
  const file = fileFor(repo);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
function similar(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.6;
}

let saving: Promise<unknown> = Promise.resolve();

/** Record review findings (high and medium only) from a run. */
export function recordFindings(repo: string, runId: string, findings: { severity?: string; file?: string; problem: string }[]): Promise<unknown> {
  const worth = findings.filter((f) => f.severity === "high" || f.severity === "medium").filter((f) => f.problem?.trim());
  if (!worth.length) return saving;
  saving = saving
    .then(async () => {
      const lessons = await load(repo);
      for (const f of worth) {
        const problem = f.problem.trim().slice(0, 300);
        const match = lessons.find((l) => similar(l.problem, problem));
        if (match) {
          if (!match.runs.includes(runId)) match.runs.push(runId);
          match.at = Date.now();
        } else {
          lessons.push({ problem, file: f.file ?? "", runs: [runId], at: Date.now() });
        }
      }
      lessons.sort((a, b) => b.at - a.at);
      await mkdir(DIR, { recursive: true });
      const file = fileFor(repo);
      await writeFile(`${file}.tmp`, JSON.stringify(lessons.slice(0, MAX_LESSONS), null, 1));
      await rename(`${file}.tmp`, file);
    })
    .catch(() => undefined);
  return saving;
}

/** Problems reviewers keep raising in this repo, most frequent first. */
export async function recurringLessons(repo: string, limit = 8): Promise<Lesson[]> {
  await saving;
  return (await load(repo))
    .filter((l) => l.runs.length >= RECURRING)
    .sort((a, b) => b.runs.length - a.runs.length || b.at - a.at)
    .slice(0, limit);
}
