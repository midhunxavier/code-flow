import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceForRerun } from "../ui/rerun-draft.js";
import type { SourcePick } from "../ui/state.js";
import type { RunSource } from "../src/github.js";

const pick: SourcePick = { kind: "pr", number: 1, title: "Fix", url: "https://github.com/o/r/pull/1" };
const original: RunSource = { ...pick, body: "Context" };

test("unchanged source context is inherited while both directions of CI-log editing are explicit", () => {
  assert.equal(sourceForRerun(pick, original), undefined);
  assert.equal(sourceForRerun({ ...pick, ciLogs: true }, original)?.ciLogs, true);
  const withLogs = { ...original, ci: { failing: [], logs: "" } };
  assert.equal(sourceForRerun({ ...pick, ciLogs: true }, withLogs), undefined);
  assert.equal(sourceForRerun({ ...pick, ciLogs: false }, withLogs)?.ciLogs, false);
  assert.equal(sourceForRerun(pick)?.kind, "pr");
  assert.equal(sourceForRerun({ ...pick, number: 2 }, original)?.number, 2);
});

test("changing an alert tool or its covered numbers refreshes source context", () => {
  const alert = { ...pick, kind: "alert", tool: "code-scanning", numbers: [1, 2] } as SourcePick;
  const source = { ...original, kind: "alert", alert: { tool: "code-scanning", numbers: [1, 2] } } as RunSource;
  assert.equal(sourceForRerun(alert, source), undefined);
  assert.equal(sourceForRerun({ ...alert, tool: "dependabot" }, source)?.tool, "dependabot");
  assert.deepEqual(sourceForRerun({ ...alert, numbers: [1, 3] }, source)?.numbers, [1, 3]);
});
