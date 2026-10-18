import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { git, repoRoot, resolveCommit, withRepoLock } from "./git.js";

export const CONVENTIONS_PATH = ".codeflow/conventions.md";
export const MAX_CONVENTION_BYTES = 64 * 1024;
export const MAX_CONVENTION_REVISIONS = 32;
const MAX_DOCUMENT_BYTES = MAX_CONVENTION_BYTES * MAX_CONVENTION_REVISIONS * 6 + 128 * 1024;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export interface ConventionVersion { revision: number; at: number; hash: string; note: string; restoredFrom?: number }
interface StoredVersion extends ConventionVersion { text: string }
interface StoredDocument { version: 1; projectId: string; revisions: StoredVersion[] }
export interface ConventionsDocument { projectId: string; revision: number; text: string; hash: string; updatedAt: number; history: ConventionVersion[] }
export interface ConventionRestorePreview { revision: number; version: number; text: string; hash: string }
export interface ConventionPublication { repo: string; path: typeof CONVENTIONS_PATH; exists: boolean; tracked: boolean; sourceHash: string | null; text: string; head: string; branch: string | null; clean: boolean }
export class ConventionsError extends Error { constructor(message: string, readonly status = 400, readonly current?: ConventionsDocument) { super(message); this.name = "ConventionsError"; } }
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined); queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}
function projectKey(id: string) {
  if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\x00-\x1f]/.test(id)) throw new ConventionsError("Choose an existing project for conventions.");
  return createHash("sha256").update(id).digest("hex");
}
function normalizedText(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.from(value).toString("utf8") !== value) throw new ConventionsError("Conventions must be valid UTF-8 plain text without binary NUL characters.");
  const text = value.replace(/\r\n/g, "\n"); const normalized = text && !text.endsWith("\n") ? `${text}\n` : text;
  if (Buffer.byteLength(normalized) > MAX_CONVENTION_BYTES) throw new ConventionsError("Conventions are limited to 64 KiB including the final newline.");
  return normalized;
}
function projection(document: StoredDocument): ConventionsDocument {
  const current = document.revisions.at(-1);
  return { projectId: document.projectId, revision: current?.revision ?? 0, text: current?.text ?? "", hash: current?.hash ?? digest(""), updatedAt: current?.at ?? 0, history: document.revisions.slice().reverse().map(({ text: _text, ...version }) => ({ ...version })) };
}
async function syncDirectory(path: string) { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }

/** Private drafts never enter agent context. Only a published, committed Git file is read there. */
export class ConventionsStore {
  private readonly directory: string;
  constructor(home = CODEFLOW_HOME) { this.directory = join(resolve(home), "conventions"); }
  private file(projectId: string) { return join(this.directory, `${projectKey(projectId)}.json`); }
  private async safeDirectory(create = false) {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => { if (!create && error.code === "ENOENT") return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new ConventionsError("Conventions storage must be a regular private directory.");
    return !!info;
  }
  private async read(projectId: string): Promise<StoredDocument> {
    const file = this.file(projectId);
    if (!await this.safeDirectory()) return { version: 1, projectId, revisions: [] };
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!handle) return { version: 1, projectId, revisions: [] };
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) throw new ConventionsError("Conventions history is not a bounded regular file.");
      const document = JSON.parse(await handle.readFile("utf8")) as StoredDocument;
      if (!document || document.version !== 1 || document.projectId !== projectId || !Array.isArray(document.revisions) || document.revisions.length < 1 || document.revisions.length > MAX_CONVENTION_REVISIONS) throw new ConventionsError("Conventions history is invalid; it has been left untouched.");
      let previous = 0;
      for (const version of document.revisions) {
        if (!version || !validRevision(version.revision) || version.revision <= previous || !Number.isSafeInteger(version.at) || version.at < 0 || typeof version.note !== "string" || version.note.length > 500 || typeof version.text !== "string" || normalizedText(version.text) !== version.text || !validHash(version.hash) || digest(version.text) !== version.hash || version.restoredFrom !== undefined && (!validRevision(version.restoredFrom) || version.restoredFrom < 1 || version.restoredFrom >= version.revision)) throw new ConventionsError("Conventions history is invalid; it has been left untouched.");
        previous = version.revision;
      }
      return document;
    } finally { await handle.close(); }
  }
  private async write(document: StoredDocument) {
    await this.safeDirectory(true);
    const file = this.file(document.projectId); const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); } finally { await handle.close(); }
      await this.safeDirectory(); await rename(temporary, file); await syncDirectory(this.directory);
    } finally { await rm(temporary, { force: true }); }
  }
  private expect(document: StoredDocument, revision: unknown) {
    if (!validRevision(revision)) throw new ConventionsError("Send the exact current conventions revision.");
    const current = projection(document);
    if (current.revision !== revision) throw new ConventionsError(`Conventions changed to revision ${current.revision}. Your draft was not saved.`, 409, current);
    if (revision >= Number.MAX_SAFE_INTEGER) throw new ConventionsError("Conventions revision limit reached.");
  }
  private async append(document: StoredDocument, text: string, note: string, restoredFrom?: number) {
    const version: StoredVersion = { revision: (document.revisions.at(-1)?.revision ?? 0) + 1, text, hash: digest(text), at: Date.now(), note, ...(restoredFrom ? { restoredFrom } : {}) };
    const next: StoredDocument = { ...document, revisions: [...document.revisions, version].slice(-MAX_CONVENTION_REVISIONS) };
    await this.write(next); return projection(next);
  }
  get(projectId: string): Promise<ConventionsDocument> { return serialized(this.file(projectId), async () => projection(await this.read(projectId))); }
  save(projectId: string, input: { revision: number; text: string; note?: string }): Promise<ConventionsDocument> {
    return serialized(this.file(projectId), async () => {
      const text = normalizedText(input.text); const note = input.note ?? "";
      if (typeof note !== "string" || note.length > 500 || note.includes("\0")) throw new ConventionsError("Revision notes are limited to 500 characters.");
      const document = await this.read(projectId); this.expect(document, input.revision);
      return this.append(document, text, note.trim());
    });
  }
  previewRestore(projectId: string, version: number): Promise<ConventionRestorePreview> {
    return serialized(this.file(projectId), async () => {
      const document = await this.read(projectId); const found = document.revisions.find((entry) => entry.revision === version);
      if (!validRevision(version) || version < 1 || !found) throw new ConventionsError("That conventions revision is no longer retained.", 404);
      return { revision: projection(document).revision, version, hash: found.hash, text: found.text };
    });
  }
  restore(projectId: string, input: { revision: number; version: number; hash: string }): Promise<ConventionsDocument> {
    return serialized(this.file(projectId), async () => {
      const document = await this.read(projectId); this.expect(document, input.revision);
      const found = document.revisions.find((entry) => entry.revision === input.version);
      if (!found || !validHash(input.hash) || found.hash !== input.hash) throw new ConventionsError("Preview the retained revision again before restoring it.", 409);
      return this.append(document, found.text, `Restored revision ${found.revision}`, found.revision);
    });
  }
  async inspectRepository(repo: string): Promise<ConventionPublication> {
    const root = await regularRepository(repo);
    return withRepoLock(root, () => inspectAt(root));
  }
  publish(projectId: string, input: { repo: string; revision: number; sourceHash: string | null; head: string }, guard: { repos: readonly string[]; isIdle: () => boolean | Promise<boolean>; actor: "user" }) {
    return serialized(this.file(projectId), async () => {
      if (!guard || guard.actor !== "user" || !Array.isArray(guard.repos) || typeof guard.isIdle !== "function") throw new ConventionsError("Only an explicit user action can publish project guidance.", 403);
      const document = await this.read(projectId); this.expect(document, input.revision); const current = projection(document);
      if (!current.revision) throw new ConventionsError("Save a conventions revision before publishing it.");
      if (input.sourceHash !== null && !validHash(input.sourceHash) || typeof input.head !== "string" || !/^[a-f0-9]{40,64}$/.test(input.head)) throw new ConventionsError("Inspect the repository file before publishing.");
      const root = await regularRepository(input.repo);
      const owned = await Promise.all(guard.repos.map((repo) => realpath(repo).catch(() => "")));
      if (!owned.includes(root)) throw new ConventionsError("Publish only to a repository owned by this project.", 403);
      return withRepoLock(root, async () => {
        if (!await guard.isIdle()) throw new ConventionsError("Wait for repository activity to finish before publishing conventions.", 409);
        const before = await inspectAt(root);
        if (!before.clean) throw new ConventionsError("Commit or save existing repository changes before publishing conventions.", 409);
        if (before.sourceHash !== input.sourceHash || before.head !== input.head) throw new ConventionsError("The repository guidance or HEAD changed. Inspect it again before publishing.", 409);
        const directory = join(root, ".codeflow"); const existed = !!await lstat(directory).catch(() => undefined);
        await mkdir(directory, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        const temporary = join(directory, `.conventions-${randomBytes(8).toString("hex")}.tmp`); let wrote = false; let staged = false;
        try {
          await safeTarget(root);
          const handle = await open(temporary, "wx", 0o644); try { await handle.writeFile(current.text); await handle.sync(); } finally { await handle.close(); }
          const latest = await inspectAt(root);
          // Ignore our own temporary file when checking cleanliness; no other path may change.
          const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", `:(exclude).codeflow/${basename(temporary)}`], root);
          if (status.code !== 0 || status.stdout || latest.sourceHash !== before.sourceHash || latest.head !== before.head || !await guard.isIdle()) throw new ConventionsError("Repository activity changed during publication. Inspect and retry.", 409);
          await safeTarget(root); await rename(temporary, join(root, CONVENTIONS_PATH)); wrote = true; await syncDirectory(directory);
          if (!await guard.isIdle() || await resolveCommit(root) !== before.head) throw new ConventionsError("Repository activity changed during publication.", 409);
          const add = await git(["add", "-f", "--", CONVENTIONS_PATH], root);
          if (add.code !== 0) throw new ConventionsError("Could not stage conventions. Resolve the Git index error and retry.", 409);
          staged = true;
          const index = await git(["show", `:${CONVENTIONS_PATH}`], root);
          if (index.code !== 0 || index.stdout !== current.text) throw new ConventionsError("A Git filter changed the guidance while staging. Review the repository filters before publishing.", 409);
          return { repo: root, path: CONVENTIONS_PATH, revision: current.revision, hash: current.hash, staged: true as const, head: before.head, requiresCommit: true as const };
        } catch (error) {
          if (wrote) {
            const latest = await inspectAt(root).catch(() => undefined);
            if (latest?.head === before.head && latest.sourceHash === current.hash) {
              const reset = staged ? await git(["reset", "-q", before.head, "--", CONVENTIONS_PATH], root) : { code: 0 };
              if (reset.code === 0) {
                if (before.exists) { const rollback = await open(temporary, "wx", 0o644); try { await rollback.writeFile(before.text); await rollback.sync(); } finally { await rollback.close(); } await rename(temporary, join(root, CONVENTIONS_PATH)); }
                else await rm(join(root, CONVENTIONS_PATH));
                await syncDirectory(directory); wrote = false;
              } else throw new ConventionsError(`${(error as Error).message} The staged file needs manual review.`, 409);
            } else throw new ConventionsError(`${(error as Error).message} Concurrent changes were preserved; review the repository file before retrying.`, 409);
          }
          throw error;
        } finally { await rm(temporary, { force: true }); if (!existed && !wrote) await rmdir(directory).catch(() => undefined); }
      });
    });
  }
}

async function regularRepository(repo: string): Promise<string> {
  if (typeof repo !== "string" || !(await lstat(repo)).isDirectory()) throw new ConventionsError("Choose a regular project repository directory.");
  const root = await realpath(await repoRoot(repo));
  if ((await lstat(join(root, ".git"))).isSymbolicLink()) throw new ConventionsError("Publishing through a symbolic .git marker is refused.");
  return root;
}
async function safeTarget(root: string) {
  const directory = join(root, ".codeflow"); const target = join(root, CONVENTIONS_PATH);
  const dir = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (dir && (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(directory) !== directory)) throw new ConventionsError("Publishing refuses symbolic links or non-directory .codeflow paths.");
  const info = dir ? await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) : undefined;
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONVENTION_BYTES)) throw new ConventionsError("Publish only to a regular conventions file under 64 KiB.");
  return info;
}
async function inspectAt(root: string): Promise<ConventionPublication> {
  const info = await safeTarget(root); let text = "";
  if (info) {
    const handle = await open(join(root, CONVENTIONS_PATH), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_CONVENTION_BYTES) throw new ConventionsError("The conventions file changed during inspection.", 409); text = new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()); if (text.includes("\0")) throw new ConventionsError("The repository conventions file is binary."); } finally { await handle.close(); }
  }
  const [head, branch, status, tracked] = await Promise.all([resolveCommit(root), git(["symbolic-ref", "--quiet", "--short", "HEAD"], root), git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root), git(["ls-files", "--error-unmatch", "--", CONVENTIONS_PATH], root)]);
  if (status.code !== 0) throw new ConventionsError("Cannot inspect repository status.");
  return { repo: root, path: CONVENTIONS_PATH, exists: !!info, tracked: tracked.code === 0, sourceHash: info ? digest(text) : null, text, head, branch: branch.code === 0 ? branch.stdout.trim() : null, clean: !status.stdout };
}
