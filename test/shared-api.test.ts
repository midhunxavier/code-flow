import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { HttpError } from "../src/http.js";
import { handleSharedApi } from "../src/shared-api.js";
import type { Run, RunSummary } from "../src/engine.js";

test("shared cold history searches complete authorized tasks without hydrating or matching another project or owner-only fields", async () => {
  const identity = { kind: "shared", userId: "u-fixture", username: "viewer", displayName: "Viewer", revision: 1, roles: { one: "viewer", two: "viewer" } };
  const row = (id: string, project: string): RunSummary => ({ id, project, repo: `/private/${project}`, task: "preview ".repeat(1100), pattern: "solo", cold: true, detailAvailable: true, createdAt: 1, worktrees: [] }) as unknown as RunSummary;
  const summaries = [row("visible", "one"), row("other-assigned", "two"), row("unauthorized", "three")], reads: string[] = [];
  const full = { ...summaries[0], task: `${"preview ".repeat(1100)} deep-authorized-needle`, steps: [] } as unknown as Run;
  const host = { token: "session", identity, accounts: { authenticate: () => identity }, projects: { list: () => ["one", "two", "three"].map((id) => ({ id, name: id, repos: [`/private/${id}`], createdAt: 1 })) }, manager: { list: () => summaries, get: (id: string) => { reads.push(id); return id === "visible" ? full : { ...summaries.find((run) => run.id === id)!, task: "deep-authorized-needle", steps: [] }; } }, comments: {}, patterns: [], templates: [] } as any;
  async function request(query: string) { let value: any, status = 0; const req = { method: "GET" } as IncomingMessage, res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { value = JSON.parse(body); } } as unknown as ServerResponse; await handleSharedApi(req, res, new URL(`http://localhost/api/runs?project=one&q=${query}`), ["api", "runs"], host); assert.equal(status, 200); return value; }
  const page = await request("deep-authorized-needle"); assert.equal(page.total, 1); assert.deepEqual(page.runs.map((run: any) => run.id), ["visible"]); assert.deepEqual(reads, ["visible"]); assert.equal(page.runs[0].cold, true); assert.equal(page.runs[0].detailAvailable, true);
  reads.length = 0; assert.equal((await request("private")).total, 0, "repository paths never enter shared search"); assert.deepEqual(reads, ["visible"]);
  reads.length = 0; assert.equal((await request("")).total, 1); assert.deepEqual(reads, [], "unfiltered history keeps its bounded cold preview");
});

test("collaboration comments accept reviewer, contributor and maintainer roles while a viewer stays read-only", async () => {
  const head = "a".repeat(40), run = { id: "visible", project: "one", repo: "/private/one", task: "Shared result", pattern: "solo", status: "done", createdAt: 1, worktrees: [{ name: "result", branch: "result", path: "/private/tree" }], steps: [] } as unknown as Run;
  for (const [role, expected] of [["viewer", 403], ["reviewer", 201], ["contributor", 201], ["maintainer", 201]] as const) {
    const identity = { kind: "shared", userId: "u-fixture", username: role, displayName: "Teammate", revision: 1, roles: { one: role } }, added: string[] = []; let authorizations = 0;
    const host = { token: "session", identity, accounts: { authenticate: () => identity }, projects: { list: () => [{ id: "one", name: "one", repos: ["/private/one"], createdAt: 1 }] }, manager: { list: () => [run], get: (id: string) => id === run.id ? run : undefined, reviewCoverage: async () => ({ head, files: [], reviewed: [] }) }, comments: { add: async (runId: string, input: { text: string }, actor: { id: string; name: string }, resolveHead: () => Promise<string>, authorize?: () => void) => { authorize?.(); assert.equal(await resolveHead(), head); authorize?.(); authorizations++; added.push(`${runId}:${actor.id}:${input.text}`); return { revision: 1, comments: [{ id: "c1", actor, text: input.text, branch: "result", head, at: 1 }] }; } }, patterns: [], templates: [] } as any;
    let status = 0, body: any; const stream = Object.assign(new PassThrough(), { method: "POST", headers: { "content-type": "application/json" } }), res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = JSON.parse(text); } } as unknown as ServerResponse;
    stream.end(JSON.stringify({ branch: "result", expectedHead: head, text: `Looks good from a ${role}` }));
    const request = handleSharedApi(stream as unknown as IncomingMessage, res, new URL("http://localhost/api/runs/visible/collaboration"), ["api", "runs", "visible", "collaboration"], host);
    if (expected === 201) { await request; assert.equal(status, 201); assert.equal(authorizations, 1); assert.deepEqual(added, [`visible:shared:u-fixture:Looks good from a ${role}`]); assert.equal(body.comments[0].text, `Looks good from a ${role}`); }
    else { await assert.rejects(request, (error: unknown) => error instanceof HttpError && error.status === 403 && /reviewer role is required/.test(error.message)); assert.deepEqual(added, [], "a viewer's comment is refused before any store access"); }
  }
});

test("unpublished task drafts stay private across shared history, events and run routes", async () => {
  const identity = { kind: "shared", userId: "u-drafts", username: "maintainer", displayName: "Teammate", revision: 1, roles: { one: "maintainer" } };
  const visible = { id: "visible", project: "one", repo: "/repo/one", task: "Published work", pattern: "solo", status: "done", createdAt: 1, worktrees: [], steps: [] } as unknown as Run;
  // No explicit project is not sufficient: legacy runs inherit access from their repository.
  const drafts = ["one", undefined].map((project, index) => ({ ...visible, id: `draft-${index}`, project, pattern: "team-task-draft", task: "Unreviewed private idea", summary: "Unreviewed private result" }));
  const runs = [visible, ...drafts]; let listener: (run: RunSummary) => void = () => undefined;
  const host = { token: "session", identity, accounts: { authenticate: () => identity, onChange: () => () => undefined }, projects: { list: () => [{ id: "one", name: "One", repos: ["/repo/one"], createdAt: 1 }], onChange: () => () => undefined }, manager: { list: () => runs.map((run) => ({ ...run, cold: true })), get: (id: string) => runs.find((run) => run.id === id), subscribeAll: (fn: typeof listener) => { listener = fn; return () => undefined; } }, comments: {}, patterns: [], templates: [] } as any;
  for (const query of ["", "?project=one", "?q=Unreviewed"]) {
    let body: any; const res = { writeHead: () => undefined, end: (text: string) => { body = JSON.parse(text); } } as unknown as ServerResponse;
    await handleSharedApi({ method: "GET" } as IncomingMessage, res, new URL(`http://localhost/api/runs${query}`), ["api", "runs"], host);
    assert.deepEqual(body.runs.map((run: Run) => run.id), query.includes("q=") ? [] : ["visible"]);
  }
  for (const draft of drafts) for (const suffix of ["", "/export", "/events", "/diff", "/review-coverage", "/collaboration"]) {
    const path = `/api/runs/${draft.id}${suffix}`;
    await assert.rejects(handleSharedApi({ method: "GET" } as IncomingMessage, {} as ServerResponse, new URL(`http://localhost${path}`), path.slice(1).split("/"), host), (error: unknown) => error instanceof HttpError && error.status === 404);
  }
  const frames: string[] = [], stream = Object.assign(new PassThrough(), { writeHead: () => undefined }); stream.on("data", (chunk) => frames.push(String(chunk)));
  try {
    await handleSharedApi({ method: "GET" } as IncomingMessage, stream as unknown as ServerResponse, new URL("http://localhost/api/events"), ["api", "events"], host);
    const initial = frames.join(""); assert.ok(initial.includes("visible")); assert.equal(initial.includes("draft-"), false);
    frames.length = 0; for (const draft of drafts) listener(draft as unknown as RunSummary);
    assert.deepEqual(frames, [], "live notifications do not reveal private drafts");
    listener(visible as unknown as RunSummary); assert.ok(frames.join("").includes("visible"));
  } finally { stream.destroy(); }
});
