import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const root = mkdtempSync(join(tmpdir(), "codeflow-collab-api-")); process.env.CODEFLOW_HOME = join(root, "home");
// Everything from src is imported after CODEFLOW_HOME is set, or the store's default directory (and server.log) would land in ~/.codeflow.
const { CODEFLOW_HOME } = await import("../src/config.js"); assert.equal(CODEFLOW_HOME, process.env.CODEFLOW_HOME, "src/config.js loaded before CODEFLOW_HOME was set");
const { HttpError, send } = await import("../src/http.js");
const { CollabStore, memberActor, ownerActor } = await import("../src/collab/store.js");
const { RUNNER_ID } = await import("../src/collab/model.js");
const { RUNNER_TOKEN, TEAM_BODY_LIMIT, handleRunnerConnect, handleTeamApi, isTeamApiPath, looksLikeRunnerToken, runnerAllowed, teamRoutePolicy } = await import("../src/collab/api.js");
const { SharedAccounts } = await import("../src/shared-accounts.js");
type MemberRecord = import("../src/collab/store.js").MemberRecord; type CollabActor = import("../src/collab/model.js").CollabActor; type Task = import("../src/collab/model.js").Task; type SharedRole = import("../src/shared-accounts.js").SharedRole;
type TeamPrincipal = import("../src/collab/api.js").TeamPrincipal; type TeamApiHost = import("../src/collab/api.js").TeamApiHost;
after(() => rmSync(root, { recursive: true, force: true }));

const BASE = "b".repeat(40), HEAD = "c".repeat(40), HEX32 = "a".repeat(32);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex"), tick = () => new Promise((resolve) => setImmediate(resolve));
const member = (userId: string, role?: SharedRole): MemberRecord => ({ userId, username: userId, displayName: userId[0]!.toUpperCase() + userId.slice(1), enabled: true, roles: role ? { "p-1": role } : {} });
const members: MemberRecord[] = [member("alice", "contributor"), member("bob", "contributor"), member("maya", "maintainer"), member("rita", "reviewer"), member("vic", "viewer")];
const projects = [{ id: "p-1", name: "App" }, { id: "p-2", name: "Private" }];
/** One hub store for the whole file (tests run in order and build on each other's state), with a fake members provider standing in for the server's SharedAccounts mapping. */
const store = new CollabStore({ dir: join(root, "team"), members: () => members, projects: () => projects, ownerName: () => "Mx" });
const owner = ownerActor("Mx"), browser = (userId: string) => memberActor(members.find((entry) => entry.userId === userId)!, "browser");
/** A runner credential registered and authenticated the way server.ts does it for a `Bearer tr-…` request. */
async function runnerFor(userId: string, name: string) { const { runner, token } = await store.registerRunner(userId, name); const auth = store.authenticateRunner(token); assert.deepEqual(auth, { runnerId: runner.id, userId }); return { runner, token, actor: memberActor(members.find((entry) => entry.userId === userId)!, "runner", runner.id) }; }

// ---- Fake HTTP objects: a PassThrough stands in for the request (readJson and the bundle upload consume it as a stream) and for the response (send/pipeline/SSE write into it).
interface Reply { status: number; headers: Record<string, string>; json: any; body: Buffer; text: string }
const replies: string[] = [], mutations: string[] = [];
function fakeRequest(method: string, headers: Record<string, string>, payload?: Buffer | string) { const req = Object.assign(new PassThrough(), { method, headers, complete: false }); req.on("end", () => { req.complete = true; }); req.end(payload); return req; }
function fakeResponse() {
  const chunks: Buffer[] = [], res = Object.assign(new PassThrough(), { statusCode: 0, sentHeaders: {} as Record<string, string>, headersSent: false, writeHead(status: number, headers?: Record<string, string>) { res.statusCode = status; res.sentHeaders = headers ?? {}; res.headersSent = true; return res; } });
  res.on("data", (chunk: Buffer) => chunks.push(chunk)); return { res, chunks, text: () => Buffer.concat(chunks).toString("utf8") };
}
async function collect(res: ReturnType<typeof fakeResponse>["res"], chunks: Buffer[]): Promise<Reply> {
  if (!res.readableEnded) await new Promise((resolve) => res.once("end", resolve));
  const body = Buffer.concat(chunks), text = body.toString("utf8"); let json: any; try { json = JSON.parse(text); } catch { json = undefined; } if (json !== undefined) replies.push(text);
  return { status: res.statusCode, headers: res.sentHeaders, json, body, text };
}
async function call(actor: CollabActor, principal: TeamPrincipal, method: string, path: string, options: { body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<Reply> {
  const url = new URL(`http://hub${path}`), parts = url.pathname.slice(1).split("/"), headers = { ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers };
  const req = fakeRequest(method, headers, options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined)), { res, chunks } = fakeResponse();
  const host: TeamApiHost = { store, actor, principal, mutation: () => { mutations.push(`${method} ${url.pathname}`); } };
  await handleTeamApi(req as unknown as IncomingMessage, res as unknown as ServerResponse, url, parts, host);
  return collect(res, chunks);
}
const rejectsWith = (status: number, pattern?: RegExp) => (error: unknown) => { assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`); assert.equal(error.status, status, error.message); if (pattern) assert.match(error.message, pattern); return true; };
async function openStream(actor: CollabActor, principal: TeamPrincipal, query = "", reauthorize?: () => CollabActor, response = fakeResponse()) {
  const url = new URL(`http://hub/api/team/events${query}`), req = fakeRequest("GET", {});
  const host: TeamApiHost = { store, actor, principal, mutation: () => { throw new Error("a GET must not run the mutation rule"); } }; if (reauthorize) host.reauthorize = reauthorize;
  await handleTeamApi(req as unknown as IncomingMessage, response.res as unknown as ServerResponse, url, url.pathname.slice(1).split("/"), host); await tick();
  const frames = (): any[] => response.text().split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)));
  return { res: response.res, text: response.text, frames, close: async () => { response.res.destroy(); await tick(); } };
}

let task: Task, alice: Awaited<ReturnType<typeof runnerFor>>, bob: Awaited<ReturnType<typeof runnerFor>>, checkpointId = "";

test("the route table is closed: unknown paths, malformed ids and the wrong kind of principal are refused before the store is touched", async () => {
  await store.load();
  assert.equal(teamRoutePolicy("GET", ["api", "team", "nope"]), undefined); assert.equal(teamRoutePolicy("GET", ["api", "team"]), undefined); assert.equal(teamRoutePolicy("GET", ["api", "runs"]), undefined); assert.equal(teamRoutePolicy("PATCH", ["api", "team", "tasks", "t-0123456789abcdef"]), undefined);
  assert.equal(teamRoutePolicy("GET", ["api", "team", "tasks", "bad id"]), undefined); assert.equal(teamRoutePolicy("GET", ["api", "team", "tasks", "__proto__"]), undefined); assert.equal(teamRoutePolicy("GET", ["api", "team", "tasks", "x".repeat(101)]), undefined); assert.equal(teamRoutePolicy("GET", ["api", "team", "tasks", "t-1", "comments", "c-1", "more"]), undefined);
  assert.deepEqual(teamRoutePolicy("POST", ["api", "team", "attempts", HEX32, "progress"]), { op: "attempt-progress", principals: ["owner", "runner"], bodyLimit: TEAM_BODY_LIMIT.progress });
  assert.deepEqual(teamRoutePolicy("POST", ["api", "team", "tasks"]), { op: "task-create", principals: ["owner", "browser", "runner"], bodyLimit: 64 * 1024 });
  assert.deepEqual(teamRoutePolicy("PUT", ["api", "team", "checkpoints", HEX32, "bundle"]), { op: "bundle-upload", principals: ["owner", "runner"], bodyLimit: 64 * 1024 * 1024 });
  assert.deepEqual(teamRoutePolicy("POST", ["api", "team", "runners", "connect"])?.principals, [], "enrolment is anonymous and handled beside sign-in");
  assert.deepEqual(teamRoutePolicy("PUT", ["api", "team", "profile"])?.principals, ["owner"]);
  assert.equal(runnerAllowed(teamRoutePolicy("GET", ["api", "team", "board"])), true); assert.equal(runnerAllowed(teamRoutePolicy("PUT", ["api", "team", "profile"])), false); assert.equal(runnerAllowed(undefined), false);
  assert.equal(isTeamApiPath(["api", "team", "me"]), true); assert.equal(isTeamApiPath(["api", "runs"]), false);
  assert.equal(looksLikeRunnerToken(`tr-${"A".repeat(43)}`), true); assert.equal(looksLikeRunnerToken("tr-short"), false); assert.equal(looksLikeRunnerToken(42), false); assert.equal(looksLikeRunnerToken("A".repeat(43)), false, "a shared session token never passes as a runner credential");
  await assert.rejects(call(owner, "owner", "GET", "/api/team/nope"), rejectsWith(404, /^Unknown team operation$/));
  await assert.rejects(call(owner, "owner", "GET", "/api/team/tasks/not%20an%20id"), rejectsWith(404, /^Unknown team operation$/));
  await assert.rejects(call(browser("alice"), "browser", "POST", `/api/team/attempts/${HEX32}/progress`, { body: { seq: 1 } }), rejectsWith(403, /own code-flow/));
  await assert.rejects(call(browser("alice"), "browser", "POST", `/api/team/tasks/t-0123456789abcdef/attempts`, { body: {} }), rejectsWith(403));
  await assert.rejects(call(owner, "owner", "POST", "/api/team/runners/connect", { body: {} }), rejectsWith(403, /without a session or runner credential/));
  assert.deepEqual(mutations, [], "refused requests never reach the CSRF rule or the store");
});

test("roles over HTTP: a viewer cannot create, a reviewer comments, a contributor creates and takes unowned tasks, a maintainer assigns", async () => {
  const repos = await call(owner, "owner", "PUT", "/api/team/projects/p-1/repositories", { body: { repositories: [{ key: "app", label: "App" }], revision: 0 } }); assert.equal(repos.status, 200); assert.deepEqual(repos.json.repositories, [{ key: "app", label: "App" }]); assert.equal(repos.json.members[0].userId, "owner");
  const staleBoard = await call(owner, "owner", "PUT", "/api/team/projects/p-1/repositories", { body: { repositories: [{ key: "app", label: "App" }], revision: 0 } }); assert.equal(staleBoard.status, 409); assert.equal(staleBoard.json.error, "Team board changed; reload before saving");
  const input = { projectId: "p-1", repository: "app", title: "Ship it", goal: "Make it ship", acceptance: "Tests pass" };
  const viewer = await call(browser("vic"), "browser", "POST", "/api/team/tasks", { body: input }); assert.equal(viewer.status, 403); assert.match(viewer.json.error, /contributor role is required to create tasks/);
  const created = await call(browser("alice"), "browser", "POST", "/api/team/tasks", { body: input }); assert.equal(created.status, 201); task = created.json; assert.match(task.id, /^t-[a-f0-9]{16}$/); assert.equal(task.owner, undefined); assert.equal(task.status, "planned");
  const unknownField = await call(browser("alice"), "browser", "POST", "/api/team/tasks", { body: { ...input, secret: 1 } }); assert.equal(unknownField.status, 400); assert.match(unknownField.json.error, /Unknown task field/);
  const self = await call(browser("alice"), "browser", "PUT", `/api/team/tasks/${task.id}`, { body: { revision: task.revision, owner: "alice" } }); assert.equal(self.status, 200); assert.deepEqual(self.json.owner, { userId: "alice", displayName: "Alice" }); task = self.json;
  const grab = await call(browser("bob"), "browser", "PUT", `/api/team/tasks/${task.id}`, { body: { revision: task.revision, owner: "bob" } }); assert.equal(grab.status, 403); assert.match(grab.json.error, /maintainer may reassign/);
  const stale = await call(browser("maya"), "browser", "PUT", `/api/team/tasks/${task.id}`, { body: { revision: task.revision - 1, owner: "bob" } }); assert.equal(stale.status, 409); assert.equal(stale.json.error, "Task changed; reload before saving");
  const assigned = await call(browser("maya"), "browser", "PUT", `/api/team/tasks/${task.id}`, { body: { revision: task.revision, owner: "bob" } }); assert.equal(assigned.status, 200); assert.equal(assigned.json.owner.userId, "bob");
  const back = await call(browser("maya"), "browser", "PUT", `/api/team/tasks/${task.id}`, { body: { revision: assigned.json.revision, owner: "alice", reviewer: "rita" } }); assert.equal(back.status, 200); task = back.json; assert.equal(task.owner!.userId, "alice"); assert.equal(task.reviewer!.userId, "rita");
  const comment = await call(browser("rita"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text: "Looks fine @alice" } }); assert.equal(comment.status, 200); assert.equal(comment.json.discussion.at(-1).text, "Looks fine @alice"); assert.deepEqual(comment.json.discussion.at(-1).mentions, ["alice"]); task = comment.json;
  const silenced = await call(browser("vic"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text: "me too" } }); assert.equal(silenced.status, 403);
  const decided = await call(browser("alice"), "browser", "POST", `/api/team/tasks/${task.id}/decisions`, { body: { text: "Use the new API" } }); assert.equal(decided.status, 200); assert.equal(decided.json.decisions[0].text, "Use the new API"); task = decided.json;
  const read = await call(browser("vic"), "browser", "GET", `/api/team/tasks/${task.id}`); assert.equal(read.status, 200); assert.equal(read.json.id, task.id);
  const missing = await call(browser("vic"), "browser", "GET", `/api/team/tasks/t-${"0".repeat(16)}`); assert.equal(missing.status, 404); assert.equal(missing.json.error, "Task not found");
  const board = await call(browser("vic"), "browser", "GET", "/api/team/board"); assert.equal(board.status, 200); assert.deepEqual(board.json.projects.map((project: any) => project.id), ["p-1"]); assert.equal(board.json.tasks.length, 1); assert.equal(board.json.tasks[0].unreadMentions, 0);
  const scoped = await call(browser("vic"), "browser", "GET", "/api/team/board?project=p-1"); assert.equal(scoped.status, 200); assert.equal(scoped.json.projects.length, 1);
  for (const query of ["p-2", "bad%20id", "__proto__"]) { const other = await call(browser("vic"), "browser", "GET", `/api/team/board?project=${query}`); assert.equal(other.status, 404, query); assert.equal(other.json.error, "Project not found"); }
  const everything = await call(owner, "owner", "GET", "/api/team/board"); assert.deepEqual(everything.json.projects.map((project: any) => project.id), ["p-1", "p-2"]); assert.deepEqual(everything.json.me.roles, { "p-1": "maintainer", "p-2": "maintainer" });
  const me = await call(browser("alice"), "browser", "GET", "/api/team/me"); assert.deepEqual(me.json, { me: { userId: "alice", displayName: "Alice", via: "browser", roles: { "p-1": "contributor" } }, runners: [], linked: false });
  const profile = await call(owner, "owner", "PUT", "/api/team/profile", { body: { displayName: "Midhun" } }); assert.deepEqual(profile.json, { ownerName: "Midhun" }); assert.equal(store.ownerName, "Midhun");
  await assert.rejects(call(browser("maya"), "browser", "PUT", "/api/team/profile", { body: { displayName: "Maya" } }), rejectsWith(403, /hub owner/));
  assert.ok(mutations.includes("PUT /api/team/projects/p-1/repositories") && mutations.includes(`POST /api/team/tasks/${task.id}/comments`), "every non-GET ran the host's CSRF rule"); assert.equal(mutations.some((entry) => entry.startsWith("GET ")), false, "GETs never run it");
});

test("full lifecycle over the handlers: claim through a runner, progress with replay ignored, checkpoint, bundle, finish, hand over, accept, continue", async () => {
  alice = await runnerFor("alice", "alice-laptop"); bob = await runnerFor("bob", "bob-desktop");
  const attemptId = randomBytes(16).toString("hex"), claimBody = { attemptId, runnerId: alice.runner.id, runnerName: "alice-laptop", baseCommit: BASE, revision: task.revision };
  await assert.rejects(call(browser("alice"), "browser", "POST", `/api/team/tasks/${task.id}/attempts`, { body: claimBody }), rejectsWith(403), "browsers never claim");
  const stranger = await call(bob.actor, "runner", "POST", `/api/team/tasks/${task.id}/attempts`, { body: { ...claimBody, runnerId: bob.runner.id, runnerName: "bob-desktop" } }); assert.equal(stranger.status, 403); assert.match(stranger.json.error, /Only the task owner may start an attempt/);
  const spoofed = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/attempts`, { body: { ...claimBody, runnerId: bob.runner.id } }); assert.equal(spoofed.status, 403); assert.match(spoofed.json.error, /runnerId must be the runner id of the credential/);
  const claimed = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/attempts`, { body: claimBody }); assert.equal(claimed.status, 201); assert.equal(claimed.json.status, "working"); assert.equal(claimed.json.attempts[0].state, "claimed"); assert.equal(claimed.json.attempts[0].runnerId, alice.runner.id); assert.deepEqual(claimed.json.attempts[0].user, { userId: "alice", displayName: "Alice", via: "runner" });
  const again = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/attempts`, { body: claimBody }); assert.equal(again.status, 201); assert.equal(again.json.attempts.length, 1, "claiming is idempotent on the attempt id"); task = again.json;
  const progress = (actor: CollabActor, body: unknown) => call(actor, "runner", "POST", `/api/team/attempts/${attemptId}/progress`, { body });
  const first = await progress(alice.actor, { seq: 1, runId: "run-1", stage: "Coding", updatedAt: 1 }); assert.equal(first.status, 200); assert.equal(first.json.attempt.state, "running"); assert.equal(first.json.attempt.lastSeq, 1); assert.equal(first.json.attempt.runId, "run-1"); assert.equal(first.json.attempt.progress.stage, "Coding");
  const replay = await progress(alice.actor, { seq: 1, stage: "Stale replay" }); assert.equal(replay.status, 200); assert.equal(replay.json.attempt.progress.stage, "Coding", "a replayed seq changes nothing"); assert.equal(replay.json.attempt.lastSeq, 1);
  const second = await progress(alice.actor, { seq: 2, stage: "Testing", changedFiles: ["src/a.ts"], steps: { done: 1, total: 3 } }); assert.equal(second.json.attempt.lastSeq, 2); assert.deepEqual(second.json.attempt.progress.changedFiles, ["src/a.ts"]);
  const foreign = await progress(bob.actor, { seq: 3, stage: "Hijack" }); assert.equal(foreign.status, 403); assert.equal(foreign.json.error, "Only the runner executing this attempt may report on it");
  const unordered = await progress(alice.actor, { stage: "no seq" }); assert.equal(unordered.status, 400); assert.match(unordered.json.error, /seq/);
  const proposed = await call(browser("alice"), "browser", "POST", `/api/team/tasks/${task.id}/instructions`, { body: { text: "Also update the docs" } }); assert.equal(proposed.status, 200); const instruction = proposed.json.instructions[0]; assert.equal(instruction.state, "approved", "the owner's own instruction needs no approval");
  const byRita = await call(browser("rita"), "browser", "POST", `/api/team/tasks/${task.id}/instructions`, { body: { text: "Rewrite everything" } }); assert.equal(byRita.status, 403);
  const beat = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/heartbeat`, { headers: { "content-type": "application/json" } }); assert.equal(beat.status, 200); assert.deepEqual(beat.json.instructions.map((entry: any) => entry.id), [instruction.id]); assert.equal(beat.json.attempt.id, attemptId);
  const fromBrowser = await call(browser("alice"), "browser", "POST", `/api/team/tasks/${task.id}/instructions/${instruction.id}`, { body: { action: "delivered", attemptId } }); assert.equal(fromBrowser.status, 403, "only the executing runner records delivery");
  const badAction = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/instructions/${instruction.id}`, { body: { action: "shrug" } }); assert.equal(badAction.status, 400); assert.match(badAction.json.error, /"approve", "decline" or "delivered"/);
  const badAttempt = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/instructions/${instruction.id}`, { body: { action: "delivered", attemptId: "nope" } }); assert.equal(badAttempt.status, 400);
  const delivered = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/instructions/${instruction.id}`, { body: { action: "delivered", attemptId } }); assert.equal(delivered.status, 200); assert.equal(delivered.json.instructions[0].state, "delivered"); assert.equal(delivered.json.instructions[0].attemptId, attemptId);
  // the checkpoint manifest, then its bundle: wrong digest header, wrong bytes, wrong type, no length, oversize and the wrong runner are all refused before the right upload lands
  const data = randomBytes(2048), wanted = randomBytes(16).toString("hex"), manifest = { id: wanted, commit: HEAD, baseCommit: BASE, branch: `team/${task.id}/0123abcd`, size: data.length, sha256: sha256(data), note: "Half done", requirements: "Ship it\nTests pass", decisions: ["Use the new API"], remaining: "Docs", changedFiles: ["src/a.ts"], testResults: { ok: true, command: "npm test", at: 5 } };
  const manifestByBob = await call(bob.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: manifest }); assert.equal(manifestByBob.status, 403);
  const added = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: manifest }); assert.equal(added.status, 201); const checkpoint = added.json; checkpointId = checkpoint.id; assert.equal(checkpoint.bundle, "pending"); assert.equal(checkpoint.ref, `refs/codeflow/team/${checkpoint.id}`); assert.equal(checkpoint.attemptId, attemptId); assert.deepEqual(checkpoint.createdBy, { userId: "alice", displayName: "Alice", via: "runner" });
  assert.equal(checkpoint.id, wanted, "the id the runner minted for the bundle's ref is the checkpoint's id");
  const duplicate = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: manifest }); assert.equal(duplicate.status, 409); assert.match(duplicate.json.error, /A checkpoint with this id already exists/);
  const malformedId = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: { ...manifest, id: "short" } }); assert.equal(malformedId.status, 400); assert.match(malformedId.json.error, /Send the checkpoint id as 32 lowercase hexadecimal characters/);
  assert.equal((await call(browser("alice"), "browser", "GET", `/api/team/tasks/${task.id}`)).json.checkpoints.length, 1, "refused manifests register nothing");
  const upload = (actor: CollabActor, raw: Buffer, headers: Record<string, string> = {}) => call(actor, "runner", "PUT", `/api/team/checkpoints/${checkpoint.id}/bundle`, { raw, headers: { "content-type": "application/octet-stream", "content-length": String(raw.length), "x-codeflow-sha256": sha256(raw), ...headers } });
  const notYet = await call(bob.actor, "runner", "GET", `/api/team/checkpoints/${checkpoint.id}/bundle`); assert.equal(notYet.status, 404); assert.equal(notYet.json.error, "Checkpoint bundle is not available");
  const wrongHeader = await upload(alice.actor, data, { "x-codeflow-sha256": "0".repeat(64) }); assert.equal(wrongHeader.status, 400); assert.match(wrongHeader.json.error, /must match the checkpoint manifest/);
  const tampered = Buffer.from(data); tampered[7] = tampered[7]! ^ 0xff; const wrongBytes = await upload(alice.actor, tampered, { "x-codeflow-sha256": sha256(data) }); assert.equal(wrongBytes.status, 400); assert.match(wrongBytes.json.error, /does not match the checkpoint's size or sha256/);
  const wrongType = await upload(alice.actor, data, { "content-type": "application/json" }); assert.equal(wrongType.status, 415);
  const noLength = await upload(alice.actor, data, { "content-length": "" }); assert.equal(noLength.status, 411);
  const oversize = await upload(alice.actor, data, { "content-length": String(65 * 1024 * 1024) }); assert.equal(oversize.status, 413);
  const badDigest = await upload(alice.actor, data, { "x-codeflow-sha256": "xyz" }); assert.equal(badDigest.status, 400); assert.match(badDigest.json.error, /x-codeflow-sha256/);
  const byBob = await upload(bob.actor, data); assert.equal(byBob.status, 403);
  const stored = await upload(alice.actor, data); assert.equal(stored.status, 200); assert.equal(stored.json.checkpoint.bundle, "available"); assert.equal(stored.json.checkpoint.size, data.length);
  const twice = await upload(alice.actor, data); assert.equal(twice.status, 409); assert.match(twice.json.error, /already uploaded/);
  const seen = await call(browser("vic"), "browser", "GET", `/api/team/checkpoints/${checkpoint.id}`); assert.equal(seen.status, 200); assert.equal(seen.json.id, checkpoint.id); assert.equal(seen.json.bundle, "available");
  const unknownCheckpoint = await call(browser("vic"), "browser", "GET", `/api/team/checkpoints/${"f".repeat(32)}`); assert.equal(unknownCheckpoint.status, 404); assert.equal(unknownCheckpoint.json.error, "Checkpoint not found");
  const reviewerDownload = await call(browser("rita"), "browser", "GET", `/api/team/checkpoints/${checkpoint.id}/bundle`); assert.equal(reviewerDownload.status, 403); assert.match(reviewerDownload.json.error, /contributor role is required to download/);
  const download = await call(bob.actor, "runner", "GET", `/api/team/checkpoints/${checkpoint.id}/bundle`); assert.equal(download.status, 200); assert.equal(download.headers["content-type"], "application/octet-stream"); assert.equal(download.headers["content-length"], String(data.length)); assert.equal(download.headers["x-codeflow-sha256"], sha256(data)); assert.ok(download.body.equals(data), "the bytes come back exactly");
  // a stop before the hand-over: paused keeps the attempt resumable; the hand-over then moves the task to bob, who accepts through his runner
  const paused = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/finish`, { body: { state: "paused", head: HEAD, summary: "Stopped for hand-over" } }); assert.equal(paused.status, 200); assert.equal(paused.json.attempt.state, "paused"); assert.equal(paused.json.attempt.head, HEAD);
  const badState = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/finish`, { body: { state: "done" } }); assert.equal(badState.status, 400);
  task = (await call(browser("alice"), "browser", "GET", `/api/team/tasks/${task.id}`)).json;
  const offerByBob = await call(browser("bob"), "browser", "POST", `/api/team/tasks/${task.id}/handoff`, { body: { to: "bob", checkpointId: checkpoint.id, revision: task.revision } }); assert.equal(offerByBob.status, 403);
  const offered = await call(browser("alice"), "browser", "POST", `/api/team/tasks/${task.id}/handoff`, { body: { to: "bob", checkpointId: checkpoint.id, note: "Your turn @bob", revision: task.revision } }); assert.equal(offered.status, 200); assert.equal(offered.json.handoff.state, "offered"); assert.equal(offered.json.handoff.to.userId, "bob"); task = offered.json;
  const notBob = await call(alice.actor, "runner", "POST", `/api/team/tasks/${task.id}/handoff/${task.handoff!.id}`, { body: { action: "accept", revision: task.revision } }); assert.equal(notBob.status, 403);
  const badHandoffAction = await call(bob.actor, "runner", "POST", `/api/team/tasks/${task.id}/handoff/${task.handoff!.id}`, { body: { action: "maybe", revision: task.revision } }); assert.equal(badHandoffAction.status, 400);
  const accepted = await call(bob.actor, "runner", "POST", `/api/team/tasks/${task.id}/handoff/${task.handoff!.id}`, { body: { action: "accept", revision: task.revision } }); assert.equal(accepted.status, 200); assert.equal(accepted.json.owner.userId, "bob"); assert.equal(accepted.json.handoff, undefined); assert.equal(accepted.json.handoffs[0].state, "accepted"); assert.equal(accepted.json.attempts[0].state, "superseded", "the previous owner's paused attempt is superseded"); task = accepted.json;
  const next = randomBytes(16).toString("hex"), continued = await call(bob.actor, "runner", "POST", `/api/team/tasks/${task.id}/attempts`, { body: { attemptId: next, runnerId: bob.runner.id, runnerName: "bob-desktop", baseCommit: HEAD, fromCheckpointId: checkpoint.id, revision: task.revision } }); assert.equal(continued.status, 201); assert.equal(continued.json.attempts[1].fromCheckpointId, checkpoint.id); assert.equal(continued.json.attempts[1].baseCommit, HEAD);
  const lateAlice = await progress(alice.actor, { seq: 9 }); assert.equal(lateAlice.status, 409); assert.match(lateAlice.json.error, /superseded/);
  const done = await call(bob.actor, "runner", "POST", `/api/team/attempts/${next}/finish`, { body: { state: "finished", summary: "Shipped" } }); assert.equal(done.status, 200); assert.equal(done.json.attempt.state, "finished");
  const afterwards = await call(bob.actor, "runner", "POST", `/api/team/attempts/${next}/progress`, { body: { seq: 1 } }); assert.equal(afterwards.status, 409); assert.match(afterwards.json.error, /already ended/);
  // reviews attach to the checkpoint; a review request names the reviewer
  task = (await call(browser("rita"), "browser", "GET", `/api/team/tasks/${task.id}`)).json;
  const requested = await call(browser("bob"), "browser", "POST", `/api/team/tasks/${task.id}/review-request`, { body: { reviewer: "rita", revision: task.revision } }); assert.equal(requested.status, 200); assert.equal(requested.json.reviewer.userId, "rita"); task = requested.json;
  const malformedReview = await call(browser("rita"), "browser", "POST", `/api/team/tasks/${task.id}/reviews`, { body: { checkpointId: "nope", verdict: "approve", revision: task.revision } }); assert.equal(malformedReview.status, 400); assert.match(malformedReview.json.error, /checkpoint id/);
  const review = await call(browser("rita"), "browser", "POST", `/api/team/tasks/${task.id}/reviews`, { body: { checkpointId: checkpoint.id, verdict: "approve", text: "Ship it", revision: task.revision } }); assert.equal(review.status, 200); assert.equal(review.json.reviews[0].verdict, "approve"); assert.equal(review.json.reviews[0].stale, false); task = review.json;
  const viewerReview = await call(browser("vic"), "browser", "POST", `/api/team/tasks/${task.id}/reviews`, { body: { checkpointId: checkpoint.id, verdict: "approve", revision: task.revision } }); assert.equal(viewerReview.status, 403);
  const summary = (await call(browser("vic"), "browser", "GET", "/api/team/board")).json.tasks[0]; assert.equal(summary.reviewState, "approved"); assert.equal(summary.owner.userId, "bob"); assert.equal(summary.attempt, undefined, "a finished attempt is no longer the card's current one"); assert.equal(summary.checkpoint.id, checkpoint.id);
  // the inbox is personal: bob reads his, marks it read; a bad cursor is refused
  const inbox = await call(browser("bob"), "browser", "GET", "/api/team/inbox"); assert.equal(inbox.status, 200); assert.ok(inbox.json.unread >= 1); assert.ok(inbox.json.items.length >= 2); assert.ok(inbox.json.items.every((item: any) => item.userId === "bob")); assert.ok(inbox.json.items.some((item: any) => item.kind === "handoff-offered")); assert.ok(inbox.json.items.every((item: any, index: number, all: any[]) => index === 0 || all[index - 1].at >= item.at), "newest first");
  const since = await call(browser("bob"), "browser", "GET", `/api/team/inbox?after=${inbox.json.items[0].at}`); assert.equal(since.json.items.length, 0); assert.equal(since.json.unread, inbox.json.unread);
  const badAfter = await call(browser("bob"), "browser", "GET", "/api/team/inbox?after=soon"); assert.equal(badAfter.status, 400);
  const read = await call(browser("bob"), "browser", "POST", "/api/team/inbox/read", { body: { all: true } }); assert.equal(read.status, 200); assert.equal(read.json.unread, 0);
  const nothing = await call(browser("bob"), "browser", "POST", "/api/team/inbox/read", { body: {} }); assert.equal(nothing.status, 400);
  // runners: own list for members, everything for the owner; revocation is own-or-maintainer
  const mine = await call(browser("alice"), "browser", "GET", "/api/team/runners"); assert.deepEqual(mine.json.map((runner: any) => runner.id), [alice.runner.id]);
  const all = await call(owner, "owner", "GET", "/api/team/runners"); assert.equal(all.json.length, 2);
  const revokeOther = await call(browser("alice"), "browser", "DELETE", `/api/team/runners/${bob.runner.id}`, { body: {} }); assert.equal(revokeOther.status, 404);
  const revoked = await call(browser("bob"), "browser", "DELETE", `/api/team/runners/${bob.runner.id}`, { body: {} }); assert.deepEqual(revoked.json, { revoked: true }); assert.equal(store.authenticateRunner(bob.token), undefined, "a revoked credential authenticates nothing");
  const deleteByBob = await call(browser("bob"), "browser", "DELETE", `/api/team/checkpoints/${checkpoint.id}`, { body: {} }); assert.equal(deleteByBob.status, 403);
  const deleteTaskByBob = await call(browser("bob"), "browser", "DELETE", `/api/team/tasks/${task.id}`, { body: { revision: task.revision } }); assert.equal(deleteTaskByBob.status, 403);
});

test("recovery over HTTP requires task authority, a revision, a reason and confirmation; old runners remain fenced", async () => {
  const created = await call(owner, "owner", "POST", "/api/team/tasks", { body: { projectId: "p-1", repository: "app", title: "Recovery", owner: "alice" } }), id = "8".repeat(32);
  const claimed = await call(alice.actor, "runner", "POST", `/api/team/tasks/${created.json.id}/attempts`, { body: { attemptId: id, runnerId: alice.runner.id, runnerName: "laptop", baseCommit: BASE, revision: created.json.revision } }); assert.equal(claimed.status, 201);
  await call(alice.actor, "runner", "POST", `/api/team/attempts/${id}/finish`, { body: { state: "unknown" } });
  const current = await store.task(owner, created.json.id), path = `/api/team/attempts/${id}/recover`, body = { revision: current.revision, reason: "Checked the laptop: its agent is stopped", confirmedStopped: true };
  assert.equal((await call(browser("bob"), "browser", "POST", path, { body })).status, 403);
  assert.equal((await call(browser("alice"), "browser", "POST", path, { body: { ...body, confirmedStopped: false } })).status, 400);
  assert.equal((await call(browser("alice"), "browser", "POST", path, { body: { ...body, revision: 0 } })).status, 409);
  const recovered = await call(browser("alice"), "browser", "POST", path, { body }); assert.equal(recovered.status, 200); assert.equal(recovered.json.attempts[0].state, "superseded");
  assert.equal((await call(alice.actor, "runner", "POST", `/api/team/attempts/${id}/progress`, { body: { seq: 1 } })).status, 409);
  assert.equal((await call(alice.actor, "runner", "POST", `/api/team/attempts/${id}/heartbeat`, { body: {} })).status, 409);
});

test("projections never carry token hashes or the hub's file paths", () => {
  assert.ok(replies.length > 60, `expected the earlier tests to record many replies, got ${replies.length}`);
  for (const text of replies) { assert.equal(text.includes("tokenHash"), false, text.slice(0, 200)); assert.equal(text.includes(root), false, text.slice(0, 200)); assert.equal(text.includes(tmpdir()), false, text.slice(0, 200)); assert.doesNotMatch(text, /"\/(?:Users|private|var|tmp|home|etc)\//, text.slice(0, 200)); assert.equal(text.includes(alice.token), false); }
  const task = replies.map((text) => JSON.parse(text)).find((value) => value?.checkpoints?.length); assert.ok(task, "a full task was returned"); assert.equal(JSON.stringify(task).includes("bundlePath"), false); assert.deepEqual(Object.keys(task.attempts[0].user).sort(), ["displayName", "userId", "via"]);
});

test("the change stream says hello, relays only the actor's projects, counts the inbox, resyncs on role changes and caps four streams per account", async () => {
  const stream = await openStream(browser("alice"), "browser");
  assert.equal(stream.res.sentHeaders["content-type"], "text/event-stream; charset=utf-8");
  const hello = stream.frames()[0]; assert.equal(hello.type, "hello"); assert.equal(hello.epoch, store.epoch); assert.equal(typeof hello.seq, "number"); assert.equal(typeof hello.unread, "number"); assert.equal(stream.frames().length, 1);
  const commented = await call(browser("maya"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text: "Ping @alice" } }); assert.equal(commented.status, 200); await tick(); await tick();
  const frames = stream.frames().slice(1), change = frames.find((frame) => frame.type === "change"); assert.ok(change, JSON.stringify(frames)); assert.equal(change.kind, "task"); assert.equal(change.taskId, task.id); assert.equal(change.projectId, "p-1"); assert.ok(change.seq > hello.seq);
  const inbox = frames.find((frame) => frame.type === "inbox"); assert.ok(inbox, JSON.stringify(frames)); assert.ok(inbox.unread >= 1); assert.ok(inbox.seq >= change.seq);
  // work in a project where alice holds no role never reaches her stream, not even its id
  const revision = (await call(owner, "owner", "GET", "/api/team/board")).json.revision;
  assert.equal((await call(owner, "owner", "PUT", "/api/team/projects/p-2/repositories", { body: { repositories: [{ key: "secret", label: "Secret" }], revision } })).status, 200);
  const secret = await call(owner, "owner", "POST", "/api/team/tasks", { body: { projectId: "p-2", repository: "secret", title: "Hidden work", goal: "", acceptance: "" } }); assert.equal(secret.status, 201); await tick();
  assert.equal(stream.text().includes(secret.json.id), false); assert.equal(stream.text().includes("p-2"), false);
  // replay from a cursor: everything after it that alice may see; a foreign epoch asks for a resync; an oversized cursor is refused
  const cursor = `${store.epoch}:${hello.seq}`, replay = await openStream(browser("alice"), "browser", `?after=${cursor}`), replayed = replay.frames();
  assert.equal(replayed[0].type, "hello"); assert.ok(replayed.some((frame) => frame.type === "change" && frame.taskId === task.id)); assert.equal(replayed.some((frame) => frame.taskId === secret.json.id || frame.projectId === "p-2"), false); assert.equal(replayed.some((frame) => frame.type === "resync"), false);
  const foreign = await openStream(browser("alice"), "browser", `?after=${"0".repeat(16)}:1`); assert.deepEqual(foreign.frames().map((frame) => frame.type).slice(0, 2), ["hello", "resync"]);
  await assert.rejects(openStream(browser("alice"), "browser", `?after=${"x".repeat(101)}`), rejectsWith(400));
  const ownerStream = await openStream(owner, "owner", `?after=${cursor}`); assert.ok(ownerStream.frames().some((frame) => frame.taskId === secret.json.id), "the owner sees every project");
  // four per account: the fifth is refused before any header is written, and closing one frees a slot
  const fourth = await openStream(browser("alice"), "browser");
  await assert.rejects(openStream(browser("alice"), "browser"), rejectsWith(429, /Too many team event streams/));
  await fourth.close(); const fifth = await openStream(browser("alice"), "browser"); assert.equal(fifth.frames()[0].type, "hello");
  // revocation: once reauthorize throws, the next change closes the stream
  let revoked = false; const guarded = await openStream(browser("bob"), "browser", "", () => { if (revoked) throw new HttpError(401, "gone"); return browser("bob"); }); assert.equal(guarded.frames()[0].type, "hello");
  revoked = true; await call(browser("maya"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text: "Anyone?" } }); await tick(); assert.equal(guarded.res.destroyed, true);
  // a role change resyncs the client and widens what it sees from then on
  await foreign.close(); let roles: Record<string, SharedRole> = { "p-1": "contributor" }; const shifting = await openStream(browser("alice"), "browser", "", () => memberActor({ ...members[0]!, roles }, "browser")); assert.equal(shifting.frames().length, 1);
  roles = { "p-1": "contributor", "p-2": "viewer" }; const peek = await call(owner, "owner", "POST", `/api/team/tasks/${secret.json.id}/comments`, { body: { text: "Now visible" } }); assert.equal(peek.status, 200); await tick();
  assert.deepEqual(shifting.frames().slice(1).map((frame) => frame.type), ["resync", "change"]); assert.equal(shifting.frames()[2].taskId, secret.json.id); assert.equal(stream.text().includes(secret.json.id), false, "the unchanged stream still never saw p-2");
  for (const open of [stream, replay, fifth, ownerStream, shifting]) await open.close();
  const fresh = await openStream(browser("alice"), "browser"); assert.equal(fresh.frames()[0].type, "hello"); await fresh.close();
});

test("the connect handshake enrols a contributor's computer and refuses bad passwords, viewer-only accounts and insecure transports", async () => {
  const password = "a long local review password", accounts = new SharedAccounts(join(root, "connect", "shared-accounts.json")); await accounts.load();
  await accounts.create({ revision: 0, username: "alice", displayName: "Alice", password, roles: { "p-1": "contributor" } }); await accounts.create({ revision: 1, username: "vic", displayName: "Vic", password, roles: { "p-1": "viewer" } });
  const hub = new CollabStore({ dir: join(root, "connect", "team"), members: () => accounts.snapshot().users.map((user) => ({ userId: user.id, username: user.username, displayName: user.displayName, enabled: user.enabled, roles: user.roles })), projects: () => [{ id: "p-1", name: "App" }], ownerName: () => "Mx" }); await hub.load();
  const loopback = { address: "127.0.0.1", secure: false, loopback: true };
  const connect = async (body: unknown, transport = loopback, headers: Record<string, string> = { "content-type": "application/json" }) => { const req = fakeRequest("POST", headers, JSON.stringify(body)), { res, chunks } = fakeResponse(); await handleRunnerConnect(req as unknown as IncomingMessage, res as unknown as ServerResponse, { accounts, store: hub, transport }); return collect(res, chunks); };
  const ok = await connect({ username: "alice", password, name: "Alice's laptop" }); assert.equal(ok.status, 201, ok.text); assert.match(ok.json.token, RUNNER_TOKEN); assert.match(ok.json.runner.id, RUNNER_ID); assert.equal(ok.json.runner.name, "Alice's laptop"); assert.equal(ok.json.runner.online, true);
  assert.deepEqual(ok.json.user, { userId: ok.json.runner.userId, username: "alice", displayName: "Alice" }); assert.deepEqual(ok.json.hub, { name: "Mx" }); assert.equal(ok.text.includes(password), false); assert.equal(ok.text.includes("tokenHash"), false); assert.deepEqual(Object.keys(ok.json).sort(), ["hub", "runner", "token", "user"]);
  assert.deepEqual(hub.authenticateRunner(ok.json.token), { runnerId: ok.json.runner.id, userId: ok.json.user.userId }, "the credential authenticates on the hub");
  const wrong = await connect({ username: "alice", password: "not the password at all", name: "laptop" }); assert.equal(wrong.status, 401); assert.equal(wrong.json.error, "Invalid username or password");
  const viewer = await connect({ username: "vic", password, name: "laptop" }); assert.equal(viewer.status, 403); assert.equal(viewer.json.error, "Ask the team server's owner for a contributor role before connecting a computer"); assert.equal((await hub.runners(ownerActor())).length, 1, "a refused handshake registers nothing");
  const insecure = await connect({ username: "alice", password, name: "laptop" }, { address: "100.64.0.9", secure: false, loopback: false }); assert.equal(insecure.status, 403); assert.match(insecure.json.error, /HTTPS/);
  const tls = await connect({ username: "alice", password, name: "desk" }, { address: "100.64.0.9", secure: true, loopback: false }); assert.equal(tls.status, 201); assert.notEqual(tls.json.token, ok.json.token);
  const unnamed = await connect({ username: "alice", password }); assert.equal(unnamed.status, 400); assert.match(unnamed.json.error, /computer name/);
  await assert.rejects(connect({ username: "alice", password, name: "x" }, loopback, { "content-type": "text/plain" }), rejectsWith(415));
  const named = await connect({ username: "alice", password, name: "desk" }, { address: "100.64.0.9", secure: true, loopback: false }); assert.equal(named.status, 201); assert.equal(hub.authenticateRunner(ok.json.token)?.runnerId, ok.json.runner.id, "earlier credentials stay valid");
});

test("over a real socket a refused upload is answered, not cut off: the hub drains the body, so the runner reads the 409 its retry depends on and the connection stays usable", async () => {
  // A hub listener on an OS-assigned loopback port mounting handleTeamApi for alice's runner credential, the way server.ts does; a keep-alive agent with one socket shows whether a refusal left the connection usable.
  const server = createServer((req, res) => { void (async () => { const url = new URL(req.url ?? "/", "http://hub"), parts = url.pathname.slice(1).split("/"); try { await handleTeamApi(req, res, url, parts, { store, actor: alice.actor, principal: "runner", mutation: () => {} }); } catch (error) { if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }); } })(); });
  let connections = 0; server.on("connection", () => { connections++; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())); const port = (server.address() as AddressInfo).port, agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const mine = await store.createTask(owner, { projectId: "p-1", repository: "app", title: "Upload over a socket", owner: "alice" }), attemptId = randomBytes(16).toString("hex");
    await store.claimAttempt(alice.actor, mine.id, { attemptId, runnerId: alice.runner.id, runnerName: "alice-laptop", baseCommit: BASE, revision: mine.revision });
    const data = randomBytes(4 * 1024 * 1024), digest = sha256(data), checkpoint = await store.addCheckpoint(alice.actor, attemptId, { commit: HEAD, baseCommit: BASE, branch: `team/${mine.id}/00000000`, size: data.length, sha256: digest, note: "", requirements: "Upload", decisions: [], remaining: "", changedFiles: [] });
    const exchange = (method: string, path: string, headers: Record<string, string>, body?: Buffer) => new Promise<{ status: number; body: string }>((resolve, reject) => { const req = request({ host: "127.0.0.1", port, method, path, agent, headers }, (res) => { let text = ""; res.setEncoding("utf8"); res.on("data", (chunk: string) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text })); }); req.on("error", reject); req.end(body); });
    const upload = (headers: Record<string, string> = {}) => exchange("PUT", `/api/team/checkpoints/${checkpoint.id}/bundle`, { "content-type": "application/octet-stream", "content-length": String(data.length), "x-codeflow-sha256": digest, ...headers }, data);
    // refusals made before a byte of the 4 MiB body is read, on the headers and on the store's preconditions, all arrive as answers (a destroyed socket would surface here as EPIPE or ECONNRESET)
    const wrongType = await upload({ "content-type": "application/json" }); assert.equal(wrongType.status, 415); assert.match(wrongType.body, /application\/octet-stream/);
    const wrongDigest = await upload({ "x-codeflow-sha256": "0".repeat(64) }); assert.equal(wrongDigest.status, 400); assert.match(wrongDigest.body, /must match the checkpoint manifest/);
    const first = await upload(); assert.equal(first.status, 200, first.body);
    // every re-upload of the stored bundle is refused before a byte of its body is read; the runner must still receive the 409 its finish retry depends on, ten times out of ten
    for (let i = 0; i < 10; i++) { const again = await upload(); assert.equal(again.status, 409, `re-upload ${i + 1}: ${again.body}`); assert.match(again.body, /already uploaded/); }
    const me = await exchange("GET", "/api/team/me", {}); assert.equal(me.status, 200); assert.equal(me.body.includes('"userId":"alice"'), true);
    assert.equal(connections, 1, "every exchange travelled on the one keep-alive connection: no refusal cut it"); assert.equal((await store.task(owner, mine.id)).checkpoints[0]!.bundle, "available");
  } finally { agent.destroy(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("the opening replay is not mistaken for backpressure, and a stream closed during its replay takes its ping timer with it", async () => {
  const seq = store.eventsSince().seq; for (const text of ["one", "two"]) assert.equal((await call(browser("maya"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text } })).status, 200);
  // Node reports every frame after the first of a synchronous burst as unsent (the socket is corked until the next tick): a response that always says so still gets the whole replay and stays open
  const corked = fakeResponse(); corked.res.write = ((chunk: unknown) => { corked.chunks.push(Buffer.from(chunk as string)); return false; }) as typeof corked.res.write;
  const replay = await openStream(browser("alice"), "browser", `?after=${store.epoch}:${seq}`, undefined, corked), frames = replay.frames();
  assert.equal(frames[0].type, "hello"); assert.ok(frames.filter((frame) => frame.type === "change" && frame.taskId === task.id).length >= 2, JSON.stringify(frames)); assert.equal(replay.res.destroyed, false, "a corked replay is not a slow consumer");
  const later = await call(browser("maya"), "browser", "POST", `/api/team/tasks/${task.id}/comments`, { body: { text: "three" } }); assert.equal(later.status, 200); await tick(); assert.ok(replay.frames().length > frames.length, "live frames keep flowing"); await replay.close();
  // a stream that closes during the replay (here: a socket already holding 3 MiB) clears the ping timer it created, so nothing re-authorizes the principal every 15 s for the life of the process
  const created: NodeJS.Timeout[] = [], cleared: unknown[] = [], realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => { const timer = realSet(fn, ms, ...args); if (ms === 15_000) created.push(timer); return timer; }) as typeof setInterval;
  globalThis.clearInterval = ((timer: unknown) => { cleared.push(timer); realClear(timer as NodeJS.Timeout); }) as typeof clearInterval;
  try {
    const full = fakeResponse(); Object.defineProperty(full.res, "writableLength", { value: 3 * 1024 * 1024 });
    const closed = await openStream(browser("alice"), "browser", `?after=${store.epoch}:${seq}`, () => browser("alice"), full); assert.equal(closed.res.destroyed, true); assert.equal(closed.frames().length, 0, "nothing fits on a full socket");
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
  assert.equal(created.length, 1, "one ping timer per stream"); assert.ok(cleared.includes(created[0]), "the timer of a stream closed during its replay is cleared"); for (const timer of created) realClear(timer);
  const fresh = await openStream(browser("alice"), "browser"); assert.equal(fresh.frames()[0].type, "hello", "the closed stream freed its slot"); await fresh.close();
});

test("body limits fit model.ts's character bounds in UTF-8: a CJK checkpoint manifest and progress snapshot pass, as the same text in ASCII does", async () => {
  const mine = await store.createTask(owner, { projectId: "p-1", repository: "app", title: "CJK", owner: "alice" }), attemptId = randomBytes(16).toString("hex"), cjk = (n: number) => "字".repeat(n);
  await store.claimAttempt(alice.actor, mine.id, { attemptId, runnerId: alice.runner.id, runnerName: "alice-laptop", baseCommit: BASE, revision: mine.revision });
  const snapshot = { seq: 1, stage: cjk(200), summary: cjk(1365), changedFiles: Array.from({ length: 100 }, (_, i) => `${cjk(296)}${String(i).padStart(4, "0")}`), blockers: Array.from({ length: 10 }, (_, i) => `${cjk(499)}${i}`) };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024, "the snapshot is within every character bound yet larger than the old 64 KiB progress limit");
  const progress = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/progress`, { body: snapshot }); assert.equal(progress.status, 200, progress.text); assert.equal(progress.json.attempt.progress.changedFiles.length, 100);
  const id = randomBytes(16).toString("hex"), manifest = { id, commit: HEAD, baseCommit: BASE, branch: `team/${mine.id}/${id.slice(0, 8)}`, size: 10, sha256: sha256(Buffer.from("x")), note: cjk(4000), requirements: "r".repeat(16 * 1024), decisions: Array.from({ length: 100 }, (_, i) => `${cjk(1996)}${String(i).padStart(4, "0")}`), remaining: "m".repeat(8 * 1024), changedFiles: snapshot.changedFiles };
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 512 * 1024, "the manifest is within every character bound yet larger than the old 512 KiB manifest limit");
  const added = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: manifest }); assert.equal(added.status, 201, added.text); assert.equal(added.json.decisions.length, 100); assert.equal(added.json.id, id);
  const oversize = await call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/checkpoints`, { body: { ...manifest, id: randomBytes(16).toString("hex"), decisions: Array.from({ length: 100 }, (_, i) => `${cjk(2000)}${i}`) } }); assert.equal(oversize.status, 400); assert.match(oversize.json.error, /Keep the decision within 2000 characters/);
  await assert.rejects(call(alice.actor, "runner", "POST", `/api/team/attempts/${attemptId}/progress`, { raw: Buffer.alloc(TEAM_BODY_LIMIT.progress + 1, 0x20), headers: { "content-type": "application/json" } }), rejectsWith(413), "the limit itself still holds");
});

test("a maintainer deletes checkpoints and tasks; the handlers answer the store's shapes exactly", async () => {
  const gone = await call(browser("maya"), "browser", "DELETE", `/api/team/checkpoints/${checkpointId}`, { body: {} }); assert.deepEqual(gone.json, { deleted: true });
  const manifest = await call(browser("vic"), "browser", "GET", `/api/team/checkpoints/${checkpointId}`); assert.equal(manifest.json.bundle, "deleted");
  const noBundle = await call(browser("maya"), "browser", "GET", `/api/team/checkpoints/${checkpointId}/bundle`); assert.equal(noBundle.status, 404);
  task = (await call(browser("maya"), "browser", "GET", `/api/team/tasks/${task.id}`)).json;
  const noRevision = await call(browser("maya"), "browser", "DELETE", `/api/team/tasks/${task.id}`, { body: {} }); assert.equal(noRevision.status, 400);
  const deleted = await call(browser("maya"), "browser", "DELETE", `/api/team/tasks/${task.id}`, { body: { revision: task.revision } }); assert.deepEqual(deleted.json, { deleted: true });
  const afterwards = await call(browser("vic"), "browser", "GET", `/api/team/tasks/${task.id}`); assert.equal(afterwards.status, 404);
  await store.close();
});
