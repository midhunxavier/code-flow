import { adapters, type AgentEvent, type AgentId, type ErrorKind } from "./adapters/index.js";
import { extractJson, shapeProblem } from "./json.js";

/**
 * Improve in the composer: one short read-only turn that rewrites a rough task so an agent can act
 * on it without guessing (same intent, said clearly) and hands the text back; nothing in the
 * repository changes. Quick works from the text alone on a fast model; Repo may read the
 * repository first, so the rewrite can name real files and commands.
 */

export type ImproveMode = "quick" | "repo";

export interface ImproveRequest {
  text: string;
  /** The repository the run will work in; the turn runs there, read-only. */
  repo: string;
  mode: ImproveMode;
  /** Paths added as context and names of attached files: the agents read these before starting. */
  context?: string[];
  /** The GitHub issue, PR or alert the run starts from. */
  source?: { kind: string; number: number; title?: string };
}

export interface ImproveResult {
  prompt: string;
  /** One sentence on what the rewrite changed. */
  summary: string;
}

/** A turn that failed, with the CLI's own reason (see ErrorKind) so the caller can update quota. */
export class ImproveError extends Error {
  constructor(message: string, readonly kind?: ErrorKind, readonly resetsAt?: number) {
    super(message);
  }
}

export const MAX_IMPROVE_CHARS = 20_000;

const SCHEMA = {
  type: "object",
  properties: { prompt: { type: "string" }, summary: { type: "string" } },
  required: ["prompt", "summary"],
  additionalProperties: false,
};

/** Model and effort per CLI. Quick favors speed; Repo needs a model that reads code well. */
const SETTINGS: Record<ImproveMode, Partial<Record<AgentId, { model?: string; effort?: string }>>> = {
  quick: { claude: { model: "haiku" }, codex: { effort: "low" }, agy: { effort: "low" } },
  repo: { claude: { model: "sonnet", effort: "low" }, codex: { effort: "low" }, agy: { effort: "low" } },
};

const TIMEOUT_MS: Record<ImproveMode, number> = { quick: 2 * 60_000, repo: 4 * 60_000 };

export function improveInstructions(req: ImproveRequest): string {
  const lines = [
    "Rewrite the task below for a team of coding agents. Don't do the task: return it, said better.",
    "",
    "- Keep the author's intent, scope and every concrete detail (names, paths, numbers, error messages, links). Add no requirements, features or constraints they didn't ask for.",
    "- Lead with the goal, then the specifics: what should change, where, any constraints, and how to tell it's done (behavior to see, tests or checks that should pass).",
    "- Fix spelling and grammar, and turn rambling into short paragraphs or a list. Keep it as short as it can be while staying complete.",
    '- Don\'t guess at anything important that\'s unclear: list it under "Open questions:" at the end (three at most), or leave that out when nothing is.',
    "- Write in the language of the original, in plain text or light Markdown, with no preamble or heading.",
    req.mode === "repo"
      ? "- You may look around the repository first (read-only, a few quick reads) to use its real file names, commands and conventions. Name only files you've seen. Don't review or change anything."
      : "- Work from the text alone: don't use tools or read files.",
    "",
    'Answer with a JSON object: "prompt" is the rewritten task, "summary" says in one short sentence what you changed.',
  ];
  if (req.source) lines.push("", `The run starts from GitHub ${req.source.kind} #${req.source.number}${req.source.title ? `: ${req.source.title}` : ""}. The agents get its text separately; don't repeat it.`);
  if (req.context?.length) lines.push("", "The agents also get these files as context:", ...req.context.map((p) => `- ${p}`));
  lines.push("", "## Task to improve", "", req.text.trim());
  return lines.join("\n");
}

export async function improvePrompt(
  agent: AgentId,
  req: ImproveRequest,
  opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {},
): Promise<ImproveResult> {
  const adapter = adapters[agent];
  const result = await adapter.run(
    {
      prompt: improveInstructions(req),
      cwd: req.repo,
      mode: "read",
      ...SETTINGS[req.mode][agent],
      jsonSchema: SCHEMA,
      signal: opts.signal,
      timeoutMs: TIMEOUT_MS[req.mode],
      idleTimeoutMs: 90_000,
    },
    opts.onEvent ?? (() => {}),
  );
  if (!result.ok) throw new ImproveError(failure(adapter.displayName, result.errorKind, result.error), result.errorKind, result.resetsAt);
  const answer = (result.structured ?? extractJson(result.finalText)) as ImproveResult | undefined;
  const prompt = typeof answer?.prompt === "string" ? answer.prompt.trim() : "";
  if (shapeProblem(SCHEMA, answer) || !prompt) throw new ImproveError(`${adapter.displayName} didn't return a rewritten task. Try again.`);
  return { prompt, summary: answer!.summary.replace(/\s+/g, " ").trim() };
}

function failure(name: string, kind: ErrorKind | undefined, error = ""): string {
  if (kind === "usage_limit") return `${name} hit its usage limit. Try again later.`;
  if (kind === "auth") return `${name} isn't signed in. Sign in to it in a terminal, then try again.`;
  if (kind === "timeout" || kind === "stalled") return `${name} took too long to answer. Try again.`;
  if (kind === "cancelled") return "Stopped.";
  return `${name} couldn't rewrite the task: ${error.split("\n")[0] || "unknown error"}`;
}
