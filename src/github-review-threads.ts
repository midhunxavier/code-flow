import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { redactExport } from "./privacy.js";
import { githubGraphql } from "./github.js";

export type GithubGraphql = (repo: string, host: string, query: string, variables: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }) => Promise<any>;
export interface ReviewThreadComment { id: string; author: string; body: string; createdAt: string; updatedAt: string; url?: string; replyTo?: string; bodyTruncated: boolean; trusted: false }
export interface ReviewThread {
  id: string; revision: string; path: string; line?: number; startLine?: number; originalLine?: number; originalStartLine?: number; side: "LEFT" | "RIGHT"; startSide?: "LEFT" | "RIGHT";
  resolved: boolean; outdated: boolean; resolvedBy?: string; canResolve: boolean; canUnresolve: boolean; comments: ReviewThreadComment[]; totalComments: number; commentsTruncated: boolean;
}
export interface ReviewThreadsPage { snapshotId: string; prId: string; url: string; number: number; head: string; state: string; threads: ReviewThread[]; totalThreads: number; truncated: boolean; textTruncated: boolean; expiresAt: number; trusted: false }
export class ReviewThreadError extends Error { constructor(message: string, readonly status: 400 | 403 | 409 | 502 = 400, readonly ambiguous = false) { super(message); } }
interface Target { repo: string; host: string; owner: string; name: string; number: number; url: string }
interface Snapshot { id: string; target: Target; prId: string; head: string; expiresAt: number; threads: Map<string, { revision: string; complete: boolean }> }
const ID = /^[A-Za-z0-9_=-]{1,200}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const TTL = 20 * 60_000;
const THREAD_FIELDS = "id path line startLine originalLine originalStartLine diffSide startDiffSide isResolved isOutdated resolvedBy{login} viewerCanResolve viewerCanUnresolve";
const COMMENT_FIELDS = "id body createdAt updatedAt url author{login} replyTo{id}";
const PAGE_INFO = "pageInfo{hasNextPage endCursor} totalCount";
const LIST_QUERY = `query CodeflowReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){id number url state headRefOid reviewThreads(first:25,after:$after){nodes{${THREAD_FIELDS} comments(first:10){nodes{${COMMENT_FIELDS}} ${PAGE_INFO}}} ${PAGE_INFO}}}}}`;
const THREAD_QUERY = `query CodeflowReviewThread($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{${THREAD_FIELDS} pullRequest{id number url state headRefOid} comments(first:25,after:$after){nodes{${COMMENT_FIELDS}} ${PAGE_INFO}}}}}`;
const mutation = (resolved: boolean) => `mutation CodeflowSetReviewThread($id:ID!,$clientMutationId:String!){${resolved ? "resolveReviewThread" : "unresolveReviewThread"}(input:{threadId:$id,clientMutationId:$clientMutationId}){thread{id isResolved}}}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
const line = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function identity(value: unknown, field: string) { if (typeof value !== "string" || !ID.test(value)) throw new ReviewThreadError(`GitHub returned an invalid ${field}`, 502); return value; }
function connection(value: unknown, cap: number) {
  if (!object(value) || !Array.isArray(value.nodes) || value.nodes.length > cap || !object(value.pageInfo) || typeof value.pageInfo.hasNextPage !== "boolean" || !Number.isSafeInteger(value.totalCount) || value.totalCount < value.nodes.length || value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== "string" || !value.pageInfo.endCursor || value.pageInfo.endCursor.length > 2000)) throw new ReviewThreadError("GitHub returned an invalid bounded connection", 502);
  return value as { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor?: string }; totalCount: number };
}
function pr(value: unknown, target: Target) {
  if (!object(value) || value.number !== target.number || typeof value.headRefOid !== "string" || !SHA.test(value.headRefOid) || !["OPEN", "CLOSED", "MERGED"].includes(value.state) || value.url !== target.url) throw new ReviewThreadError("GitHub pull request identity does not match this run", 409);
  return { id: identity(value.id, "pull request ID"), head: value.headRefOid, state: value.state as string };
}
function threadIdentity(raw: any) {
  if (!object(raw) || typeof raw.path !== "string" || raw.path.length > 2000 || !["LEFT", "RIGHT"].includes(raw.diffSide) || typeof raw.isResolved !== "boolean" || typeof raw.isOutdated !== "boolean" || typeof raw.viewerCanResolve !== "boolean" || typeof raw.viewerCanUnresolve !== "boolean") throw new ReviewThreadError("GitHub returned an invalid review thread", 502);
  return { id: identity(raw.id, "thread ID"), path: raw.path, line: line(raw.line), startLine: line(raw.startLine), originalLine: line(raw.originalLine), originalStartLine: line(raw.originalStartLine), side: raw.diffSide as "LEFT" | "RIGHT", startSide: ["LEFT", "RIGHT"].includes(raw.startDiffSide) ? raw.startDiffSide as "LEFT" | "RIGHT" : undefined, resolved: raw.isResolved, outdated: raw.isOutdated, resolvedBy: text(raw.resolvedBy?.login, 100) || undefined, canResolve: raw.viewerCanResolve, canUnresolve: raw.viewerCanUnresolve };
}
function commentIdentity(raw: any) {
  if (!object(raw) || typeof raw.body !== "string" || raw.body.length > 256 * 1024 || typeof raw.updatedAt !== "string" || typeof raw.createdAt !== "string") throw new ReviewThreadError("GitHub returned an invalid bounded review comment", 502);
  let url: string | undefined; try { const parsed = new URL(text(raw.url, 2000)); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.href; } catch { /* A missing/deleted comment URL is displayed without a link. */ }
  return { id: identity(raw.id, "comment ID"), author: text(raw.author?.login, 100), body: raw.body, createdAt: raw.createdAt, updatedAt: raw.updatedAt, url, replyTo: raw.replyTo ? identity(raw.replyTo.id, "reply ID") : undefined };
}
function present(raw: any, comments: any[], totalComments: number, complete: boolean, budget: { remaining: number; truncated: boolean }): ReviewThread {
  const info = threadIdentity(raw), originals = comments.map(commentIdentity);
  if (new Set(originals.map((comment) => comment.id)).size !== originals.length) throw new ReviewThreadError("GitHub repeated a review comment while paginating; refresh the thread", 409);
  const revision = hash({ ...info, totalComments, comments: originals });
  return { ...info, revision, totalComments, commentsTruncated: !complete, comments: originals.map((comment) => { const limit = Math.max(0, Math.min(8000, budget.remaining)), body = redactExport(comment.body).slice(0, limit), bodyTruncated = body.length < comment.body.length; budget.remaining -= body.length; budget.truncated ||= bodyTruncated; return { ...comment, body, bodyTruncated, trusted: false }; }) };
}

/** Explicit owner actions only. Remote discussion remains untrusted reference data. */
export class GithubReviewThreads {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly busy = new Set<string>();
  constructor(private readonly graphql: GithubGraphql = githubGraphql, private readonly now = Date.now) {}
  private async target(repo: string, url: string): Promise<Target> {
    let parsed: URL; try { parsed = new URL(url); } catch { throw new ReviewThreadError("This run has no valid GitHub pull request URL"); }
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})\/?$/);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !match || !/^[a-z0-9.-]+$/i.test(parsed.hostname)) throw new ReviewThreadError("Use this run's stored HTTPS GitHub pull request URL");
    return { repo: await realpath(repo), host: parsed.host, owner: match[1]!, name: match[2]!, number: Number(match[3]), url: parsed.href.replace(/\/$/, "") };
  }
  private prune(reserve = false) { for (const [id, item] of this.snapshots) if (item.expiresAt <= this.now()) this.snapshots.delete(id); while (this.snapshots.size > (reserve ? 199 : 200)) this.snapshots.delete(this.snapshots.keys().next().value!); }
  private async query(target: Target, query: string, variables: Record<string, unknown>, signal?: AbortSignal) { signal?.throwIfAborted(); return this.graphql(target.repo, target.host, query, variables, { signal, timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 }); }
  private async snapshot(repo: string, url: string, id: string) { this.prune(); const item = this.snapshots.get(id), target = await this.target(repo, url); if (!item || item.target.repo !== target.repo || item.target.url !== target.url) throw new ReviewThreadError("Review thread snapshot expired or belongs to another run repository. Refresh the threads.", 409); return item; }
  async list(repo: string, url: string, signal?: AbortSignal): Promise<ReviewThreadsPage> {
    const target = await this.target(repo, url), threads: ReviewThread[] = [], budget = { remaining: 2 * 1024 * 1024, truncated: false }, seen = new Set<string>();
    let initial: ReturnType<typeof pr> | undefined, after: string | undefined, totalThreads = 0, truncated = false;
    for (let page = 0; page < 4; page++) {
      const data = await this.query(target, LIST_QUERY, { owner: target.owner, name: target.name, number: target.number, after: after ?? null }, signal), raw = data.repository?.pullRequest, info = pr(raw, target);
      if (initial && (initial.head !== info.head || initial.id !== info.id || initial.state !== info.state)) throw new ReviewThreadError("The pull request changed while threads were loading. Refresh before reviewing.", 409); initial ??= info;
      const list = connection(raw.reviewThreads, 25); totalThreads = list.totalCount;
      for (const rawThread of list.nodes) { const comments = connection(rawThread.comments, 10), thread = present(rawThread, comments.nodes, comments.totalCount, !comments.pageInfo.hasNextPage && comments.nodes.length === comments.totalCount, budget); if (seen.has(thread.id)) throw new ReviewThreadError("GitHub repeated a thread while paginating; refresh the list", 409); seen.add(thread.id); threads.push(thread); }
      if (!list.pageInfo.hasNextPage) break; if (after === list.pageInfo.endCursor) throw new ReviewThreadError("GitHub repeated the review thread cursor", 502); after = list.pageInfo.endCursor; truncated = page === 3;
    }
    this.prune(true); const snapshot: Snapshot = { id: randomBytes(20).toString("hex"), target, prId: initial!.id, head: initial!.head, expiresAt: this.now() + TTL, threads: new Map(threads.map((thread) => [thread.id, { revision: thread.revision, complete: !thread.commentsTruncated }])) }; this.snapshots.set(snapshot.id, snapshot);
    return { snapshotId: snapshot.id, prId: snapshot.prId, url: target.url, number: target.number, head: snapshot.head, state: initial!.state, threads, totalThreads, truncated, textTruncated: budget.truncated, expiresAt: snapshot.expiresAt, trusted: false };
  }
  private async current(snapshot: Snapshot, id: string, signal?: AbortSignal, requireOpen = false) {
    let raw: any, comments: any[] = [], after: string | undefined, total = 0, meta: string | undefined;
    for (let page = 0; page < 4; page++) {
      const data = await this.query(snapshot.target, THREAD_QUERY, { id, after: after ?? null }, signal), item = data.node;
      const info = pr(item?.pullRequest, snapshot.target); if (info.id !== snapshot.prId || info.head !== snapshot.head || requireOpen && info.state !== "OPEN") throw new ReviewThreadError("The pull request head or state changed. Refresh before changing thread resolution.", 409);
      const identity = threadIdentity(item); if (identity.id !== id) throw new ReviewThreadError("GitHub returned a different review thread", 409); const serialized = JSON.stringify(identity), list = connection(item.comments, 25);
      if (meta !== undefined && (meta !== serialized || total !== list.totalCount)) throw new ReviewThreadError("The review thread changed while its replies were loading. Refresh it.", 409); meta = serialized; total = list.totalCount; raw = item; comments.push(...list.nodes);
      if (!list.pageInfo.hasNextPage) return present(raw, comments, total, comments.length === total, { remaining: 800_000, truncated: false });
      if (after === list.pageInfo.endCursor) throw new ReviewThreadError("GitHub repeated the review comment cursor", 502); after = list.pageInfo.endCursor;
    }
    return present(raw, comments, total, false, { remaining: 800_000, truncated: false });
  }
  async detail(repo: string, url: string, input: { snapshotId: string; threadId: string }, signal?: AbortSignal) {
    const snapshot = await this.snapshot(repo, url, input.snapshotId); if (!snapshot.threads.has(input.threadId)) throw new ReviewThreadError("This thread was not in the server-issued snapshot", 409);
    const thread = await this.current(snapshot, input.threadId, signal); snapshot.threads.set(thread.id, { revision: thread.revision, complete: !thread.commentsTruncated }); return thread;
  }
  async setResolved(repo: string, url: string, input: { snapshotId: string; threadId: string; expectedHead: string; expectedRevision: string; resolved: boolean }, signal?: AbortSignal): Promise<{ applied: true; refreshRequired: true; thread?: ReviewThread; warning?: string }> {
    if (!input || typeof input.snapshotId !== "string" || typeof input.threadId !== "string" || !ID.test(input.threadId) || !SHA.test(input.expectedHead) || !/^[a-f0-9]{64}$/.test(input.expectedRevision) || typeof input.resolved !== "boolean") throw new ReviewThreadError("Provide a current server snapshot, exact PR head, thread revision and explicit resolution state");
    const snapshot = await this.snapshot(repo, url, input.snapshotId), key = `${snapshot.target.repo}:${snapshot.prId}:${input.threadId}`;
    if (this.busy.has(key)) throw new ReviewThreadError("This thread already has a resolution action in progress", 409); this.busy.add(key);
    try {
      const selected = snapshot.threads.get(input.threadId); if (!selected || snapshot.head !== input.expectedHead || selected.revision !== input.expectedRevision || !selected.complete) throw new ReviewThreadError("Refresh the complete current thread before changing its resolution", 409);
      const current = await this.current(snapshot, input.threadId, signal, true); if (current.commentsTruncated || current.revision !== selected.revision) throw new ReviewThreadError("The thread or its replies changed. Review the fresh discussion before changing resolution.", 409);
      if (current.resolved === input.resolved) throw new ReviewThreadError("The thread already has that resolution state. Refresh it.", 409);
      if (input.resolved ? !current.canResolve : !current.canUnresolve) throw new ReviewThreadError("Your current GitHub login cannot change this thread's resolution", 403);
      // Invalidate all prior snapshots before issuing a mutation: unknown network outcomes must never replay it.
      for (const [id, saved] of this.snapshots) if (saved.target.repo === snapshot.target.repo && saved.prId === snapshot.prId) this.snapshots.delete(id);
      let response: any;
      try { response = await this.query(snapshot.target, mutation(input.resolved), { id: input.threadId, clientMutationId: randomBytes(16).toString("hex") }, signal); }
      catch (error) { throw new ReviewThreadError(`GitHub resolution outcome may be ambiguous. Refresh the thread before another action. ${(error as Error).message}`, 502, true); }
      const changed = response?.[input.resolved ? "resolveReviewThread" : "unresolveReviewThread"]?.thread;
      if (changed?.id !== input.threadId || changed?.isResolved !== input.resolved) throw new ReviewThreadError("GitHub did not confirm the requested resolution; refresh before another action", 502, true);
      try { const thread = await this.current(snapshot, input.threadId, signal, true); return { applied: true as const, thread, refreshRequired: true as const, ...(thread.resolved !== input.resolved ? { warning: "GitHub changed this thread again after the action. Refresh its current state." } : {}) }; }
      catch { return { applied: true as const, refreshRequired: true as const, warning: "GitHub confirmed the action, but its current head or thread state could not be rechecked. Refresh before further actions." }; }
    } finally { this.busy.delete(key); }
  }
}
