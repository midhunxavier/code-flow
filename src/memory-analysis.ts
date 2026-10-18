import { createHash } from "node:crypto";
import { basename } from "node:path";
import { git } from "./git.js";
import type { MemoryEntry, MemoryRef } from "./memory.js";

export interface MemoryAnalysisInput {
  repo: string;
  projectId: string;
  entries: MemoryEntry[];
  head?: string;
  branch?: string;
  signal?: AbortSignal;
  now?: number;
}
export interface MemoryAnalysis {
  scope: { repo: string; projectId: string };
  git: { head?: string; branch?: string; available: boolean };
  graph: {
    nodes: { key: string; id: string; revision: number; title?: string; status?: MemoryEntry["status"]; available: boolean }[];
    edges: { from: string; to: string }[];
  };
  deletionImpact: { id: string; revision: number; direct: MemoryRef[]; transitive: MemoryRef[]; retained: string }[];
  stale: { id: string; revision: number; reasons: { kind: "expired" | "feedback" | "missing-path" | "branch-mismatch" | "commit-unavailable" | "commit-not-ancestor" | "paths-changed"; detail: string }[] }[];
  duplicates: { a: MemoryRef; b: MemoryRef; kind: "exact" | "lexical-overlap"; similarity: number }[];
  onboarding: { title: string; body: string; sourceRefs: MemoryRef[]; omitted: number; reasons: { id: string; reason: string }[] };
  limits: { entries: number; references: number; paths: number; commitBaselines: number; comparedPairs: number; duplicatePairs: number; onboardingEntries: number; onboardingChars: number };
  truncated: boolean;
  notes: string[];
}

const LIMITS = { entries: 500, references: 5000, paths: 1000, commitBaselines: 16, comparedPairs: 50_000, duplicatePairs: 100, onboardingEntries: 12, onboardingChars: 12_000 };
const RETENTION = "Deleting erases this entry's text and stops its future retrieval. Derived entries retain their own text and provenance. Source run transcripts, provider conversations and backups have separate retention.";
const ref = (entry: MemoryRef): MemoryRef => ({ id: entry.id, revision: entry.revision });
const key = (entry: MemoryRef) => `${entry.id}@${entry.revision}`;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const digest = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");

/**
 * Read-only, bounded evidence about already authorized project knowledge. No LLM, history
 * recovery, private-entry lookup or automatic publication occurs in this service.
 */
export async function analyzeProjectMemory(input: MemoryAnalysisInput): Promise<MemoryAnalysis> {
  const scoped = input.entries.filter((entry) => entry.scope === "project" && entry.repo === input.repo && entry.projectId === input.projectId && entry.status !== "deleted")
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const entries = scoped.slice(0, LIMITS.entries);
  const now = input.now ?? Date.now();
  const result: MemoryAnalysis = {
    scope: { repo: input.repo, projectId: input.projectId }, git: { available: false }, graph: { nodes: [], edges: [] }, deletionImpact: [], stale: [], duplicates: [],
    onboarding: { title: `Project onboarding · ${basename(input.repo)}`.slice(0, 200), body: "", sourceRefs: [], omitted: 0, reasons: [] },
    limits: { ...LIMITS }, truncated: entries.length !== scoped.length, notes: [],
  };
  const nodes = new Map<string, MemoryAnalysis["graph"]["nodes"][number]>();
  const reverse = new Map<string, Set<string>>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) nodes.set(key(entry), { key: key(entry), ...ref(entry), title: entry.title, status: entry.status, available: true });
  let references = 0;
  for (const entry of entries) {
    for (const source of entry.derivedFrom) {
      if (references++ >= LIMITS.references) { result.truncated = true; break; }
      if (!nodes.has(key(source))) nodes.set(key(source), { key: key(source), ...ref(source), available: false });
      result.graph.edges.push({ from: key(source), to: key(entry) });
      const derived = reverse.get(source.id) ?? new Set<string>();
      derived.add(entry.id); reverse.set(source.id, derived);
    }
  }
  result.graph.nodes = [...nodes.values()];
  for (const entry of entries) {
    const descendants = new Set<string>();
    const queue = [...(reverse.get(entry.id) ?? [])];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      if (id === entry.id || descendants.has(id)) continue;
      descendants.add(id);
      queue.push(...(reverse.get(id) ?? []));
    }
    const refs = (ids: Iterable<string>) => [...ids].flatMap((id) => byId.has(id) ? [ref(byId.get(id)!)] : []).sort((a, b) => a.id.localeCompare(b.id));
    result.deletionImpact.push({ ...ref(entry), direct: refs(reverse.get(entry.id) ?? []), transitive: refs(descendants), retained: RETENTION });
  }

  const stale = new Map<string, MemoryAnalysis["stale"][number]>();
  const incomplete = new Set<string>();
  const add = (entry: MemoryEntry, kind: MemoryAnalysis["stale"][number]["reasons"][number]["kind"], detail: string) => {
    const current = stale.get(entry.id) ?? { ...ref(entry), reasons: [] };
    current.reasons.push({ kind, detail }); stale.set(entry.id, current);
  };
  for (const entry of entries) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) add(entry, "expired", "The entry's expiry has passed.");
    for (const feedback of entry.feedback ?? []) if (feedback.revision === entry.revision && ["stale", "incorrect"].includes(feedback.rating)) add(entry, "feedback", `You marked this revision ${feedback.rating}${feedback.note ? `: ${feedback.note}` : "."}`);
  }
  const readGit = (args: string[]) => git(["--literal-pathspecs", ...args], input.repo, { signal: input.signal, timeoutMs: 2_000 });
  const [headResult, branchResult] = await Promise.all([
    readGit(["rev-parse", "--verify", "--end-of-options", `${input.head ?? "HEAD"}^{commit}`]),
    input.branch ? Promise.resolve({ code: 0, stdout: input.branch }) : readGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ]);
  const head = headResult.code === 0 && /^[a-f0-9]{40,64}$/.test(headResult.stdout.trim()) ? headResult.stdout.trim() : undefined;
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
  result.git = { ...(head ? { head } : {}), ...(branch ? { branch } : {}), available: !!head };
  if (!head) {
    result.notes.push("Git evidence is unavailable; only expiry and revision feedback were evaluated.");
    for (const entry of entries) if (entry.paths.length || entry.verification?.commit || (entry.applicability.kind === "branch" && entry.applicability.commit)) incomplete.add(entry.id);
  }
  if (head) {
    const allPaths = [...new Set(entries.flatMap((entry) => entry.paths))];
    const paths = allPaths.slice(0, LIMITS.paths);
    const checkedPaths = new Set(paths);
    if (paths.length !== allPaths.length) result.truncated = true;
    const tree = paths.length ? await readGit(["ls-tree", "--name-only", "-r", "-z", head, "--", ...paths]) : undefined;
    const listed = tree?.code === 0 ? tree.stdout.split("\0").filter(Boolean) : undefined;
    const present = listed && listed.length <= 20_000 ? new Set(listed) : undefined;
    if (listed && !present) result.truncated = true;
    if (present) for (const file of [...present]) {
      const parts = file.split("/");
      for (let index = 1; index < parts.length; index++) present.add(parts.slice(0, index).join("/"));
    }
    if (tree && !present) result.notes.push("Path existence could not be checked at the selected commit.");
    for (const entry of entries) {
      if (entry.paths.some((path) => !checkedPaths.has(path)) || (entry.paths.length && !present)) incomplete.add(entry.id);
      if (entry.applicability.kind === "branch" && branch && entry.applicability.branch !== branch) add(entry, "branch-mismatch", `This entry applies to ${entry.applicability.branch}; the selected branch is ${branch}.`);
      if (present) for (const path of entry.paths) {
        if (!checkedPaths.has(path)) continue;
        if (!present.has(path.replace(/\/$/, ""))) add(entry, "missing-path", `${path} is absent at ${head.slice(0, 12)}.`);
      }
    }
    const baselines = [...new Set(entries.flatMap((entry) => [entry.verification?.commit, entry.applicability.kind === "branch" ? entry.applicability.commit : undefined]).filter((value): value is string => !!value))];
    const checkedBaselines = new Set(baselines.slice(0, LIMITS.commitBaselines));
    if (baselines.length > LIMITS.commitBaselines) result.truncated = true;
    for (const entry of entries) if ((entry.verification?.commit && !checkedBaselines.has(entry.verification.commit)) || (entry.applicability.kind === "branch" && entry.applicability.commit && !checkedBaselines.has(entry.applicability.commit))) incomplete.add(entry.id);
    for (let index = 0; index < Math.min(baselines.length, LIMITS.commitBaselines); index += 4) {
      const observed = await Promise.all(baselines.slice(index, Math.min(index + 4, LIMITS.commitBaselines)).map(async (base) => {
        const exists = /^[a-f0-9]{40,64}$/i.test(base) ? await readGit(["cat-file", "-e", `${base}^{commit}`]) : { code: 1 };
        if (exists.code !== 0) return { base, state: "missing" as const };
        const ancestor = await readGit(["merge-base", "--is-ancestor", base, head]);
        if (ancestor.code === 1) return { base, state: "diverged" as const };
        if (ancestor.code !== 0) return { base, state: "unknown" as const };
        const diff = paths.length ? await readGit(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, head, "--", ...paths]) : undefined;
        return { base, state: "ancestor" as const, changed: diff?.code === 0 ? diff.stdout.split("\0").filter(Boolean) : [], incomplete: !!diff && diff.code !== 0 };
      }));
      for (const observation of observed) for (const entry of entries) {
        if (entry.verification?.commit !== observation.base && (entry.applicability.kind !== "branch" || entry.applicability.commit !== observation.base)) continue;
        if (observation.state === "missing") add(entry, "commit-unavailable", `Recorded commit ${observation.base.slice(0, 12)} is unavailable.`);
        else if (observation.state === "diverged") add(entry, "commit-not-ancestor", `Recorded commit ${observation.base.slice(0, 12)} is not an ancestor of the selected checkout.`);
        else if (observation.state === "ancestor") {
          if (observation.incomplete) incomplete.add(entry.id);
          const changed = observation.changed.filter((path) => entry.paths.some((scope) => path === scope || path.startsWith(scope.replace(/\/$/, "") + "/")));
          if (changed.length) add(entry, "paths-changed", `Relevant paths changed since ${observation.base.slice(0, 12)}: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", …" : ""}. Review this guidance; a code change does not prove it incorrect.`);
        } else incomplete.add(entry.id);
      }
    }
  }
  result.stale = [...stale.values()];

  const words = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word)).slice(0, 200));
  const bodies = entries.map((entry) => ({ hash: digest(entry.body), words: words(entry.body) }));
  let pairs = 0;
  outer: for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    if (++pairs > LIMITS.comparedPairs || result.duplicates.length >= LIMITS.duplicatePairs) { result.truncated = true; break outer; }
    if (bodies[a]!.hash === bodies[b]!.hash) result.duplicates.push({ a: ref(entries[a]!), b: ref(entries[b]!), kind: "exact", similarity: 1 });
    else {
      const left = bodies[a]!.words, right = bodies[b]!.words;
      const overlap = [...left].filter((word) => right.has(word)).length;
      const similarity = overlap / (left.size + right.size - overlap || 1);
      if (overlap >= 5 && similarity >= 0.65) result.duplicates.push({ a: ref(entries[a]!), b: ref(entries[b]!), kind: "lexical-overlap", similarity: Math.round(similarity * 1000) / 1000 });
    }
  }
  result.notes.push("Overlap is a lexical review hint; it does not detect semantic contradictions or decide which guidance is correct.");
  result.notes.push("Path changes require a recorded commit baseline. User guidance without one is checked for missing paths, expiry and feedback only.");
  const onboarding: string[] = ["# Project onboarding", "Curated from accepted guidance written by you. Review the sources and applicability before using it."];
  let size = onboarding.join("\n\n").length;
  const curated = [...entries].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  for (const entry of curated) {
    const reason = entry.status !== "accepted" || entry.acceptedBy !== "user" ? "Not accepted by you"
      : !entry.origins.length || entry.origins.some((origin) => origin.kind !== "user" || origin.trust !== "trusted" || origin.lockedDown || origin.private) ? "Includes run, imported, private or untrusted origins"
      : stale.has(entry.id) ? "Needs applicability or freshness review"
      : entry.applicability.kind === "branch" && !branch ? "Selected branch is unknown"
      : incomplete.has(entry.id) ? "Freshness checks were unavailable or reached a limit"
      : entry.tags.includes("onboarding-summary") ? "Already an onboarding summary" : undefined;
    if (reason) { result.onboarding.reasons.push({ id: entry.id, reason }); continue; }
    const scope = entry.applicability.kind === "branch" ? `\n\nApplies to branch ${entry.applicability.branch}${entry.applicability.commit ? ` at ${entry.applicability.commit}` : ""}.` : "";
    const section = `## ${entry.title}\n\n${entry.body}${scope}\n\nSource: ${entry.id} (revision ${entry.revision}).`;
    if (result.onboarding.sourceRefs.length >= LIMITS.onboardingEntries || size + section.length + 2 > LIMITS.onboardingChars) { result.onboarding.reasons.push({ id: entry.id, reason: "Onboarding summary size limit" }); result.truncated = true; continue; }
    onboarding.push(section); size += section.length + 2; result.onboarding.sourceRefs.push(ref(entry));
  }
  result.onboarding.body = result.onboarding.sourceRefs.length ? onboarding.join("\n\n") : "";
  result.onboarding.omitted = scoped.length - result.onboarding.sourceRefs.length;
  return result;
}

const STOP_WORDS = new Set(["the", "and", "that", "this", "with", "from", "for", "before", "after", "should", "must", "use", "using", "when", "into", "are", "you", "your"]);
