import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { logWarn } from "./log.js";
import { clearOrphanedCodeHostImports, removeCodeHostImport } from "./code-host-imports.js";
import { CODEFLOW_HOME } from "./config.js";
import type { CodeHostSession, ExternalSource, Integrations } from "./integrations.js";
import { CodeHostGit, codeHostRemote, type CodeRefs, type ImportedCode } from "./code-host-git.js";
import { git, repoRoot, resolveCommit } from "./git.js";
import { validateMergeTarget, type MergeValidation } from "./merge-validation.js";
import type { Run, RunManager } from "./engine.js";
import type { Projects } from "./projects.js";
import { redactExport } from "./privacy.js";

export class CodeHostError extends Error { constructor(message: string, readonly status = 409, readonly ambiguous = false) { super(message); } }
export interface CodeDiscussion { id: string; revision: string; resolved: boolean; canResolve: boolean; path?: string; line?: number; comments: { id: string; body: string; author: string }[] }
export interface CodeHostPreview {
  id: string; integration: string; provider: "gitlab" | "bitbucket"; key: string; repo: string; project?: string;
  title: string; body: string; url?: string; state: string; head: string; target: string; base?: string;
  sourceBranch: string; targetBranch: string; expiresAt: number; trusted: false;
  discussions: CodeDiscussion[]; discussionTruncated: boolean; policy: { allowed: boolean; reasons: string[]; fingerprint: string };
  fetched?: ImportedCode;
  push?: { id: string; runId: string; branch: string; commit: string; expected: string };
  merge?: { id: string; runId: string; branch: string; source: string; target: string; tree: string; commit: string; verifiedAt: number };
}
interface SavedPreview { value: CodeHostPreview; session: CodeHostSession; refs: CodeRefs; raw: any }
export interface CodeHostCreation { id: string; integration: string; provider: "gitlab" | "bitbucket"; repo: string; project?: string; runId: string; branch: string; head: string; target: string; sourceBranch: string; targetBranch: string; title: string; body: string; expiresAt: number }
export interface CodeHostOperation { id: string; previewId: string; repo?: string; integration: string; key: string; kind: string; status: "claimed" | "confirmed" | "unknown" | "inspected"; at: number; commit?: string; runId?: string; sourceBranch?: string; target?: string; detail: string }
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[a-f0-9]{40}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max = 20_000) => typeof value === "string" ? value.slice(0, max) : "";
const commit = (value: unknown) => { if (typeof value !== "string" || !SHA.test(value)) throw new CodeHostError("The provider returned an invalid exact commit identity", 502); return value; };
const number = (value: unknown) => { if (typeof value !== "string" || !/^[1-9]\d{0,11}$/.test(value)) throw new CodeHostError("Choose a positive pull request number", 400); return value; };
const safeId = (value: unknown) => { const id = String(value); if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new CodeHostError("The provider returned an invalid discussion identity", 502); return id; };
const branch = (value: unknown) => { if (typeof value !== "string" || value.length > 250 || !value || /[\x00-\x20~^:?*\[\\]/.test(value) || value.startsWith("-") || value.includes("..") || value.includes("@{") || value.endsWith(".") || value.endsWith("/") || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new CodeHostError("The provider returned an unsafe branch", 502); return value; };
const jsonArray = (value: any, name: string) => { if (!Array.isArray(value) || value.length > 100) throw new CodeHostError(`The provider returned an invalid or oversized ${name}`, 502); return value; };
const apiPath = (session: CodeHostSession) => session.config.provider === "gitlab" ? `projects/${encodeURIComponent(session.config.project)}` : `repositories/${session.config.project.split("/").map(encodeURIComponent).join("/")}`;
export function validateCodeHostDocument(value: any): { version: 1; operations: CodeHostOperation[] } {
  if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > 200 || Object.keys(value).some((key) => !["version", "operations"].includes(key)) || value.operations.some((entry: any) => !entry || Object.keys(entry).some((key) => !["id", "previewId", "repo", "integration", "key", "kind", "status", "at", "commit", "runId", "sourceBranch", "target", "detail"].includes(key)) || !ID.test(entry.id) || entry.repo !== undefined && (typeof entry.repo !== "string" || !isAbsolute(entry.repo) || entry.repo.length > 4096) || !ID.test(entry.previewId) || !["claimed", "confirmed", "unknown", "inspected"].includes(entry.status) || typeof entry.integration !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.integration) || typeof entry.key !== "string" || !/^(?:[1-9]\d{0,11}|new)$/.test(entry.key) || !["review", "fetch", "push", "merge", "run", "create"].includes(entry.kind) || !Number.isFinite(entry.at) || typeof entry.detail !== "string" || entry.detail.length > 500 || entry.commit !== undefined && !SHA.test(entry.commit) || entry.target !== undefined && !SHA.test(entry.target) || entry.sourceBranch !== undefined && (typeof entry.sourceBranch !== "string" || !/^codeflow\/pr\/[a-f0-9]{20}$/.test(entry.sourceBranch)) || entry.runId !== undefined && (typeof entry.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(entry.runId)))) throw new Error("Invalid code host action history");
  return structuredClone(value);
}
export function disableRestoredCodeHostActions(value: unknown) { const document = validateCodeHostDocument(value); for (const entry of document.operations) if (entry.status === "claimed") { entry.status = "unknown"; entry.detail = "Restored action has an unknown outcome. Inspect exact provider and run state; no automatic replay is permitted."; } return document; }

/** Bounded provider snapshots, explicit mutations and a durable non-replaying outcome ledger. */
export class CodeHosts {
  private readonly previews = new Map<string, SavedPreview>();
  private readonly busy = new Set<string>();
  private operations: CodeHostOperation[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private readonly repositories = new Map<string, Promise<void>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanup: Promise<void> = Promise.resolve();
  private prepareRepository(repo: string) {
    let ready = this.repositories.get(repo);
    if (!ready) { ready = clearOrphanedCodeHostImports(repo).catch(error => { this.repositories.delete(repo); throw error; }); this.repositories.set(repo, ready); }
    return ready;
  }
  private dropPreview(id: string) {
    const saved = this.previews.get(id); this.previews.delete(id);
    clearTimeout(this.expiryTimers.get(id)); this.expiryTimers.delete(id);
    if (saved?.value.fetched) this.cleanup = this.cleanup.then(() => removeCodeHostImport(saved.value.repo, saved.value.fetched!)).catch(error => { logWarn("Code-host preview cleanup failed", { error: String(error) }); });
  }
  private async savePreview(saved: SavedPreview) {
    for (const [id, old] of this.previews) if (old.value.expiresAt <= this.now() || old.value.repo === saved.value.repo && old.value.integration === saved.value.integration && old.value.key === saved.value.key && !this.busy.has(`${old.value.integration}:${old.value.key}`)) this.dropPreview(id);
    while (this.previews.size >= 50) this.dropPreview(this.previews.keys().next().value!);
    await this.cleanup;
    this.previews.set(saved.value.id, saved);
    const timer = setTimeout(() => this.dropPreview(saved.value.id), Math.max(0, saved.value.expiresAt - this.now())); timer.unref(); this.expiryTimers.set(saved.value.id, timer);
  }
  private session(integration: string): CodeHostSession {
    try { return this.options.integrations.codeHost(integration); }
    catch (error) { throw new CodeHostError((error as Error).message, /not found/i.test((error as Error).message) ? 404 : 400); }
  }
  private readonly file: string; private readonly transport: CodeHostGit; private readonly now: () => number;
  constructor(private readonly options: { integrations: Pick<Integrations, "codeHost">; manager: Pick<RunManager, "get" | "reviewCoverage" | "withIdleRepository">; projects: Pick<Projects, "get"> & Partial<Pick<Projects, "list">>; file?: string; git?: CodeHostGit; now?: () => number }) { this.file = options.file ?? join(CODEFLOW_HOME, "code-host-operations.json"); this.transport = options.git ?? new CodeHostGit(); this.now = options.now ?? Date.now; }
  private async providerRead<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof CodeHostError) throw error; const message = redactExport((error as Error).message); throw new CodeHostError(message, /Credentials are unavailable/.test(message) ? 400 : 502); }
  }
  async load() {
    const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (handle) try { const info = await handle.stat(); if (!info.isFile() || info.size > 512_000) throw new Error("Invalid code host action history"); this.operations = disableRestoredCodeHostActions(JSON.parse(await handle.readFile("utf8"))).operations; } finally { await handle.close(); }
    const repos = new Set([...(this.options.projects.list?.() ?? []).flatMap(project => project.repos), ...this.operations.flatMap(entry => entry.repo ? [entry.repo] : [])]);
    for (const repo of repos) await this.prepareRepository(repo).catch(error => { logWarn("Code-host import cleanup will retry when the repository is available", { error: String(error) }); });
  }
  history() { return structuredClone(this.operations).reverse(); }
  async acknowledge(id: string) { if (!ID.test(id)) throw new CodeHostError("Choose an unknown operation from the saved history", 400); await this.ledger(() => { const entry = this.operations.find((entry) => entry.id === id); if (!entry || entry.status !== "unknown") throw new CodeHostError("This operation is not currently unknown"); entry.status = "inspected"; entry.detail = "Owner acknowledged inspecting this exact outcome. This records manual inspection, not provider confirmation, and never replays the action."; }); return { inspected: true, detail: "Recorded manual inspection; the remote action was not replayed." }; }
  private async save() { await mkdir(dirname(this.file), { recursive: true }); const tmp = `${this.file}.${randomBytes(10).toString("hex")}.tmp`; try { const handle = await open(tmp, "wx", 0o600); try { await handle.writeFile(JSON.stringify({ version: 1, operations: this.operations })); await handle.sync(); } finally { await handle.close(); } await rename(tmp, this.file); if (process.platform !== "win32") { const directory = await open(dirname(this.file), "r"); try { await directory.sync(); } finally { await directory.close(); } } } finally { await rm(tmp, { force: true }); } }
  private async ledger(action: () => void) { const pending = this.writes.catch(() => undefined).then(async () => { action(); await this.save(); }); this.writes = pending; await pending; }
  private authorize(value: Pick<CodeHostPreview, "project" | "repo">) { if (value.project) { const project = this.options.projects.get(value.project); if (!project?.repos.includes(value.repo)) throw new CodeHostError("Project membership changed. Load a fresh preview."); } }
  get(id: string) { const saved = this.previews.get(id); if (!saved || saved.value.expiresAt <= this.now()) { this.dropPreview(id); throw new CodeHostError("Code host preview expired or is unknown. Load a fresh preview."); } this.authorize(saved.value); return saved; }
  async action<T>(id: string, kind: CodeHostOperation["kind"], work: (saved: SavedPreview, beginEffect: () => void) => Promise<T>, receipt?: (result: T) => string | { runId: string } | undefined): Promise<T> {
    const saved = this.get(id), key = `${saved.value.integration}:${saved.value.key}`; if (this.busy.has(key)) throw new CodeHostError("Another action is in progress for this pull request"); this.busy.add(key);
    const creation = kind === "create" ? saved.raw.creation as CodeHostCreation : undefined, relatedRun = kind === "push" ? saved.value.push?.runId : kind === "merge" ? saved.value.merge?.runId : creation?.runId;
    const entry: CodeHostOperation = { id: randomBytes(20).toString("hex"), previewId: id, repo: saved.value.repo, integration: saved.value.integration, key: saved.value.key, kind, status: "claimed", at: this.now(), ...(relatedRun ? { runId: relatedRun } : {}), ...(creation ? { sourceBranch: creation.sourceBranch, target: creation.target, commit: creation.head } : {}), detail: "Explicit action claimed; no automatic replay" };
    let effect = false; const beginEffect = () => { effect = true; };
    try {
      await this.ledger(() => { if (this.operations.length >= 200) { const disposable = this.operations.findIndex((value) => ["confirmed", "inspected"].includes(value.status)); if (disposable < 0) throw new CodeHostError("The action history is full of unresolved outcomes. Inspect and acknowledge an unknown operation before starting another."); this.operations.splice(disposable, 1); } this.operations.push(entry); });
      try { const result = await (["push", "merge", "create", "review"].includes(kind) ? this.options.manager.withIdleRepository(saved.value.repo, () => work(saved, beginEffect), { kind: `code-host-${kind}` }) : work(saved, beginEffect)); await this.ledger(() => { entry.status = "confirmed"; entry.detail = "Provider or local action confirmed; refresh before another mutation"; const proof = receipt?.(result); if (typeof proof === "string") entry.commit = proof; else if (proof) entry.runId = proof.runId; }); return result; }
      catch (error) { if (!effect) { await this.ledger(() => { this.operations = this.operations.filter(value => value !== entry); }); throw error instanceof CodeHostError ? error : new CodeHostError((error as Error).message, 502); } await this.ledger(() => { entry.status = "unknown"; entry.detail = "Action was not confirmed. Inspect exact local and provider state before retrying; never automatically replayed."; }).catch(() => undefined); throw new CodeHostError(`${(error as Error).message} The action receipt is unknown; inspect state before retrying.`, error instanceof CodeHostError ? error.status : 502, true); }
    } finally { this.busy.delete(key); }
  }
  async recordRun(id: string, runId: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) throw new Error("Invalid code host run receipt"); const entry = [...this.operations].reverse().find((value) => value.previewId === id && value.kind === "run" && value.status === "claimed"); if (!entry) throw new Error("The code host launch claim is unavailable"); await this.ledger(() => { entry.runId = runId; }); }
  private async read(session: CodeHostSession, key: string, signal?: AbortSignal) {
    const path = apiPath(session), gl = session.config.provider === "gitlab", root = `${path}/${gl ? "merge_requests" : "pullrequests"}/${number(key)}`;
    const { data: raw } = await session.request(root, { signal }); let sourcePath: string, targetPath: string, target: string;
    if (gl) {
      if (String(raw?.iid) !== key) throw new CodeHostError("GitLab returned a different merge request", 502);
      const { data: project } = await session.request(path, { signal }); if (String(raw.target_project_id) !== String(project.id)) throw new CodeHostError("The merge request belongs to another configured project", 502);
      targetPath = text(project.path_with_namespace, 200); sourcePath = targetPath;
      target = commit((await session.request(`${path}/repository/branches/${encodeURIComponent(branch(raw.target_branch))}`, { signal })).data?.commit?.id);
    } else {
      if (String(raw?.id) !== key || raw.destination?.repository?.full_name !== session.config.project) throw new CodeHostError("Bitbucket returned a different repository or pull request", 502);
      sourcePath = text(raw.source?.repository?.full_name, 200); targetPath = text(raw.destination?.repository?.full_name, 200); target = commit(raw.destination?.commit?.hash);
    }
    const head = commit(gl ? raw.sha : raw.source?.commit?.hash), sourceBranch = branch(gl ? raw.source_branch : raw.source?.branch?.name), targetBranch = branch(gl ? raw.target_branch : raw.destination?.branch?.name);
    const refs: CodeRefs = { head, target, sourceUrl: codeHostRemote(session, sourcePath), targetUrl: codeHostRemote(session, targetPath), sourceRef: gl ? `refs/merge-requests/${key}/head` : `refs/heads/${sourceBranch}`, targetRef: `refs/heads/${targetBranch}` };
    return { raw, root, path, refs, sourceBranch, targetBranch, state: text(raw.state, 30), title: redactExport(text(raw.title, 500)), body: redactExport(text(gl ? raw.description : raw.description)), url: (() => { try { const url = new URL(gl ? raw.web_url : raw.links?.html?.href); return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } })() };
  }
  private async policy(session: CodeHostSession, info: Awaited<ReturnType<CodeHosts["read"]>>, signal?: AbortSignal) {
    const reasons: string[] = [], evidence: unknown[] = [], { raw, root, path } = info;
    try {
      if (session.config.provider === "gitlab") {
        const responses = await Promise.all([session.request(path, { signal }), session.request(`${root}/approvals`, { signal }), session.request(`${root}/approval_state`, { signal }), session.request(`${path}/external_status_checks`, { signal }), session.request(`${root}/status_checks`, { signal })]);
        const [project, approvals, rules, services, checks] = responses.map((result) => result.data); evidence.push(project, approvals, rules, services, checks);
        if (raw.state !== "opened" || raw.draft !== false || raw.has_conflicts !== false || raw.detailed_merge_status !== "mergeable") reasons.push("GitLab does not report a current open, non-draft, conflict-free mergeable request");
        if (approvals?.approved !== true || !Array.isArray(rules?.rules) || rules.rules.some((rule: any) => rule.approved !== true)) reasons.push("Required GitLab approvals are missing or unknown");
        if (typeof project.only_allow_merge_if_pipeline_succeeds !== "boolean" || typeof project.only_allow_merge_if_all_discussions_are_resolved !== "boolean") reasons.push("GitLab merge policy could not be fully identified");
        if (project.only_allow_merge_if_pipeline_succeeds && (raw.head_pipeline?.status !== "success" || raw.head_pipeline?.sha !== info.refs.head)) reasons.push("The required GitLab exact-head pipeline is not successful");
        if (project.only_allow_merge_if_all_discussions_are_resolved && raw.blocking_discussions_resolved !== true) reasons.push("GitLab blocking discussions are unresolved");
        if (project.merge_trains_enabled || project.merge_pipelines_enabled || project.merge_method !== "merge" || !["never", "default_off"].includes(project.squash_option)) reasons.push("Native trains, merged pipelines or enforced squash/rebase policies require a provider-native workflow");
        if (!Array.isArray(services) || !Array.isArray(checks) || services.some((service: any) => !checks.some((check: any) => check.id === service.id && check.status === "passed"))) reasons.push("External GitLab status checks are missing or not passed");
        let restrictions: unknown; try { restrictions = (await session.request(`${path}/protected_branches/${encodeURIComponent(info.targetBranch)}`, { signal })).data; if (!Array.isArray((restrictions as any)?.push_access_levels) || !Array.isArray((restrictions as any)?.merge_access_levels)) reasons.push("Protected branch permissions could not be identified"); } catch (error) { if ((error as any).status !== 404) throw error; restrictions = { protected: false }; } evidence.push(restrictions);
      } else {
        const checks = (await session.request(`${root}/mergeability/checks?pagelen=100`, { signal })).data, restrictions = (await session.request(`${path}/branch-restrictions?pagelen=100`, { signal })).data; evidence.push(checks, restrictions);
        if (raw.state !== "OPEN" || raw.draft === true) reasons.push("The Bitbucket pull request is not open and ready");
        if (!Array.isArray(checks?.values) || checks.next || checks.values.length > 100 || !Array.isArray(restrictions?.values) || restrictions.next || restrictions.values.length > 100) reasons.push("Bitbucket policy results are incomplete or unknown");
        else {
          const allowed = new Set(["pullrequest_state_check", "current_user_permission_check", "git_mergeability_check", "standard_merge_check", "custom_pre_merge_check"]);
          if (!["pullrequest_state_check", "current_user_permission_check", "git_mergeability_check"].every((type) => checks.values.some((check: any) => check.type === type && check.status === "PASSED"))) reasons.push("Bitbucket state, permission or Git mergeability checks are missing");
          if (checks.values.some((check: any) => !allowed.has(check.type) || !["PASSED", "FAILED"].includes(check.status) || check.blocking === true || check.required !== false && check.status !== "PASSED")) reasons.push("Required, unknown, native queue or on-merge checks cannot be satisfied by pinned Git merge");
          const kinds = new Set(["push", "force", "delete", "restrict_merges", "reset_pullrequest_approvals_on_change", "require_approvals_to_merge", "require_default_reviewer_approvals_to_merge", "require_tasks_to_be_completed", "require_passing_builds_to_merge", "require_no_changes_requested", "require_commits_behind", "require_all_dependencies_merged", "enforce_merge_checks"]);
          if (restrictions.values.some((rule: any) => !kinds.has(rule.kind) || !["glob", "branching_model"].includes(rule.branch_match_kind))) reasons.push("Bitbucket branch policy contains unsupported requirements");
          if (restrictions.values.some((rule: any) => rule.kind === "require_all_dependencies_merged")) reasons.push("Dependent PR merge requirements are not fully reported by mergeability checks");
        }
      }
    } catch { reasons.push("Provider approval, check or branch policy is unavailable; merging is blocked until it can be verified"); }
    // Hash stable policy facts, excluding generic project update timestamps and transient metadata.
    return { allowed: reasons.length === 0, reasons, fingerprint: digest({ head: info.refs.head, target: info.refs.target, raw: { state: raw.state, detailed_merge_status: raw.detailed_merge_status, head_pipeline: raw.head_pipeline, blocking_discussions_resolved: raw.blocking_discussions_resolved }, evidence }) };
  }
  private async discussions(session: CodeHostSession, info: Awaited<ReturnType<CodeHosts["read"]>>, signal?: AbortSignal) {
    const gl = session.config.provider === "gitlab", response = await session.request(`${info.root}/${gl ? "discussions?per_page=100" : "comments?pagelen=100"}`, { signal }), values = jsonArray(gl ? response.data : response.data?.values, "review discussions"), discussions: CodeDiscussion[] = [];
    for (const raw of values) {
      const notes = gl ? jsonArray(raw.notes, "discussion comments") : [raw]; if (!notes.length) continue;
      const first = notes[0], id = safeId(raw.id), resolved = gl ? first.resolved === true : raw.resolution !== undefined && raw.resolution !== null;
      const value = { id, resolved, canResolve: gl ? first.resolvable === true : raw.inline !== undefined, path: text(gl ? first.position?.new_path ?? first.position?.old_path : raw.inline?.path, 2000) || undefined, line: gl ? first.position?.new_line ?? first.position?.old_line : raw.inline?.to ?? raw.inline?.from, comments: notes.map((note: any) => ({ id: safeId(note.id), body: redactExport(text(gl ? note.body : note.content?.raw, 8000)), author: text(gl ? note.author?.username : note.user?.display_name, 100) })) };
      discussions.push({ ...value, revision: digest(raw) });
    }
    return { discussions, truncated: gl ? !!response.headers.get("x-next-page") : !!response.data?.next };
  }
  async preview(input: { integration: string; key: string; repo: string; project?: string }, signal?: AbortSignal): Promise<CodeHostPreview> {
    if (typeof input.repo !== "string" || !isAbsolute(input.repo)) throw new CodeHostError("Repository must be an absolute path", 400);
    let repo: string; try { repo = await realpath(await repoRoot(input.repo)); } catch { throw new CodeHostError("Choose a local Git repository", 400); }
    if (input.project) { const project = this.options.projects.get(input.project); if (!project) throw new CodeHostError("Choose an existing project", 404); if (!project.repos.includes(repo)) throw new CodeHostError("Choose a repository that belongs to this project", 400); }
    await this.prepareRepository(repo);
    const session = this.session(input.integration), info = await this.providerRead(() => this.read(session, number(input.key), signal)), discussion = await this.providerRead(() => this.discussions(session, info, signal)), policy = await this.policy(session, info, signal);
    const value: CodeHostPreview = { id: randomBytes(20).toString("hex"), integration: input.integration, provider: session.config.provider, key: input.key, repo, ...(input.project ? { project: input.project } : {}), title: info.title, body: info.body, url: info.url, state: info.state, head: info.refs.head, target: info.refs.target, sourceBranch: info.sourceBranch, targetBranch: info.targetBranch, expiresAt: this.now() + 15 * 60_000, trusted: false, discussions: discussion.discussions, discussionTruncated: discussion.truncated, policy };
    await this.savePreview({ value, session, refs: info.refs, raw: info.raw }); return structuredClone(value);
  }
  private async current(saved: SavedPreview, signal?: AbortSignal, requirePolicy = false) {
    this.get(saved.value.id); const info = await this.read(saved.session, saved.value.key, signal);
    if (info.refs.head !== saved.value.head || info.refs.target !== saved.value.target || JSON.stringify(info.refs) !== JSON.stringify(saved.refs) || !["opened", "OPEN"].includes(info.state)) throw new CodeHostError("The source, target or PR state changed. Load a fresh preview.");
    if (requirePolicy) { const policy = await this.policy(saved.session, info, signal); if (!policy.allowed || policy.fingerprint !== saved.value.policy.fingerprint) throw new CodeHostError(`Provider policies changed or block merging: ${policy.reasons.join("; ") || "refresh and review current policy"}`); }
    this.authorize(saved.value);
    return info;
  }
  async fetch(id: string, signal?: AbortSignal): Promise<CodeHostPreview> { return this.action(id, "fetch", async (saved) => this.options.manager.withIdleRepository(saved.value.repo, async () => { await this.current(saved, signal); if (saved.value.fetched) return structuredClone(saved.value); saved.value.fetched = await this.transport.fetch(saved.value.repo, saved.session, saved.refs, signal, () => this.authorize(saved.value)); try { this.get(id); } catch (error) { await removeCodeHostImport(saved.value.repo, saved.value.fetched); throw error; } saved.value.base = saved.value.fetched.base; return structuredClone(saved.value); }, { kind: "code-host-fetch" })); }
  source(id: string): ExternalSource {
    const { value } = this.get(id), fetched = value.fetched; if (!fetched) throw new CodeHostError("Fetch this server preview before starting a code review run");
    return { integration: value.integration, provider: value.provider, kind: "pr", key: value.key, title: value.title, body: value.body, url: value.url, state: value.state, sourceBranch: value.sourceBranch, targetBranch: value.targetBranch, sha: value.head, id: `code-${value.id}`, importedAt: this.now(), expiresAt: value.expiresAt, trusted: false, untrusted: true, code: { previewId: value.id, head: value.head, target: value.target, base: fetched.base } };
  }
  async prepareRun(id: string) { const saved = this.get(id); await this.current(saved); if (!saved.value.fetched) await this.fetch(id); return { preview: structuredClone(saved.value), source: this.source(id) }; }
  private async verified(value: Pick<CodeHostPreview, "repo" | "project">, runId: string, selected: string) {
    const run = this.options.manager.get(runId); this.authorize(value);
    if (!run || run.repo !== value.repo || value.project !== undefined && run.project !== value.project || run.status !== "done" || run.followUps.some((follow) => follow.status === "pending") || !run.worktrees.some((tree) => tree.branch === selected) || !run.artifacts.some((artifact) => artifact.branch === selected)) throw new CodeHostError("Choose a completed owned published result branch in this repository and project");
    const head = await resolveCommit(run.repo, `refs/heads/${selected}`), report = run.verification, profile = run.loop.verification;
    if (!report || report.branch !== selected || report.head !== head || report.state !== "verified" || run.verdict === "failing" || !profile?.checks.some((check) => check.required) || profile.checks.some((check) => check.required && !report.checks.some((evidence) => evidence.check.id === check.id && evidence.check.command === check.command && evidence.diagnosis === "passed" && evidence.attempts.length > 0 && evidence.attempts.every((attempt) => attempt.ok && attempt.exitCode === 0 && !attempt.timedOut))) || report.skipped.some((check) => check.check.required) || report.requirements?.some((requirement) => !requirement.covered)) throw new CodeHostError("The exact owned result has no successful current required verification evidence");
    const coverage = await this.options.manager.reviewCoverage(run.id, selected); if (coverage.head !== head || coverage.stale || run.pattern === "auto-team" && (!run.team?.verification?.approved || !run.team.verification.reviewed || run.team.verification.head !== head)) throw new CodeHostError("Independent review evidence is missing or stale");
    this.authorize(value);
    return { run, head, profile };
  }
  private async owned(saved: SavedPreview, runId: string, selected: string, exactHead: boolean) { const owned = await this.verified(saved.value, runId, selected); if (owned.run.externalSource?.integration !== saved.value.integration || owned.run.externalSource.key !== saved.value.key || !owned.run.externalSource.code || exactHead && owned.head !== saved.value.head || (await git(["merge-base", "--is-ancestor", saved.value.head, owned.head], owned.run.repo)).code) throw new CodeHostError("The owned result does not match this fetched PR source or contains an unreviewed source update"); return owned; }
  private async repositoryTarget(session: CodeHostSession, targetBranch: string, signal?: AbortSignal) {
    const path = apiPath(session), gl = session.config.provider === "gitlab", repository = (await session.request(path, { signal })).data;
    if (gl ? !Number.isSafeInteger(repository?.id) || typeof repository.path_with_namespace !== "string" : repository?.full_name !== session.config.project) throw new CodeHostError("The configured repository identity could not be verified", 502);
    const target = commit((await session.request(`${path}/${gl ? "repository/branches" : "refs/branches"}/${encodeURIComponent(branch(targetBranch))}`, { signal })).data?.[gl ? "commit" : "target"]?.[gl ? "id" : "hash"]);
    return { url: codeHostRemote(session, gl ? repository.path_with_namespace : repository.full_name), target, path };
  }
  async createPreview(input: { integration: string; runId: string; branch: string; targetBranch: string; title: string; body: string }, signal?: AbortSignal): Promise<CodeHostCreation> {
    const run = this.options.manager.get(input.runId); if (!run) throw new CodeHostError("Choose an owned completed run", 400); if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.body !== "string" || input.body.length > 20_000) throw new CodeHostError("Write a PR title (1–200 characters) and body (up to 20,000 characters)", 400);
    const owned = await this.verified({ repo: run.repo, project: run.project }, input.runId, input.branch), session = this.session(input.integration), targetBranch = branch(input.targetBranch), target = await this.providerRead(() => this.repositoryTarget(session, targetBranch, signal));
    await this.options.manager.withIdleRepository(run.repo, async () => { await this.prepareRepository(run.repo); const imported = await this.transport.fetch(run.repo, session, { head: target.target, target: target.target, sourceUrl: target.url, targetUrl: target.url, sourceRef: `refs/heads/${targetBranch}`, targetRef: `refs/heads/${targetBranch}` }, signal, () => this.authorize({ repo: run.repo, project: run.project })); await removeCodeHostImport(run.repo, imported); if ((await git(["merge-base", "--is-ancestor", target.target, owned.head], run.repo)).code || owned.head === target.target) throw new CodeHostError("The verified result must contain new commits descending from the exact current target. Update and verify the result before creating a PR."); }, { kind: "code-host-create-preview" });
    const creation: CodeHostCreation = { id: randomBytes(20).toString("hex"), integration: input.integration, provider: session.config.provider, repo: run.repo, project: run.project, runId: run.id, branch: input.branch, head: owned.head, target: target.target, sourceBranch: `codeflow/pr/${randomBytes(10).toString("hex")}`, targetBranch, title: input.title.trim(), body: input.body, expiresAt: this.now() + 15 * 60_000 };
    const value: CodeHostPreview = { ...creation, key: "new", state: "creation-preview", trusted: false, discussions: [], discussionTruncated: false, policy: { allowed: false, reasons: ["New PR creation does not grant merge permission"], fingerprint: "" } };
    await this.savePreview({ value, session, refs: { head: creation.head, target: creation.target, sourceUrl: target.url, targetUrl: target.url, sourceRef: `refs/heads/${creation.sourceBranch}`, targetRef: `refs/heads/${targetBranch}` }, raw: { creation } }); return structuredClone(creation);
  }
  async create(id: string, signal?: AbortSignal) {
    return this.action(id, "create", async (saved, beginEffect) => {
      const creation = saved.raw.creation as CodeHostCreation | undefined; if (!creation) throw new CodeHostError("Select a server-issued new PR creation preview"); const owned = await this.verified(saved.value, creation.runId, creation.branch), target = await this.repositoryTarget(saved.session, creation.targetBranch, signal);
      if (owned.head !== creation.head || target.target !== creation.target || target.url !== saved.refs.targetUrl) throw new CodeHostError("The owned result or target changed after PR preview");
      this.dropPreview(id); await this.transport.push(creation.repo, saved.session, { url: target.url, ref: saved.refs.sourceRef, expected: "", commit: creation.head, beforeEffect: () => { this.authorize(saved.value); beginEffect(); } }, signal);
      // Branch creation and PR creation are separate remote actions. Unknown outcomes keep the
      // exact unique branch in the durable receipt and never replay the native POST.
      const description = `${creation.body}\n\nReviewed source commit: ${creation.head}\nObserved target commit: ${creation.target}\nCode-flow operation: ${id}`;
      this.authorize(saved.value);
      const gl = creation.provider === "gitlab", response = (await saved.session.request(`${target.path}/${gl ? "merge_requests" : "pullrequests"}`, { method: "POST", body: gl ? { source_branch: creation.sourceBranch, target_branch: creation.targetBranch, title: creation.title, description, remove_source_branch: false } : { title: creation.title, description, source: { branch: { name: creation.sourceBranch } }, destination: { branch: { name: creation.targetBranch } }, close_source_branch: false }, signal })).data;
      const key = String(gl ? response?.iid : response?.id); number(key); const actual = await this.read(saved.session, key, signal);
      if (actual.refs.head !== creation.head || actual.refs.target !== creation.target || actual.sourceBranch !== creation.sourceBranch || actual.targetBranch !== creation.targetBranch) throw new CodeHostError("The PR was created, but its source or target no longer matches the preview. Inspect the provider before another action.", 409, true);
      return { key, url: actual.url, commit: creation.head, sourceBranch: creation.sourceBranch, detail: "Provider confirmed the new PR and exact observed source and target. Creating a PR does not grant merge permission.", refreshRequired: true };
    }, (result) => result.commit);
  }
  async pushPreview(id: string, runId: string, selected: string) { const saved = this.get(id); await this.current(saved); const result = await this.owned(saved, runId, selected, false); saved.value.push = { id: randomBytes(20).toString("hex"), runId, branch: selected, commit: result.head, expected: saved.value.head }; return structuredClone(saved.value.push); }
  async push(id: string, planId: string, signal?: AbortSignal) { return this.action(id, "push", async (saved, beginEffect) => { const plan = saved.value.push; if (!plan || plan.id !== planId) throw new CodeHostError("Review a current pinned push preview first"); delete saved.value.push; await this.current(saved, signal); const owned = await this.owned(saved, plan.runId, plan.branch, false); if (owned.head !== plan.commit) throw new CodeHostError("The owned result changed after push preview"); if (saved.session.config.provider === "gitlab" && saved.raw.source_project_id !== saved.raw.target_project_id) throw new CodeHostError("Fork pushes require an explicitly configured source repository integration"); const url = saved.session.config.provider === "gitlab" ? saved.refs.targetUrl : saved.refs.sourceUrl; const result = await this.transport.push(saved.value.repo, saved.session, { url, ref: `refs/heads/${saved.value.sourceBranch}`, expected: plan.expected, commit: plan.commit, beforeEffect: () => { this.authorize(saved.value); beginEffect(); } }, signal); return { ...result, refreshRequired: true }; }, (result) => result.commit); }
  async mergePreview(id: string, runId: string, selected: string, signal?: AbortSignal) {
    const saved = this.get(id); await this.current(saved, signal, true); if (!saved.value.fetched) await this.fetch(id, signal); const owned = await this.owned(saved, runId, selected, true);
    return this.options.manager.withIdleRepository(saved.value.repo, async () => { const validation: MergeValidation = await validateMergeTarget(saved.value.repo, { branch: selected, into: saved.value.targetBranch, targetCommit: saved.value.target, profile: owned.profile, setup: owned.run.loop.setup, container: { ...(owned.run.loop.container ?? { image: "node:22" }), network: false }, signal }); if (validation.source !== saved.value.head || validation.target !== saved.value.target || !validation.tree || validation.conflicts.length || validation.report?.state !== "verified") throw new CodeHostError("The exact source and target merge candidate did not pass required isolated verification"); this.authorize(saved.value); const commit = await this.transport.mergeCommit(saved.value.repo, { source: validation.source, target: validation.target, tree: validation.tree }, signal); saved.value.merge = { id: randomBytes(20).toString("hex"), runId, branch: selected, source: validation.source, target: validation.target, tree: validation.tree, commit, verifiedAt: this.now() }; return structuredClone(saved.value.merge); }, { kind: "code-host-merge-validation" });
  }
  async merge(id: string, planId: string, signal?: AbortSignal) { return this.action(id, "merge", async (saved, beginEffect) => { const plan = saved.value.merge; if (!plan || plan.id !== planId) throw new CodeHostError("Review a current pinned merge preview first"); delete saved.value.merge; await this.current(saved, signal, true); const owned = await this.owned(saved, plan.runId, plan.branch, true); if (owned.head !== plan.source) throw new CodeHostError("The validated merge identity changed"); const tree = await git(["show", "-s", "--format=%T %P", plan.commit], saved.value.repo); if (tree.code || tree.stdout.trim() !== `${plan.tree} ${plan.target} ${plan.source}`) throw new CodeHostError("The validated merge tree or parent identities changed"); const result = await this.transport.push(saved.value.repo, saved.session, { url: saved.refs.targetUrl, ref: saved.refs.targetRef, expected: plan.target, commit: plan.commit, beforeEffect: () => { this.authorize(saved.value); beginEffect(); } }, signal); let state: string | undefined; try { state = (await this.read(saved.session, saved.value.key, signal)).state; } catch { /* The exact Git receipt remains authoritative; provider PR closure is separate. */ } return { ...result, providerState: state, detail: "Pinned Git merge pushed with an exact target lease. Provider PR closure is separate and may remain open. No native merge queue was used.", refreshRequired: true }; }, (result) => result.commit); }
  async review(id: string, input: { action: "comment" | "reply" | "resolve" | "reopen" | "approve" | "unapprove"; body?: string; discussionId?: string; revision?: string; path?: string; line?: number }, signal?: AbortSignal) {
    return this.action(id, "review", async (saved, beginEffect) => {
      const info = await this.current(saved, signal), gl = saved.session.config.provider === "gitlab"; const body = text(input.body, 20_000).trim(); let path: string, method: "POST" | "PUT" | "DELETE" = "POST", payload: unknown;
      if (["comment", "reply"].includes(input.action) && (!body || input.body!.length > 20_000)) throw new CodeHostError("Write a review comment of 1–20,000 characters", 400);
      const discussion = input.discussionId ? saved.value.discussions.find((value) => value.id === input.discussionId && value.revision === input.revision) : undefined;
      if (["reply", "resolve", "reopen"].includes(input.action)) { if (!discussion || saved.value.discussionTruncated) throw new CodeHostError("Select a complete current discussion from this server preview"); const current = await this.discussions(saved.session, info, signal); if (current.truncated || current.discussions.find((value) => value.id === discussion.id)?.revision !== discussion.revision) throw new CodeHostError("The discussion changed. Refresh before replying or resolving."); }
      if (input.action === "approve" || input.action === "unapprove") { if (!gl) throw new CodeHostError("Bitbucket does not offer a commit-bound approval precondition. Use a commit-scoped review comment or the provider's native review UI.", 400); path = `${info.root}/${input.action}`; payload = input.action === "approve" ? { sha: saved.value.head } : {}; }
      else if (input.action === "resolve" || input.action === "reopen") { if (!discussion?.canResolve) throw new CodeHostError("This discussion cannot be resolved with the available provider capability"); path = gl ? `${info.root}/discussions/${discussion.id}` : `${info.root}/comments/${discussion.id}/resolve`; method = gl ? "PUT" : input.action === "resolve" ? "POST" : "DELETE"; payload = gl ? { resolved: input.action === "resolve" } : undefined; }
      else if (input.action === "reply") { path = gl ? `${info.root}/discussions/${discussion!.id}/notes` : `${info.root}/comments`; payload = gl ? { body } : { content: { raw: body }, parent: { id: Number(discussion!.id) } }; }
      else if (input.action === "comment") {
        path = `${info.root}/${gl ? "discussions" : "comments"}`; const scopedBody = `[Reviewed source commit ${saved.value.head}; target ${saved.value.target}]\n\n${body}`;
        payload = gl ? { body: scopedBody } : { content: { raw: scopedBody } };
        if (input.path !== undefined || input.line !== undefined) { if (!saved.value.fetched) throw new CodeHostError("Fetch the pinned code before an inline comment", 400); if (typeof input.path !== "string" || !Number.isSafeInteger(input.line) || input.line! < 1 || input.line! > 10_000_000 || input.path.startsWith("/") || input.path.split("/").some((part) => part === "..") || /[\x00-\x1f]/.test(input.path)) throw new CodeHostError("Choose a changed path and a positive new-file line", 400); const changed = await git(["diff", "--name-only", "-z", saved.value.fetched.base, saved.value.head, "--"], saved.value.repo); if (!changed.stdout.split("\0").includes(input.path)) throw new CodeHostError("Inline review path is absent from the pinned diff", 400); if (gl) { if (info.raw.diff_refs?.head_sha !== saved.value.head || info.raw.diff_refs?.base_sha !== saved.value.fetched.base || !SHA.test(info.raw.diff_refs?.start_sha)) throw new CodeHostError("GitLab inline diff identities are not current"); (payload as any).position = { position_type: "text", base_sha: info.raw.diff_refs.base_sha, head_sha: saved.value.head, start_sha: info.raw.diff_refs.start_sha, new_path: input.path, old_path: input.path, new_line: input.line }; } else (payload as any).inline = { path: input.path, to: input.line }; }
      } else throw new CodeHostError("Choose an explicit supported review action", 400);
      // Invalidate this snapshot before a mutation so timeout/restart cannot blindly replay it.
      this.authorize(saved.value); this.dropPreview(id); beginEffect(); await saved.session.request(path, { method, body: payload, signal });
      let changed = false; try { const current = await this.read(saved.session, saved.value.key, signal); changed = current.refs.head !== saved.value.head || current.refs.target !== saved.value.target; } catch { changed = true; }
      return { applied: true, refreshRequired: true, detail: changed ? "Provider confirmed the request, but the PR head or target changed or could not be rechecked. Comments label the observed commit; Bitbucket inline anchors are not an atomic commit precondition. Refresh before further review." : "Provider confirmed the request. Comments label the observed commit; Bitbucket inline anchors are not an atomic commit precondition. Refresh to inspect current discussion state." };
    });
  }
}
