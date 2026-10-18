import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";
import type { Run, RunManager, RunSummary } from "./engine.js";
import type { Projects } from "./projects.js";
import type { SharedAccounts, SharedPrincipal } from "./shared-accounts.js";
import { sharedCanReadRun, sharedCoverageProjection, sharedDiffProjection, sharedEventProjection, sharedProjectProjection, sharedProjectRole, sharedRoutePolicy, sharedRunProjection } from "./shared-access.js";
import type { CollaborationReviews } from "./collaboration-reviews.js";
import { afterRunCursor, compareRuns, decodeRunCursor, encodeRunCursor } from "./run-history.js";
import { sensitiveContextPath } from "./context-inspection.js";
import { redactExport } from "./privacy.js";

interface SharedApiHost {
  accounts: SharedAccounts; token: string; identity: SharedPrincipal;
  manager: RunManager; projects: Projects; comments: CollaborationReviews;
  patterns: unknown[]; templates: unknown[];
  canReadFilePolicy?: (run: Run | RunSummary) => boolean;
  onFilePolicyChange?: (listener: () => void) => () => void;
}
const sharedStreams = new Map<string, number>();
let totalSharedStreams = 0;
const STREAM_BYTES = 2 * 1024 * 1024;
/** Slow consumers reconnect to a fresh snapshot instead of accumulating an unbounded queue. */
function sharedStream(res: ServerResponse, userId: string) {
  const count = sharedStreams.get(userId) ?? 0;
  if (count >= 4 || totalSharedStreams >= 128) throw new HttpError(429, "Too many shared event streams; close another tab and retry");
  sharedStreams.set(userId, count + 1); totalSharedStreams++;
  let closed = false, blocked = false;
  const disposers: (() => void)[] = [];
  const close = () => {
    if (closed) return; closed = true;
    const remaining = (sharedStreams.get(userId) ?? 1) - 1;
    if (remaining) sharedStreams.set(userId, remaining); else sharedStreams.delete(userId);
    totalSharedStreams--;
    for (const dispose of disposers.splice(0)) dispose();
    res.destroy();
  };
  const write = (frame: string) => {
    if (closed) return;
    if (blocked || Buffer.byteLength(frame) > STREAM_BYTES || res.writableLength + Buffer.byteLength(frame) > STREAM_BYTES) return close();
    blocked = !res.write(frame);
  };
  res.on("drain", () => { blocked = false; });
  res.on("close", close);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  return { close, add: (dispose: () => void) => disposers.push(dispose), emit: (value: unknown) => write(`data: ${JSON.stringify(value)}\n\n`), ping: () => write(": connected\n\n") };
}
/** Separate dispatch is intentionally closed: shared identities never fall through to owner APIs. */
export async function handleSharedApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], host: SharedApiHost) {
  const policy = sharedRoutePolicy(req.method ?? "GET", parts);
  if (policy === "owner" || policy === "identity") throw new HttpError(403, "This operation requires the Code Flow owner");
  const current = () => {
    // The incoming HTTP request touched the session once. Passive streams cannot extend idle expiry.
    const identity = host.accounts.authenticate(host.token, { touch: false });
    if (!identity || identity.userId !== host.identity.userId || identity.revision !== host.identity.revision) throw new HttpError(401, "Shared session expired or was revoked");
    return identity;
  };
  const projectId = (run: Pick<Run, "project" | "repo">) => run.project ?? (() => { const matches = host.projects.list().filter((project) => project.repos.includes(run.repo)); return matches.length === 1 ? matches[0]!.id : undefined; })();
  const canRead = (run: Run | RunSummary) => (!host.canReadFilePolicy || host.canReadFilePolicy(run)) && sharedCanReadRun(current(), run, host.projects.list());
  const canReadId = (id: string) => { const run = host.manager.get(id); return !!run && canRead(run); };
  const projection = (run: Run | RunSummary) => sharedRunProjection({ ...run, project: projectId(run) }, canReadId);
  const authorized = () => host.manager.list().filter(canRead).sort(compareRuns);
  const requestedRun = () => { const run = host.manager.get(parts[2] ?? ""); if (!run || !canRead(run)) throw new HttpError(404, "Run not found"); return run; };
  const assertBranch = (run: Run, branch: unknown): string => { if (typeof branch !== "string" || !run.worktrees.some((tree) => tree.branch === branch)) throw new HttpError(404, "Result branch not found"); return branch; };
  const coverage = sharedCoverageProjection;
  current();
  if (policy === "catalog") return send(res, 200, redactExport(parts[1] === "patterns" ? host.patterns : host.templates));
  if (policy === "project-list") return send(res, 200, host.projects.list().filter((project) => sharedProjectRole(current(), project.id)).map(sharedProjectProjection));
  if (policy === "run-list" && parts[1] === "runs") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    const query = url.searchParams.get("q") ?? "", selectedProject = url.searchParams.get("project");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || query.length > 300) throw new HttpError(400, "Choose a history limit of 1–100 and a bounded search");
    if (selectedProject && !sharedProjectRole(current(), selectedProject)) throw new HttpError(404, "Project not found");
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = authorized().filter((run) => {
      if (selectedProject && projectId(run) !== selectedProject) return false;
      if (!words.length) return true;
      // Search only the shared fields of runs already admitted to this project scope.
      // Cold task previews are shortened; owner search also covers repo/source metadata
      // and therefore cannot be reused as this authorization-sensitive query path.
      const full = run.cold ? host.manager.get(run.id) : run;
      if (!full || !canRead(full) || selectedProject && projectId(full) !== selectedProject) return false;
      const text = [full.id, full.task, full.pattern].join("\n").toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const cursor = url.searchParams.get("cursor");
    let after; try { after = cursor ? decodeRunCursor(cursor) : undefined; } catch { throw new HttpError(400, "Invalid shared history cursor"); }
    const remaining = after ? filtered.filter((run) => afterRunCursor(run, after)) : filtered;
    const page = remaining.slice(0, limit);
    return send(res, 200, { runs: page.map(projection), total: filtered.length, ...(remaining.length > limit ? { nextCursor: encodeRunCursor(page.at(-1)!) } : {}) });
  }
  if (policy === "run-list") {
    // Reconnect always begins with a fresh scoped snapshot. Global event IDs would leak other projects.
    const { emit, close, add, ping } = sharedStream(res, host.identity.userId);
    let visible = new Set<string>();
    const notification = (run: RunSummary) => ({ id: run.id, project: projectId(run), status: run.status, createdAt: run.createdAt, endedAt: run.endedAt });
    const reset = () => { const list = authorized(); visible = new Set(list.map((run) => run.id)); emit({ type: "hello", epoch: randomUUID(), runs: list.slice(0, 100).map(notification), total: list.length }); };
    add(host.manager.subscribeAll((run) => {
      try { if (canRead(run)) { visible.add(run.id); emit({ type: "run", run: notification(run) }); } else if (visible.delete(run.id)) reset(); }
      catch { close(); }
    }));
    if (host.onFilePolicyChange) add(host.onFilePolicyChange(() => close()));
    add(host.accounts.onChange(() => { try { current(); } catch { close(); } }));
    add(host.projects.onChange(() => { try { current(); reset(); } catch { close(); } }));
    const timer = setInterval(() => { try { current(); ping(); } catch { close(); } }, 15_000);
    timer.unref(); add(() => clearInterval(timer)); reset(); return;
  }
  const run = requestedRun();
  if (policy === "run-review") {
    if (sharedProjectRole(current(), projectId(run)) !== "reviewer") throw new HttpError(403, "A project reviewer role is required");
    const body = await readJson(req, 16 * 1024, { timeoutMs: 10_000 });
    const branch = assertBranch(run, body.branch);
    const identity = current();
    if (!canRead(run) || sharedProjectRole(identity, projectId(run)) !== "reviewer") throw new HttpError(404, "Run not found");
    if (parts[3] === "review-coverage") {
      if (typeof body.path !== "string" || sensitiveContextPath(body.path)) throw new HttpError(403, "This path requires owner review");
      const result = await host.manager.recordFileReview(run.id, { branch, expectedHead: body.expectedHead, path: body.path, reviewed: body.reviewed }, `shared:${identity.userId}:${identity.username}`, () => { if (!canRead(run) || sharedProjectRole(current(), projectId(run)) !== "reviewer") throw new HttpError(403, "Project reviewer access changed"); });
      current(); if (!canRead(run)) throw new HttpError(404, "Run not found"); return send(res, 200, coverage(result));
    }
    const result = await host.comments.add(run.id, { branch, expectedHead: body.expectedHead, text: body.text }, { id: `shared:${identity.userId}`, name: identity.displayName }, async () => { current(); const latest = requestedRun(); assertBranch(latest, branch); return (await host.manager.reviewCoverage(run.id, branch)).head; }, () => { if (!canRead(run) || sharedProjectRole(current(), projectId(run)) !== "reviewer") throw new HttpError(403, "Project reviewer access changed"); });
    current(); if (!canRead(run)) throw new HttpError(404, "Run not found"); return send(res, 201, result);
  }
  if (parts.length === 3) return send(res, 200, projection(run));
  if (parts[3] === "export") return send(res, 200, { version: 1, exportedAt: Date.now(), run: projection(run) });
  if (parts[3] === "collaboration") { const result = await host.comments.list(run.id); current(); if (!canRead(run)) throw new HttpError(404, "Run not found"); return send(res, 200, result); }
  if (parts[3] === "diff" || parts[3] === "review-coverage") {
    const branch = assertBranch(run, url.searchParams.get("branch"));
    const result = parts[3] === "diff" ? sharedDiffProjection(await host.manager.diff(run.id, branch, false)) : coverage(await host.manager.reviewCoverage(run.id, branch));
    current(); if (!canRead(run)) throw new HttpError(404, "Run not found"); return send(res, 200, result);
  }
  if (parts[3] === "events") {
    const { emit, close, add, ping } = sharedStream(res, host.identity.userId);
    add(host.manager.subscribe(run.id, (event) => { try { requestedRun(); const value = sharedEventProjection(event, canReadId); if (value) emit(value); } catch { close(); } }));
    if (host.onFilePolicyChange) add(host.onFilePolicyChange(() => close()));
    add(host.accounts.onChange(() => { try { requestedRun(); } catch { close(); } }));
    add(host.projects.onChange(() => { try { requestedRun(); } catch { close(); } }));
    const timer = setInterval(() => { try { requestedRun(); ping(); } catch { close(); } }, 15_000);
    timer.unref(); add(() => clearInterval(timer));
    const snapshot = projection(run);
    emit({ type: "hello", snapshot: { run: { ...snapshot, steps: undefined }, steps: snapshot.steps ?? [] } }); return;
  }
  throw new HttpError(403, "This operation requires the Code Flow owner");
}
