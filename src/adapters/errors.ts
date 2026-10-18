import type { ErrorKind } from "./types.js";

/**
 * An HTTP status, only with words around it ("status 503", "HTTP 401", "API Error: 529",
 * "500 Internal Server Error"): a bare number in a stderr tail (a test's output, a port) isn't one.
 */
const status = (codes: string) =>
  String.raw`\b(?:status|code|http(?:/[\d.]+)?|error)\b[\s:=#]*(?:${codes})\b|\b(?:${codes})\s+(?:unauthorized|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)`;

const PATTERNS: [ErrorKind, RegExp][] = [
  // Claude: "No conversation found with session ID: …"; Codex: "no rollout found for thread id …"
  ["session_not_found", /no conversation found|no rollout found|(?:thread|conversation|session) (?:not found|does not exist)/i],
  // commander (Claude, agy): "error: unknown option '--x'"; clap (Codex): "error: unexpected argument '--x' found"
  ["cli_incompatible", /unknown option|unknown flag|unrecognized (?:option|argument|subcommand)|unexpected argument|wasn't expected|invalid value for '--/i],
  [
    "auth",
    new RegExp(String.raw`not logged in|please run /login|run \`?\w+ login\`?|invalid api key|oauth token (?:has )?expired|token (?:has )?expired|login (?:has )?expired|authentication_error|unauthenticated|unauthorized|(?:log|sign) in again|${status("401")}`, "i"),
  ],
  // Per-minute limits, even when worded as a quota (Google's 429s say "Quota exceeded for quota
  // metric '… requests per minute'"). Told apart before usage limits, which stop the run and keep
  // Auto away from the agent until the plan resets: taking a 429 for one costs far more than the
  // reverse (a retry that fails again).
  ["rate_limit", /\bper (?:minute|second|min\b)|\brequests per min/i],
  // Google's RESOURCE_EXHAUSTED is also its per-minute 429: a usage limit only when it says it's the plan's or the day's.
  ["usage_limit", /RESOURCE_EXHAUSTED[^\n]*(?:daily|per day|plan\b|usage limit)|(?:daily|per day|plan\b|usage limit)[^\n]*RESOURCE_EXHAUSTED/i],
  [
    "usage_limit",
    /usage limit|hit your (?:\w+[ -])?limit|quota (?:exceeded|reached|exhausted)|exceeded (?:your|the) [\w -]{0,30}quota|out of credits|credit balance is too low/i,
  ],
  // A plan's "limit reached" (below) is a usage limit unless it says "rate".
  ["rate_limit", new RegExp(String.raw`too many requests|rate.?limit|RESOURCE_EXHAUSTED|${status("429")}`, "i")],
  // "5-hour limit reached", "Weekly limit reached": not a context, token or turn limit.
  ["usage_limit", /(?<!\b(?:context|token|tokens|turn|turns|output|length|size|depth|recursion) )limit reached/i],
  [
    "transient",
    new RegExp(
      String.raw`overloaded|internal server error|bad gateway|service unavailable|gateway timeout|temporar(?:il)?y unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|connection (?:reset|closed|error|refused|failed)|stream disconnected|${status("50[0234]|529")}`,
      "i",
    ),
  ],
];

/**
 * Why a turn failed, from the CLI's own error text: a result event's error, a turn failure, or
 * the CLI's own error line on stderr (`cliErrorLine`). Never from what the agent wrote: an agent
 * reporting "the API returned 500" from its own work hasn't failed. Adapters read the CLI's
 * structured signals first (a rejected rate-limit event, Codex's error info, agy's status) and
 * only fall back to this. Checked in order; the first match wins.
 */
export function classifyError(text: string | undefined): ErrorKind {
  if (!text) return "other";
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? "other";
}

/**
 * The CLI's own error among what it wrote to stderr: the last line that reads as an error
 * ("Error: …", "error: unknown option …", "fatal: …"), else the last line. stderr also carries
 * what hooks and MCP servers print (an MCP server's "401 Unauthorized" from its own API, a hook's
 * "quota exceeded"), and classifying every line would make those the CLI's failure.
 */
export function cliErrorLine(stderr: string | undefined): string {
  const lines = (stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return [...lines].reverse().find((l) => /^(?:\w+ )?(?:error|fatal|panic)\b/i.test(l)) ?? lines.at(-1) ?? "";
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/**
 * When a usage limit resets, if the message says (ms since epoch): Claude's
 * "usage limit reached|<epoch seconds>", or Codex's "try again in 4 hours 21 minutes".
 */
export function resetFromText(text: string | undefined, now = Date.now()): number | undefined {
  if (!text) return undefined;
  const epoch = /limit reached\|(\d{10})\b/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const after = /try again in ((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!after) return undefined;
  let ms = 0;
  for (const [, n, unit] of after[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) ms += Number(n) * (UNIT_MS[unit![0]!.toLowerCase()] ?? 0);
  return ms ? now + ms : undefined;
}
