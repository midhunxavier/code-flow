import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CODEFLOW_HOME } from "./config.js";
import { redactExport } from "./privacy.js";

export interface CollaborationActor { id: string; name: string }
export interface CollaborationComment { id: string; branch: string; head: string; text: string; actor: CollaborationActor; at: number }
export interface CollaborationThread { version: 1; revision: number; comments: CollaborationComment[] }
export class CollaborationReviewError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const queues = new Map<string, Promise<unknown>>();
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validHead = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
function actor(value: CollaborationActor): CollaborationActor { if (!value || typeof value.id !== "string" || !/^(?:owner|shared:[a-zA-Z0-9_-]{1,100})$/.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || /[\x00-\x1f\x7f]/.test(value.name)) throw new CollaborationReviewError("A server-authenticated review identity is required"); return { id: value.id, name: value.name.trim() }; }
function branch(value: unknown): string { if (typeof value !== "string" || !value || value.length > 250 || /[\x00-\x20\x7f]/.test(value)) throw new CollaborationReviewError("Choose a result branch"); return value; }
/** Separate from run notes: comments are human collaboration records and never enter an agent's prompt. */
export class CollaborationReviews {
  constructor(private readonly home = CODEFLOW_HOME) {}
  private path(runId: string) { if (!validId(runId)) throw new CollaborationReviewError("Invalid run identity"); return join(this.home, "shared-reviews", `${runId}.json`); }
  async list(runId: string): Promise<CollaborationThread> { return redactExport(await this.read(runId)); }
  private async read(runId: string): Promise<CollaborationThread> {
    const file = this.path(runId); let source: string;
    try { const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid comment storage"); source = await handle.readFile("utf8"); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, comments: [] }; throw new CollaborationReviewError("Review comments cannot be read; existing records were left untouched", 503); }
    try {
      const value = JSON.parse(source) as CollaborationThread;
      if (Object.keys(value).some((key) => !["version", "revision", "comments"].includes(key)) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.comments) || value.comments.length > 200) throw new Error("Invalid thread");
      for (const comment of value.comments) { if (!comment || Object.keys(comment).some((key) => !["id", "branch", "head", "text", "actor", "at"].includes(key)) || typeof comment.id !== "string" || !/^[a-f0-9-]{36}$/.test(comment.id) || branch(comment.branch) !== comment.branch || !validHead(comment.head) || typeof comment.text !== "string" || !comment.text.trim() || comment.text.length > 4000 || !Number.isSafeInteger(comment.at) || comment.at < 0) throw new Error("Invalid comment"); actor(comment.actor); if (Object.keys(comment.actor).some((key) => !["id", "name"].includes(key))) throw new Error("Invalid actor"); }
      if (new Set(value.comments.map((comment) => comment.id)).size !== value.comments.length) throw new Error("Duplicate comment");
      return value;
    } catch { throw new CollaborationReviewError("Review comments are invalid; existing records were left untouched", 503); }
  }
  async add(runId: string, input: { branch: unknown; expectedHead: unknown; text: unknown }, identity: CollaborationActor, resolveHead: () => Promise<string>, authorize: () => void = () => {}): Promise<CollaborationThread> {
    const file = this.path(runId); const resultBranch = branch(input.branch); const author = actor(identity);
    if (!validHead(input.expectedHead)) throw new CollaborationReviewError("Choose an exact result commit");
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) throw new CollaborationReviewError("Review comments need 1–4000 characters of text");
    const text = input.text.trim(), expectedHead = input.expectedHead;
    const next = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const current = await this.read(runId); if (current.comments.length >= 200) throw new CollaborationReviewError("This thread has reached its 200-comment limit", 409);
      if (await resolveHead() !== expectedHead) throw new CollaborationReviewError("The result commit changed; refresh before commenting", 409);
      authorize();
      const updated: CollaborationThread = { version: 1, revision: current.revision + 1, comments: [...current.comments, { id: randomUUID(), branch: resultBranch, head: expectedHead, text, actor: author, at: Date.now() }] };
      await mkdir(dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${randomUUID()}.tmp`;
      try { const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(JSON.stringify(updated)); await handle.sync(); } finally { await handle.close(); } authorize(); await rename(temp, file); if (process.platform !== "win32") { const directory = await open(dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); } } }
      finally { await rm(temp, { force: true }).catch(() => {}); }
      return redactExport(updated);
    }); queues.set(file, next);
    try { return await next; } finally { if (queues.get(file) === next) queues.delete(file); }
  }
}
