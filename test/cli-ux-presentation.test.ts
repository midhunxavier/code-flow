import { test } from "node:test";
import assert from "node:assert/strict";
import { runProgress } from "../src/cli-teams/progress.js";
import { formatStatus, formatToolResult } from "../src/cli-teams/presentation.js";
import type { Run } from "../src/engine.js";

function fixture(): Run { return { status: "running", steps: [], notes: [], cliTeam: { questions: {}, pending: {}, activity: [] } } as unknown as Run; }
test("progress distinguishes queues, pause settling, user/host waits and interrupted writers", () => {
  const r = fixture(); assert.equal(runProgress(r).phase, "working");
  r.cliTeam!.waitingForSlot = true; assert.equal(runProgress(r).phase, "queued");
  r.cliTeam!.pending.x = { id: "x" } as any; assert.equal(runProgress(r).phase, "waiting_host");
  r.cliTeam!.questions.x = { question: "Proceed?", options: ["yes", "no"] }; assert.equal(runProgress(r).phase, "waiting_user");
  r.pauseRequested = true; assert.equal(runProgress(r).phase, "paused");
  r.steps.push({ id: "worker", status: "running", title: "Implement", role: "builder" } as any);
  assert.equal(runProgress(r).phase, "pausing");
  assert.match(formatStatus({ progress: runProgress(r) }), /Pause requested; active work is finishing/);
  r.status = "stopped"; r.cliTeam!.recoveryRequired = true;
  assert.equal(runProgress(r).phase, "recovery");
  assert.equal(runProgress(r).needsAttention, true);
});
test("cancelled work is explicit and does not request attention", () => {
  const r = fixture(); r.status = "cancelled";
  const progress = runProgress(r);
  assert.equal(progress.phase, "cancelled"); assert.equal(progress.needsAttention, false);
  assert.match(formatStatus({ progress }), /Cancelled\. Work has stopped/);
});
test("MCP summaries preserve paging and references while keeping claim secrets out of text", () => {
  const artifact = formatToolResult("codeflow_get_artifact", { ok: true, data: { id: "a-1", sha256: "hash", body: "Actual result", nextCursor: 12000, data: { nextFileCursor: 100 } } });
  assert.match(artifact, /Actual result/); assert.match(artifact, /12000/); assert.match(artifact, /fileCursor 100/);
  const claim = formatToolResult("codeflow_claim_step", { ok: true, data: { claimToken: "SECRET", assignment: { id: "review", instructions: "Read the exact target" } } });
  assert.doesNotMatch(claim, /SECRET/); assert.match(claim, /Read the exact target/);
  for (const [status, expected] of [["queued", /not yet delivered/], ["delivered", /delivered to a worker/], ["undelivered", /not delivered before work stopped/]] as const) {
    assert.match(formatToolResult("codeflow_steer_run", { ok: true, data: { noteId: "n1", delivery: status, runId: "r1" } }), expected);
  }
  assert.match(formatToolResult("codeflow_get_run", { ok: true, data: { status: "running", afterCursor: 42, runId: "r1" } }), /event cursor: 42/);
});
