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
