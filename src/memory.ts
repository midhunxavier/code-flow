import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

export type MemoryScope = "private" | "team" | "project";
export type MemoryTrust = "trusted" | "untrusted" | "unknown";
export type MemoryApplicability = { kind: "repository" } | { kind: "branch"; branch: string; commit?: string };
export interface MemoryRef { id: string; revision: number }
export type MemoryRating = "useful" | "irrelevant" | "stale" | "incorrect";
export interface MemoryFeedback {
  id: string;
  revision: number;
  rating: MemoryRating;
  note?: string;
  runId?: string;
  at: number;
  origin: "user";
}

/** These values come from the server/run, never from an agent's output or an HTTP body. */
export type MemoryAuthority =
  | { kind: "user"; repo?: string; projectId?: string; runId?: string }
  | { kind: "run"; repo: string; projectId?: string; runId: string; memberId?: string; lockedDown: boolean; sourceTrust: MemoryTrust; canAcceptTeam?: boolean }
  | { kind: "import"; repo: string; projectId?: string };

export interface MemoryInput {
  scope: MemoryScope;
  repo: string;
  projectId?: string;
  runId?: string;
  memberId?: string;
  title: string;
  body: string;
  tags?: string[];
  paths?: string[];
  applicability?: MemoryApplicability;
  derivedFrom?: MemoryRef[];
  sourceRefs?: string[];
  expiresAt?: number;
  /** Stable logical write identity, e.g. run/task/finding. Replays return the original result. */
  operationId?: string;
}

export interface MemoryOrigin {
  kind: "user" | "run" | "import";
  runId?: string;
  memberId?: string;
  trust: MemoryTrust;
  lockedDown: boolean;
  /** Private material cannot be silently published by a summarizer. */
  private: boolean;
}

export interface MemoryEntry extends Omit<MemoryInput, "derivedFrom" | "tags" | "paths" | "applicability" | "sourceRefs"> {
  id: string;
  revision: number;
  status: "proposed" | "accepted" | "deleted";
  tags: string[];
  paths: string[];
  applicability: MemoryApplicability;
  derivedFrom: MemoryRef[];
  sourceRefs: string[];
  origins: MemoryOrigin[];
  createdAt: number;
  updatedAt: number;
  acceptedBy?: "user" | "verification" | "team" | "owner";
  verification?: MemoryVerification;
  /** Hash only: erased bodies are not retained for replay/deduplication. */
  operationHash?: string;
  /** Durable retries for acceptance writes that completed before their run journal append. */
  acceptanceOperations?: { id: string; expectedRevision: number; resultRevision: number; fingerprint: string }[];
  /** Human relevance feedback is tied to the body revision, never an agent trust upgrade. */
  feedback?: MemoryFeedback[];
  deletedAt?: number;
}

/** Verification must be constructed from runtime check/review evidence, not model claims. */
export interface MemoryVerification {
  passed: boolean;
  commit: string;
  branch?: string;
  merged: boolean;
  evidenceRefs: string[];
}

export interface MemoryQuery {
  repo: string;
  projectId?: string;
  runId?: string;
  memberId?: string;
  scope?: MemoryScope;
  branch?: string;
  commit?: string;
  /** Commits the server has verified as ancestors of the current checkout. */
  allowedCommits?: string[];
  paths?: string[];
  tags?: string[];
  query?: string;
  maxEntries?: number;
  maxChars?: number;
}

export interface MemorySelection {
  entries: MemoryEntry[];
  manifest: {
    included: (MemoryRef & { reason: string })[];
    omitted: (MemoryRef & { reason: string })[];
  };
}

interface MemoryDocument { schemaVersion: 1; entries: MemoryEntry[] }
/** Project knowledge the user curates. Private and team records are bounded per run instead. */
const MAX_ENTRIES = 5_000;
/** Private checkpoints and team records one run may hold, so a looping member cannot fill the store for everyone. */
const MAX_RUN_ENTRIES = 512;
const MAX_BODY = 16_000;
const MAX_FILE = 32 * 1024 * 1024;
const queues = new Map<string, Promise<unknown>>();

/** A revision conflict is actionable: show both versions, rather than overwriting one. */
export class MemoryConflictError extends Error {
  constructor(public readonly current: MemoryEntry) {
    super(`Memory revision conflict: ${current.id} is at revision ${current.revision}`);
    this.name = "MemoryConflictError";
  }
}

/**
 * One server owns this store. A per-file queue also serializes local store instances. Each
 * transaction reads the latest snapshot and fsyncs a replacement before publishing success.
 * No historical bodies or secondary search index remain after redaction/deletion.
 */
export class MemoryStore {
  readonly file: string;
  constructor(file = join(CODEFLOW_HOME, "memory.json")) { this.file = resolve(file); }

  async load(): Promise<void> { await this.read(); }

  async propose(raw: MemoryInput, authority: MemoryAuthority): Promise<MemoryEntry> {
    return this.change((doc) => {
      const input = validateInput(raw);
      if (authority.kind === "run" && input.scope === "project") input.runId ??= authority.runId;
      authorize(input, authority, true);
      const operationHash = hashOperation(input, authority);
      if (input.operationId) {
        const previous = doc.entries.find((e) => e.repo === input.repo && e.projectId === input.projectId && e.operationId === input.operationId);
        if (previous) {
          authorize(previous, authority, true);
          if (previous.operationHash !== operationHash) throw new Error("Memory operation ID was already used for different content");
          return clone(previous);
        }
      }
      const live = doc.entries.filter((entry) => entry.status !== "deleted");
      if (input.scope === "project" && live.filter((entry) => entry.scope === "project").length >= MAX_ENTRIES) throw new Error("Memory limit reached; remove older records before adding more");
      if (input.scope !== "project" && live.filter((entry) => entry.scope !== "project" && entry.runId === input.runId).length >= MAX_RUN_ENTRIES) throw new Error(`This run has reached its limit of ${MAX_RUN_ENTRIES} private and team memory records`);
      const sources = sourceEntries(doc, input.derivedFrom ?? [], input, authority);
      const origins = unionOrigins([origin(authority, input.scope), ...sources.flatMap((e) => e.origins)]);
      preventPrivatePublication(input.scope, origins, authority);
      const now = Date.now();
      const accepted = authority.kind === "user" || (authority.kind === "run" && input.scope === "private");
      const entry: MemoryEntry = {
        ...input, id: `m-${randomUUID()}`, revision: 1, status: accepted ? "accepted" : "proposed",
        tags: input.tags ?? [], paths: input.paths ?? [], applicability: input.applicability ?? { kind: "repository" },
        derivedFrom: input.derivedFrom ?? [], sourceRefs: input.sourceRefs ?? [], origins, createdAt: now, updatedAt: now,
        ...(accepted ? { acceptedBy: authority.kind === "user" ? "user" as const : "owner" as const } : {}),
        ...(input.operationId ? { operationHash } : {}),
      };
      doc.entries.push(entry);
      return clone(entry);
    });
  }

  async revise(id: string, expectedRevision: number, patch: Partial<Pick<MemoryInput, "title" | "body" | "paths" | "tags" | "applicability" | "derivedFrom" | "sourceRefs" | "expiresAt">>, authority: MemoryAuthority, options: { accept?: boolean } = {}): Promise<MemoryEntry> {
    return this.change((doc) => {
      const entry = current(doc, id, expectedRevision, authority, true);
      const input = validateInput({ ...entry, ...patch });
      // A caller cannot remove prior sources and thereby launder tainted content.
      input.derivedFrom = uniqueRefs([...entry.derivedFrom, ...(input.derivedFrom ?? [])]);
      if (input.derivedFrom.some((ref) => ref.id === entry.id)) throw new Error("Memory cannot derive from itself");
      const added = input.derivedFrom.filter((ref) => !entry.derivedFrom.some((old) => old.id === ref.id && old.revision === ref.revision));
      const sources = sourceEntries(doc, added, input, authority);
      const origins = unionOrigins([...entry.origins, origin(authority, entry.scope), ...sources.flatMap((e) => e.origins)]);
      preventPrivatePublication(entry.scope, origins, authority);
      Object.assign(entry, input, { origins });
      if ("expiresAt" in patch && patch.expiresAt === undefined) delete entry.expiresAt;
      // An edit is not an approval. The user's edit keeps an accepted entry accepted (they now
      // vouch for its text) and keeps a proposal a proposal unless they accept it in the same action.
      if (entry.scope === "private") { entry.status = "accepted"; entry.acceptedBy = "owner"; }
      else if (authority.kind === "user") { if (options.accept || entry.status === "accepted") { entry.status = "accepted"; entry.acceptedBy = "user"; } }
      else { entry.status = "proposed"; entry.acceptedBy = undefined; }
      delete entry.verification;
      touch(entry);
      return clone(entry);
    });
  }

  /** Approve this exact revision. Tainted project content always requires the user. */
  async accept(id: string, expectedRevision: number, authority: MemoryAuthority, verification?: MemoryVerification, operationId?: string): Promise<MemoryEntry> {
    return this.change((doc) => {
      const entry = doc.entries.find((candidate) => candidate.id === id);
      if (!entry || entry.status === "deleted") throw new Error("Memory entry not found");
      authorize(entry, authority, true);
      const operation = operationId === undefined ? undefined : text(operationId, 500, "acceptance operation ID");
      const fingerprint = createHash("sha256").update(canonicalJson({ expectedRevision, authority, verification })).digest("hex");
      const previous = operation ? entry.acceptanceOperations?.find((saved) => saved.id === operation) : undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Memory acceptance operation ID was already used for a different approval");
        if (entry.revision !== previous.resultRevision) throw new MemoryConflictError(clone(entry));
        return clone(entry);
      }
      if (entry.revision !== expectedRevision) throw new MemoryConflictError(clone(entry));
      if (operation && (entry.acceptanceOperations?.length ?? 0) >= 128) throw new Error("Memory acceptance operation limit reached");
      approval(entry, authority, verification);
      touch(entry);
      if (operation) (entry.acceptanceOperations ??= []).push({ id: operation, expectedRevision, resultRevision: entry.revision, fingerprint });
      return clone(entry);
    });
  }

  /** Feedback changes retrieval metadata, not the content revision or approval authority. */
  async recordFeedback(id: string, expectedRevision: number, input: { rating: MemoryRating; note?: string; runId?: string }, authority: MemoryAuthority): Promise<MemoryEntry> {
    if (authority.kind !== "user") throw new Error("Only the user can rate reusable knowledge");
    if (!["useful", "irrelevant", "stale", "incorrect"].includes(input.rating)) throw new Error("Unknown memory rating");
    const note = input.note?.trim() ? text(input.note, 1_000, "feedback note") : undefined;
    const runId = input.runId === undefined ? undefined : text(input.runId, 240, "feedback run ID");
    return this.change((doc) => {
      const entry = current(doc, id, expectedRevision, authority, true);
      const feedback = entry.feedback ?? [];
      // One vote per revision and run (or the project inspector), so retries and repeated
      // clicks cannot manufacture popularity. A correction replaces the earlier rating.
      const existing = feedback.find((item) => item.revision === expectedRevision && item.runId === runId);
      if (existing?.rating === input.rating && existing.note === note) return clone(entry);
      const next: MemoryFeedback = { id: existing?.id ?? `mf-${randomUUID()}`, revision: expectedRevision, rating: input.rating, note, runId, at: Date.now(), origin: "user" };
      entry.feedback = [...feedback.filter((item) => item.id !== next.id), next].slice(-64);
      return clone(entry);
    });
  }

  /** Promote team knowledge; branch facts need explicit branch applicability. */
  async promote(id: string, expectedRevision: number, destination: { projectId: string; applicability: MemoryApplicability }, authority: MemoryAuthority, verification?: MemoryVerification): Promise<MemoryEntry> {
    return this.change((doc) => {
      const entry = current(doc, id, expectedRevision, authority, true);
      const candidate = validateInput({ ...entry, scope: "project", projectId: destination.projectId, applicability: destination.applicability });
      authorize(candidate, authority, true);
      Object.assign(entry, candidate);
      preventPrivatePublication("project", entry.origins, authority);
      approval(entry, authority, verification);
      touch(entry);
      return clone(entry);
    });
  }

  /**
   * Redact this entry. Entries that list it in `derivedFrom` keep their own bodies: that list
   * records what was in a member's context (provenance), not text copied from it, and the
   * origins they inherited from it stay. Source agent output in run transcripts, provider
   * conversations and external backups is separate history; this operation does not claim to
   * erase those records.
   */
  async remove(id: string, expectedRevision: number, authority: MemoryAuthority): Promise<MemoryEntry> {
    return this.change((doc) => {
      const entry = current(doc, id, expectedRevision, authority, true);
      redact(entry);
      return clone(entry);
    });
  }

  /** Archiving a run retires its private checkpoints and team records; project knowledge is untouched. */
  async purgeRun(runId: string): Promise<number> {
    return this.change((doc) => {
      let count = 0;
      for (const entry of doc.entries) {
        if (entry.scope === "project" || entry.runId !== runId || entry.status === "deleted") continue;
        redact(entry);
        count++;
      }
      return count;
    });
  }

  /** Inspector includes proposals, but never another member's private records. */
  async list(query: MemoryQuery, authority: MemoryAuthority): Promise<MemoryEntry[]> {
    validateQuery(query, authority);
    const doc = await this.read();
    return doc.entries.filter((entry) => visible(entry, query, authority) && entry.status !== "deleted")
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(clone);
  }

  /** Bounded lexical/path selection. Revisions and exclusions can be shown in the inspector. */
  async retrieve(query: MemoryQuery, authority: MemoryAuthority): Promise<MemorySelection> {
    validateQuery(query, authority);
    const doc = await this.read();
    const selection: MemorySelection = { entries: [], manifest: { included: [], omitted: [] } };
    const maxEntries = bound(query.maxEntries, 8, 1, 32);
    const maxChars = bound(query.maxChars, 8_000, 128, 32_000);
    const words = terms(query.query ?? "");
    const candidates = doc.entries.filter((entry) => visible(entry, query, authority) && entry.status !== "deleted")
      .map((entry) => ({ entry, score: score(entry, query, words) }))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || a.entry.id.localeCompare(b.entry.id));
    let size = 0;
    for (const { entry, score: relevance } of candidates) {
      const ref = { id: entry.id, revision: entry.revision };
      let reason = exclusion(entry, query);
      if (!reason && entry.paths.length && !query.paths?.some((path) => entry.paths.some((prefix) => pathMatches(path, prefix)))) reason = "outside task paths";
      if (!reason && selection.entries.length >= maxEntries) reason = "entry budget";
      if (!reason && size + entry.title.length + entry.body.length > maxChars) reason = "context budget";
      if (reason) { selection.manifest.omitted.push({ ...ref, reason }); continue; }
      selection.entries.push(clone(entry));
      const rated = entry.feedback?.some((feedback) => feedback.revision === entry.revision && feedback.rating === "useful");
      selection.manifest.included.push({ ...ref, reason: rated ? "applicable context with useful user feedback" : relevance > 0 ? "matching task text, tags or paths" : "applicable shared context" });
      size += entry.title.length + entry.body.length;
    }
    return selection;
  }

  /** Resolve a recorded selection without adding newly-created or newer-revision content. */
  async resolveSelection(query: MemoryQuery, manifest: MemorySelection["manifest"], authority: MemoryAuthority): Promise<MemorySelection> {
    validateQuery(query, authority);
    const doc = await this.read();
    const result: MemorySelection = { entries: [], manifest: { included: [], omitted: clone(manifest.omitted) } };
    let size = 0;
    for (const ref of manifest.included) {
      const entry = doc.entries.find((candidate) => candidate.id === ref.id);
      let reason: string | undefined;
      if (!entry || entry.status === "deleted") reason = "recorded memory was deleted";
      else if (!visible(entry, query, authority)) reason = "recorded memory is outside current scope";
      else if (entry.revision !== ref.revision) reason = "recorded memory revision is stale";
      else reason = exclusion(entry, query);
      if (!reason && entry!.paths.length && !query.paths?.some((path) => entry!.paths.some((prefix) => pathMatches(path, prefix)))) reason = "outside task paths";
      if (!reason && (result.entries.length >= bound(query.maxEntries, 8, 1, 32) || size + entry!.title.length + entry!.body.length > bound(query.maxChars, 8_000, 128, 32_000))) reason = "recorded context exceeds current budget";
      if (reason) { result.manifest.omitted.push({ id: ref.id, revision: ref.revision, reason }); continue; }
      result.entries.push(clone(entry!));
      result.manifest.included.push(clone(ref));
      size += entry!.title.length + entry!.body.length;
    }
    return result;
  }

  private async read(): Promise<MemoryDocument> {
    await queues.get(this.file);
    return readDocument(this.file);
  }

  private change<T>(fn: (document: MemoryDocument) => T): Promise<T> {
    const next = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
      const document = await readDocument(this.file);
      const before = JSON.stringify(document);
      const result = fn(document);
      if (JSON.stringify(document) !== before) await writeDocument(this.file, document);
      return result;
    });
    const settled = next.catch(() => undefined);
    queues.set(this.file, settled);
    void settled.then(() => { if (queues.get(this.file) === settled) queues.delete(this.file); });
    return next;
  }
}

export const memoryStore = new MemoryStore();

function redact(entry: MemoryEntry) {
  entry.title = "";
  entry.body = "";
  entry.tags = [];
  entry.paths = [];
  entry.sourceRefs = [];
  delete entry.verification;
  delete entry.acceptedBy;
  delete entry.feedback;
  entry.status = "deleted";
  entry.deletedAt = Date.now();
  touch(entry);
}

function validateInput(raw: MemoryInput): MemoryInput {
  if (!raw || !["private", "team", "project"].includes(raw.scope)) throw new Error("Invalid memory scope");
  if (typeof raw.repo !== "string" || !isAbsolute(raw.repo) || normalize(raw.repo) !== raw.repo) throw new Error("Memory repository must be a normalized absolute path");
  const input: MemoryInput = {
    scope: raw.scope, repo: raw.repo, title: text(raw.title, 200, "title"), body: text(raw.body, MAX_BODY, "body"),
    tags: strings(raw.tags ?? [], 32, 80, "tags"), paths: strings(raw.paths ?? [], 64, 400, "paths").map(relativePath),
    sourceRefs: strings(raw.sourceRefs ?? [], 128, 400, "source references"), derivedFrom: uniqueRefs(raw.derivedFrom ?? []),
    applicability: validateApplicability(raw.applicability ?? { kind: "repository" }),
  };
  for (const key of ["projectId", "runId", "memberId"] as const) if (raw[key] !== undefined) input[key] = text(raw[key], 240, key);
  // The server prefixes the tool's bounded operation ID with run/member/attempt identity.
  if (raw.operationId !== undefined) input.operationId = text(raw.operationId, 500, "operationId");
  if (input.scope === "project" && !input.projectId) throw new Error("Project memory needs a project ID");
  if (input.scope !== "project" && !input.runId) throw new Error("Private/team memory needs a run ID");
  if (input.scope === "private" && !input.memberId) throw new Error("Private memory needs a member ID");
  if (raw.expiresAt !== undefined) {
    if (!Number.isSafeInteger(raw.expiresAt) || raw.expiresAt < 0) throw new Error("Invalid memory expiry");
    input.expiresAt = raw.expiresAt;
  }
  return input;
}

function authorize(entry: Pick<MemoryInput, "repo" | "scope" | "projectId" | "runId" | "memberId">, authority: MemoryAuthority, write: boolean): void {
  if (authority.repo && authority.repo !== entry.repo) throw new Error("Memory repository scope mismatch");
  if (authority.projectId && authority.projectId !== entry.projectId) throw new Error("Memory project scope mismatch");
  if (authority.kind === "user") {
    if (authority.runId && authority.runId !== entry.runId) throw new Error("Memory run scope mismatch");
    return;
  }
  if (authority.kind === "import") {
    if (entry.scope !== "project") throw new Error("Historical observations must be project proposals");
    return;
  }
  if (entry.projectId !== authority.projectId) throw new Error("Memory project scope mismatch");
  if (entry.scope !== "project" && entry.runId !== authority.runId) throw new Error("Memory run scope mismatch");
  if (entry.scope === "private" && (!authority.memberId || entry.memberId !== authority.memberId)) throw new Error("Private memory belongs to another member");
  if (write && entry.scope === "project" && entry.runId !== authority.runId) throw new Error("A run cannot edit another run's project proposal or a user-authored rule");
}

function origin(authority: MemoryAuthority, scope: MemoryScope): MemoryOrigin {
  if (authority.kind === "run") return { kind: "run", runId: authority.runId, memberId: authority.memberId, trust: authority.sourceTrust, lockedDown: authority.lockedDown, private: scope === "private" };
  return { kind: authority.kind, trust: authority.kind === "user" ? "trusted" : "unknown", lockedDown: false, private: scope === "private" };
}

function sourceEntries(doc: MemoryDocument, refs: MemoryRef[], input: MemoryInput, authority: MemoryAuthority): MemoryEntry[] {
  return refs.map((ref) => {
    const entry = doc.entries.find((candidate) => candidate.id === ref.id);
    if (!entry) throw new Error("Memory source does not exist");
    authorize(entry, authority, false);
    // Revisions never discard their origins, and a deleted entry keeps them: a reference to it
    // still inherits the conservative provenance union without loading a body, so deleting a
    // source cannot strand a run that saw it. A future reference cannot be evidence.
    // Retrieval still requires an exact body revision.
    if (entry.status !== "deleted" && entry.revision < ref.revision) throw new MemoryConflictError(clone(entry));
    if (entry.repo !== input.repo || entry.projectId !== input.projectId) throw new Error("Derived memory cannot cross repository/project boundaries");
    return entry;
  });
}

function preventPrivatePublication(scope: MemoryScope, origins: MemoryOrigin[], authority: MemoryAuthority) {
  if (scope !== "private" && authority.kind !== "user" && origins.some((source) => source.private)) throw new Error("Publishing private memory requires an explicit user action");
}

function approval(entry: MemoryEntry, authority: MemoryAuthority, verification?: MemoryVerification) {
  if (authority.kind === "import") throw new Error("Imported observations require verification or user approval");
  if (authority.kind === "user") {
    entry.status = "accepted";
    entry.acceptedBy = "user";
    delete entry.verification;
    return;
  }
  if (entry.scope === "private") { entry.status = "accepted"; entry.acceptedBy = "owner"; return; }
  if (entry.scope === "team") {
    if (!authority.canAcceptTeam) throw new Error("Only the assigned coordinator can accept team contracts");
    entry.status = "accepted";
    entry.acceptedBy = "team";
    return;
  }
  if (authority.lockedDown || authority.sourceTrust !== "trusted" || entry.origins.some((source) => source.lockedDown || source.trust !== "trusted" || source.private)) {
    throw new Error("Untrusted, imported or private project knowledge requires explicit user approval of this revision");
  }
  if (!verification?.passed || !/^[0-9a-f]{40,64}$/i.test(verification.commit) || !verification.evidenceRefs?.length || verification.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error("Project promotion requires passing runtime verification with commit and evidence references");
  }
  if (entry.applicability.kind === "repository" && !verification.merged) throw new Error("Unmerged knowledge must stay team-scoped or explicitly branch-specific");
  if (entry.applicability.kind === "branch") {
    if (!entry.applicability.commit || entry.applicability.branch !== verification.branch || entry.applicability.commit !== verification.commit) throw new Error("Branch knowledge must match the verified branch and commit");
  }
  entry.status = "accepted";
  entry.acceptedBy = "verification";
  entry.verification = clone(verification);
}

function validateQuery(query: MemoryQuery, authority: MemoryAuthority) {
  if (!query || typeof query.repo !== "string" || !isAbsolute(query.repo) || normalize(query.repo) !== query.repo) throw new Error("Memory query needs an absolute repository");
  if (authority.repo && authority.repo !== query.repo) throw new Error("Memory repository scope mismatch");
  if (authority.projectId && authority.projectId !== query.projectId) throw new Error("Memory project scope mismatch");
  if (authority.kind === "run") {
    if (query.projectId !== authority.projectId || (query.runId && query.runId !== authority.runId) || (query.memberId && query.memberId !== authority.memberId)) throw new Error("Memory query scope mismatch");
  }
  if (query.paths) strings(query.paths, 64, 400, "paths").forEach(relativePath);
}

function visible(entry: MemoryEntry, query: MemoryQuery, authority: MemoryAuthority): boolean {
  if (entry.repo !== query.repo || entry.projectId !== query.projectId || (query.scope && entry.scope !== query.scope)) return false;
  if (entry.scope === "private" && (entry.runId !== query.runId || entry.memberId !== query.memberId)) return false;
  if (entry.scope === "team" && entry.runId !== query.runId) return false;
  try { authorize(entry, authority, false); return true; } catch { return false; }
}

function exclusion(entry: MemoryEntry, query: MemoryQuery): string | undefined {
  if (entry.status !== "accepted") return "unaccepted proposal";
  const feedback = entry.feedback?.filter((item) => item.revision === entry.revision) ?? [];
  if (feedback.some((item) => item.rating === "stale" || item.rating === "incorrect")) return "user marked this revision stale or incorrect";
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) return "expired";
  if (entry.applicability.kind === "branch") {
    if (entry.applicability.branch !== query.branch) return "different branch";
    const commit = entry.applicability.commit;
    if (commit && commit !== query.commit && !query.allowedCommits?.includes(commit)) return "unverified commit applicability";
  }
  return undefined;
}

function score(entry: MemoryEntry, query: MemoryQuery, words: Set<string>): number {
  const available = terms(`${entry.title} ${entry.body} ${entry.tags.join(" ")}`);
  let value = 0;
  for (const word of words) if (available.has(word)) value++;
  for (const tag of query.tags ?? []) if (entry.tags.includes(tag)) value += 3;
  for (const path of query.paths ?? []) if (entry.paths.some((prefix) => pathMatches(path, prefix))) value += 5;
  const feedback = entry.feedback?.filter((item) => item.revision === entry.revision) ?? [];
  value += Math.max(-3, Math.min(3, feedback.reduce((sum, item) => sum + (item.rating === "useful" ? 1 : item.rating === "irrelevant" ? -1 : 0), 0)));
  return value;
}

// Auto's explicit '*' ownership covers every path, after repository/project scope checks.
function pathMatches(path: string, prefix: string) { return path === "*" || prefix === "*" || path === prefix || path.startsWith(prefix + "/") || prefix.startsWith(path + "/"); }
function terms(value: string) { return new Set(value.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []); }
function clone<T>(value: T): T { return structuredClone(value); }
function touch(entry: MemoryEntry) { entry.revision++; entry.updatedAt = Date.now(); }
function bound(value: number | undefined, fallback: number, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback; }
function text(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid memory ${name} (1–${max} characters)`);
  return value.trim();
}
function strings(value: unknown, max: number, length: number, name: string): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid memory ${name}`);
  return [...new Set(value.map((item) => text(item, length, name)))];
}
function relativePath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/\/$/, "");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Memory paths must stay inside the repository");
  return path;
}
function validateApplicability(value: MemoryApplicability): MemoryApplicability {
  if (value?.kind === "repository") return { kind: "repository" };
  if (value?.kind !== "branch") throw new Error("Invalid memory applicability");
  const branch = text(value.branch, 240, "branch");
  if (value.commit !== undefined && !/^[0-9a-f]{40,64}$/i.test(value.commit)) throw new Error("Memory applicability needs a full commit SHA");
  return { kind: "branch", branch, ...(value.commit ? { commit: value.commit } : {}) };
}
function uniqueRefs(value: MemoryRef[]): MemoryRef[] {
  if (!Array.isArray(value) || value.length > 1_024) throw new Error("Too many memory derivation references");
  const refs = new Map<string, MemoryRef>();
  for (const ref of value) {
    if (!ref || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error("Invalid memory revision reference");
    const id = text(ref.id, 240, "reference");
    refs.set(`${id}@${ref.revision}`, { id, revision: ref.revision });
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
}
function unionOrigins(origins: MemoryOrigin[]): MemoryOrigin[] {
  return [...new Map(origins.map((source) => [JSON.stringify(source), source])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, source]) => source);
}
function current(doc: MemoryDocument, id: string, revision: number, authority: MemoryAuthority, write = false): MemoryEntry {
  const entry = doc.entries.find((candidate) => candidate.id === id);
  if (!entry || entry.status === "deleted") throw new Error("Memory entry not found");
  // Check scope before returning a conflict containing the current body.
  authorize(entry, authority, write);
  if (entry.revision !== revision) throw new MemoryConflictError(clone(entry));
  return entry;
}
function hashOperation(input: MemoryInput, authority: MemoryAuthority): string {
  return createHash("sha256").update(JSON.stringify({ input, origin: origin(authority, input.scope) })).digest("hex");
}

function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sorted(value)])) : item;
  return JSON.stringify(sorted(value));
}

async function readDocument(file: string): Promise<MemoryDocument> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: [] };
    throw error;
  }
  try {
    if (Buffer.byteLength(raw) > MAX_FILE) throw new Error("file is too large");
    const document: unknown = JSON.parse(raw);
    if (!document || typeof document !== "object") throw new Error("invalid document");
    const doc = document as MemoryDocument;
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.entries) || doc.entries.filter((entry) => entry?.status !== "deleted" && entry?.scope === "project").length > MAX_ENTRIES) throw new Error("unsupported schema");
    const ids = new Set<string>();
    for (const entry of doc.entries) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || ids.has(entry.id) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !["proposed", "accepted", "deleted"].includes(entry.status)) throw new Error("invalid entry");
      ids.add(entry.id);
      validateInput(entry.status === "deleted" ? { ...entry, title: "deleted", body: "deleted" } : entry);
      if (!Array.isArray(entry.origins) || !entry.origins.length || entry.origins.some((source) => !source || !["user", "run", "import"].includes(source.kind) || !["trusted", "untrusted", "unknown"].includes(source.trust) || typeof source.lockedDown !== "boolean" || typeof source.private !== "boolean")) throw new Error("invalid provenance");
      if (!Array.isArray(entry.paths) || !Array.isArray(entry.tags) || !Array.isArray(entry.derivedFrom) || !Array.isArray(entry.sourceRefs) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) throw new Error("incomplete entry");
      if (entry.acceptanceOperations !== undefined && (!Array.isArray(entry.acceptanceOperations) || entry.acceptanceOperations.length > 128 || entry.acceptanceOperations.some((operation) => !operation || typeof operation.id !== "string" || !operation.id || operation.id.length > 500 || !Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 1 || operation.resultRevision !== operation.expectedRevision + 1 || typeof operation.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(operation.fingerprint)))) throw new Error("invalid acceptance operation");
    }
    return doc;
  } catch (error) {
    throw new Error(`Memory store cannot be read; no records were changed: ${(error as Error).message}`);
  }
}

async function writeDocument(file: string, document: MemoryDocument): Promise<void> {
  const body = JSON.stringify(document);
  if (Buffer.byteLength(body) > MAX_FILE) throw new Error("Memory storage limit reached");
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  // A process killed before rename may leave a complete body in a temporary snapshot.
  // The server is the sole writer; clean those copies before any new durable mutation,
  // including a deletion, so erased material cannot survive in a stale temp file.
  const prefix = `${basename(file)}.`;
  for (const name of await readdir(dir)) {
    if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) await rm(join(dir, name), { force: true });
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}
