import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRemote } from "../src/remote.js";
import type { Run, RunManager } from "../src/engine.js";

test("phone inbox surfaces team questions and escapes agent text without granting control", () => {
  const run = { id: "team-phone", task: "Implement utility", pattern: "auto-team", repo: "/tmp/repository", createdAt: Date.now(), status: "running", seen: true, artifacts: [], steps: [],
    team: { status: "blocked", revision: 2, awaitingRequestId: "question", metrics: { invocations: 3, coordinatorInvocations: 1 },
      members: [{ id: "worker", name: "Builder" }], tasks: [{ id: "build", title: "Utility", owner: "worker", status: "needs_info", dependsOn: [] }],
      messages: [{ id: "question", kind: "question", sender: "worker", recipient: "user", status: "open", body: '<script>alert("x")</script> Is empty input valid?', deadlineAt: Date.now() + 10_000 }], gaps: ["Input behavior needs an answer"],
    },
  } as unknown as Run;
  const manager = { list: () => [run], get: (id: string) => id === run.id ? run : undefined } as unknown as RunManager;
  const inbox = renderRemote(manager, [], "/r/secret", "/")!;
  assert.match(inbox, /Needs you \(1\)/);
  assert.match(inbox, /Waiting for you/);
  const detail = renderRemote(manager, [], "/r/secret", `/run/${run.id}`)!;
  assert.match(detail, /Open questions/);
  assert.match(detail, /Builder → You/);
  assert.match(detail, /&lt;script&gt;/);
  assert.doesNotMatch(detail, /<script>|<form|<button|\/api\//);
  assert.match(detail, /3 lifetime calls \(1 coordinating\)/);
  assert.match(detail, /full-control app/);
});
