import type { MemoryEntry, MemoryRef } from "./memory.js";

type Scalar = { kind: "boolean"; value: boolean } | { kind: "text"; value: string };
export type ClaimValue = Scalar | { kind: "number"; min: number | null; max: number | null; minInclusive: boolean; maxInclusive: boolean; unit: "count" | "ms" | "bytes" };
export interface MemoryClaim { source: MemoryRef; subject: string; predicate: string; value: ClaimValue; evidence: { start: number; end: number; text: string; method: "structured" | "policy" | "setting" } }
export interface MemoryClaimReview { a: MemoryRef; b: MemoryRef; kind: "equivalent" | "contradiction"; subject: string; predicate: string; left: MemoryClaim; right: MemoryClaim; explanation: string }
export interface MemoryClaimsAnalysis { claims: MemoryClaim[]; findings: MemoryClaimReview[]; inspectedEntries: number; unsupported: number; comparedPairs: number; truncated: boolean; limits: typeof LIMITS; method: string }
const LIMITS = { entries: 500, bodyChars: 20_000, claimsPerEntry: 12, claims: 1000, comparedPairs: 50_000, findings: 100, snippetChars: 512, structuredChars: 8192 };
const ACTIONS: Record<string, [string, boolean]> = { use: ["use", true], utilize: ["use", true], employ: ["use", true], allow: ["allow", true], permit: ["allow", true], accept: ["allow", true], deny: ["allow", false], block: ["allow", false], disallow: ["allow", false], forbid: ["allow", false], reject: ["allow", false], require: ["require", true], enforce: ["require", true], encrypt: ["encrypt", true], cache: ["cache", true], memoize: ["cache", true], validate: ["validate", true], verify: ["validate", true], store: ["store", true], log: ["log", true], record: ["log", true], enable: ["enable", true], disable: ["enable", false] };
function normalized(value: string) { return value.normalize("NFKC").toLowerCase().replace(/[`"']/g, "").replace(/time[ -]+to[ -]+live/g, "ttl").replace(/\s+/g, " ").trim().replace(/^(?:the|an?|all) /, "").replace(/\b(requests|records|responses|tokens|secrets|passwords|guests)\b/g, (word) => word.slice(0, -1)); }
const reference = (entry: MemoryRef): MemoryRef => ({ id: entry.id, revision: entry.revision });
function unit(value: unknown): { name: "count" | "ms" | "bytes"; scale: number } | undefined {
  const text = String(value ?? "count").toLowerCase();
  if (["count", "retry", "retries", "request", "requests"].includes(text)) return { name: "count", scale: 1 };
  if (["ms", "millisecond", "milliseconds"].includes(text)) return { name: "ms", scale: 1 };
  if (["s", "sec", "secs", "second", "seconds"].includes(text)) return { name: "ms", scale: 1000 };
  if (["m", "min", "mins", "minute", "minutes"].includes(text)) return { name: "ms", scale: 60_000 };
  if (["h", "hour", "hours"].includes(text)) return { name: "ms", scale: 3_600_000 };
  if (["b", "byte", "bytes"].includes(text)) return { name: "bytes", scale: 1 };
  const sizes: Record<string, number> = { kb: 1000, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
  return sizes[text] ? { name: "bytes", scale: sizes[text] } : undefined;
}
function numeric(min: number | null, max: number | null, rawUnit: unknown, minInclusive = true, maxInclusive = true): ClaimValue | undefined {
  const dimension = unit(rawUnit); if (!dimension || [min, max].some((number) => number !== null && (!Number.isFinite(number) || Math.abs(number * dimension.scale) > Number.MAX_SAFE_INTEGER)) || min !== null && max !== null && min > max) return;
  return { kind: "number", min: min === null ? null : min * dimension.scale, max: max === null ? null : max * dimension.scale, minInclusive, maxInclusive, unit: dimension.name };
}
function structured(raw: unknown): Pick<MemoryClaim, "subject" | "predicate" | "value"> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["subject", "predicate", "value", "min", "max", "unit"].includes(key)) || typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 120 || typeof input.predicate !== "string" || !/^[a-z][a-z-]{0,39}$/.test(input.predicate)) return;
  let value: ClaimValue | undefined;
  if (input.value !== undefined && (input.min !== undefined || input.max !== undefined)) return;
  if (typeof input.value === "boolean" && input.unit === undefined) value = { kind: "boolean", value: input.value };
  else if (typeof input.value === "string" && input.value.trim() && input.value.length <= 120 && input.unit === undefined) value = { kind: "text", value: normalized(input.value) };
  else if (typeof input.value === "number") value = numeric(input.value, input.value, input.unit);
  else if (input.value === undefined && (typeof input.min === "number" || typeof input.max === "number") && (input.min === undefined || typeof input.min === "number") && (input.max === undefined || typeof input.max === "number")) value = numeric(input.min as number ?? null, input.max as number ?? null, input.unit);
  if (!value) return;
  const action = ACTIONS[input.predicate]; if (value.kind === "boolean" && action && !action[1]) value = { ...value, value: !value.value };
  return { subject: normalized(input.subject), predicate: action?.[0] ?? input.predicate, value };
}
function language(text: string): Pick<MemoryClaim, "subject" | "predicate" | "value"> | undefined {
  const sentence = text.trim().replace(/^[-*]\s+/, "").replace(/[.!]$/, "").trim();
  // Conditional/compound advice needs a human's explicit fact; discarding qualifiers creates false conflicts.
  if (sentence.length > 512 || /\b(if|unless|except|when|until|only|but|or|and|may|might|could)\b|;|\.\s+\p{L}/u.test(sentence.toLowerCase())) return;
  const setting = sentence.match(/^(?:set\s+)?(.{1,100}?)\s*(?:\s+(?:to|is|equals?)\s+|\s*[=:]\s*)(?:(at least|at most|no more than|no less than|>=|<=|>|<)\s*)?(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (setting) { const number = Number(setting[3]), relation = setting[2]?.toLowerCase(); const lower = ["at least", "no less than", ">=", ">"].includes(relation ?? ""), upper = ["at most", "no more than", "<=", "<"].includes(relation ?? ""); const value = numeric(upper ? null : number, lower ? null : number, setting[4], relation !== ">", relation !== "<"); if (value) return { subject: normalized(setting[1]!), predicate: "setting", value }; return; }
  const string = sentence.match(/^(?:set\s+)?(.{1,100}?)\s*(?:\s+(?:to|is|equals?)\s+|\s*[=:]\s*)["'`]([^"'`]{1,120})["'`]$/i);
  if (string) return { subject: normalized(string[1]!), predicate: "setting", value: { kind: "text", value: normalized(string[2]!) } };
  const policy = sentence.match(/^(?:(always|never|do not|don't|must not|should not|cannot)\s+)?(?:(?:must|should)\s+)?(use|utilize|employ|allow|permit|accept|deny|block|disallow|forbid|reject|require|enforce|encrypt|cache|memoize|validate|verify|store|log|record|enable|disable)\s+(.+)$/i);
  if (policy) { const action = ACTIONS[policy[2]!.toLowerCase()]!; const negative = !!policy[1] && policy[1].toLowerCase() !== "always"; return { subject: normalized(policy[3]!), predicate: action[0], value: { kind: "boolean", value: negative ? !action[1] : action[1] } }; }
}
function overlap(a: MemoryEntry, b: MemoryEntry) {
  if (a.applicability.kind === "branch" && b.applicability.kind === "branch" && (a.applicability.branch !== b.applicability.branch || a.applicability.commit && b.applicability.commit && a.applicability.commit !== b.applicability.commit)) return false;
  if (!a.paths.length || !b.paths.length) return true;
  return a.paths.some((left) => b.paths.some((right) => { const a = left.replace(/\/$/, ""), b = right.replace(/\/$/, ""); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }));
}
function compare(a: ClaimValue, b: ClaimValue): "equivalent" | "contradiction" | undefined {
  if (a.kind !== b.kind) return;
  if (a.kind === "boolean" && b.kind === "boolean" || a.kind === "text" && b.kind === "text") return a.value === b.value ? "equivalent" : "contradiction";
  if (a.kind !== "number" || b.kind !== "number" || a.unit !== b.unit) return;
  if (a.min === b.min && a.max === b.max && a.minInclusive === b.minInclusive && a.maxInclusive === b.maxInclusive) return "equivalent";
  const disjoint = (left: typeof a, right: typeof a) => left.max !== null && right.min !== null && (left.max < right.min || left.max === right.min && (!left.maxInclusive || !right.minInclusive));
  if (disjoint(a, b) || disjoint(b, a)) return "contradiction";
}

/** Deterministic claim semantics, with explicit source evidence and no winner selection or memory mutation. */
export function analyzeMemoryClaims(input: { repo: string; projectId: string; entries: readonly MemoryEntry[] }): MemoryClaimsAnalysis {
  const scoped = input.entries.filter((entry) => entry.scope === "project" && entry.repo === input.repo && entry.projectId === input.projectId && entry.status !== "deleted");
  const entries = scoped.slice(0, LIMITS.entries); const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const result: MemoryClaimsAnalysis = { claims: [], findings: [], inspectedEntries: entries.length, unsupported: 0, comparedPairs: 0, truncated: scoped.length > entries.length, limits: { ...LIMITS }, method: "Local claim grammar v1: explicit facts, policy polarity, setting values and normalized numeric intervals. Suggestions require human review; unsupported prose has no semantic correctness guarantee." };
  for (const entry of entries) {
    if (result.claims.length >= LIMITS.claims) { result.truncated = true; break; }
    let count = 0; const body = entry.body.slice(0, LIMITS.bodyChars); if (body.length < entry.body.length) result.truncated = true;
    const add = (claim: ReturnType<typeof structured>, start: number, end: number, method: MemoryClaim["evidence"]["method"]) => { if (!claim) { result.unsupported++; return; } if (count >= LIMITS.claimsPerEntry || result.claims.length >= LIMITS.claims) { result.truncated = true; return; } count++; result.claims.push({ ...claim, source: reference(entry), evidence: { start, end, text: body.slice(start, Math.min(end, start + LIMITS.snippetChars)), method } }); };
    const fenced: Array<[number, number]> = [];
    for (const match of body.matchAll(/```codeflow-claims[ \t]*\r?\n([\s\S]*?)\r?\n```/g)) { const start = match.index!, end = start + match[0].length; fenced.push([start, end]); if (match[1]!.length > LIMITS.structuredChars) { result.truncated = true; result.unsupported++; continue; } try { const value: unknown = JSON.parse(match[1]!); if (!Array.isArray(value) || value.length > LIMITS.claimsPerEntry) { if (Array.isArray(value)) result.truncated = true; result.unsupported++; continue; } for (const fact of value) add(structured(fact), start, end, "structured"); } catch { result.unsupported++; } }
    // Keep exact character offsets. Splitting on periods would corrupt decimals, paths and version strings.
    let start = 0;
    for (const line of body.split(/\n/)) { const end = start + line.length; if (line.trim() && !fenced.some(([a, b]) => start < b && end > a)) { const claim = language(line); add(claim, start, end, claim?.value.kind === "boolean" ? "policy" : "setting"); } start = end + 1; }
  }
  const groups = new Map<string, MemoryClaim[]>(); for (const claim of result.claims) { const key = `${claim.subject}\0${claim.predicate}`; const group = groups.get(key) ?? []; group.push(claim); groups.set(key, group); }
  outer: for (const claims of groups.values()) for (let a = 0; a < claims.length; a++) for (let b = a + 1; b < claims.length; b++) {
    const left = claims[a]!, right = claims[b]!; if (!overlap(byId.get(left.source.id)!, byId.get(right.source.id)!)) continue;
    if (result.comparedPairs >= LIMITS.comparedPairs || result.findings.length >= LIMITS.findings) { result.truncated = true; break outer; } result.comparedPairs++;
    const kind = compare(left.value, right.value); if (!kind || left.source.id === right.source.id && kind !== "contradiction") continue;
    result.findings.push({ a: left.source, b: right.source, kind, subject: left.subject, predicate: left.predicate, left, right, explanation: kind === "equivalent" ? "These supported claims normalize to the same meaning and overlapping applicability. Review their remaining context before combining entries." : "These supported claims impose opposite policy values, different explicit settings, or disjoint numeric constraints in overlapping applicability. Review both source revisions; this does not decide which is correct." });
  }
  return result;
}
