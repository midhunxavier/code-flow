import assert from "node:assert/strict";
import { test } from "node:test";

Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const address = new URL("http://localhost:4317/#/team/task/t-1111111111111111");
Object.defineProperty(globalThis, "location", { configurable: true, value: address });
Object.defineProperty(globalThis, "history", { configurable: true, value: { state: null, replaceState(_state: unknown, _title: string, url: string) { address.href = url; } } });
const calls: string[] = [];
globalThis.fetch = (async (path: string) => { calls.push(path); return Response.json({ connections: [{ id: "local", linked: false }, { id: "c-1111111111111111", linked: true }] }); }) as typeof fetch;
const { initializeTeamConnection, apiPath } = await import("../ui/lib.js");

test("an unscoped tab pins its initial team before API calls, downloads and later inventory changes", async () => {
  await initializeTeamConnection();
  assert.equal(address.searchParams.get("team"), "c-1111111111111111");
  assert.equal(address.hash, "#/team/task/t-1111111111111111");
  assert.equal(apiPath("/api/team/tasks/t-same"), "/api/team/tasks/t-same?teamConnection=c-1111111111111111");
  assert.equal(apiPath("/api/team/checkpoints/same/bundle"), "/api/team/checkpoints/same/bundle?teamConnection=c-1111111111111111");
  assert.equal(apiPath("/api/team/board?project=p-same"), "/api/team/board?project=p-same&teamConnection=c-1111111111111111");
  assert.equal(apiPath("/api/team-link/tasks/t-same/start"), "/api/team-link/tasks/t-same/start?teamConnection=c-1111111111111111");
  assert.equal(apiPath("/api/project-teams"), "/api/project-teams");
  assert.equal(apiPath("/api/runs"), "/api/runs");
  await initializeTeamConnection();
  assert.equal(calls.length, 1, "the tab does not re-resolve its team from a changing inventory");
});
