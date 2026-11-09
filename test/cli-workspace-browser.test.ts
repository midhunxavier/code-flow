import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceHandoffs } from "../src/cli-teams/browser.js";
import { requestLogPath } from "../src/log.js";

test("workspace browser handoffs expire, are single-use, and cannot redirect outside a task", () => {
  let now = 1000; const handoffs = new WorkspaceHandoffs(() => now);
  const path = `/?team=local#/chat/${"a".repeat(32)}`;
  const ticket = handoffs.issue(path); assert.match(ticket, /^[a-f0-9]{64}$/);
  assert.equal(handoffs.consume(ticket), path); assert.equal(handoffs.consume(ticket), undefined);
  const expired = handoffs.issue(path); now += 60_000; assert.equal(handoffs.consume(expired), undefined);
  const approval = handoffs.issue(path, 10 * 60_000, 16, false);
  assert.deepEqual(handoffs.redeem(approval), { path, signIn: false }, "an approval link never signs a browser in");
  assert.deepEqual(handoffs.redeem(handoffs.issue(path)), { path, signIn: true });
  for (const path of ["https://evil.example", "//evil.example", "/?token=secret", "/?team=remote#/chat/abc", "/?team=local#/chat/../../settings"])
    assert.throws(() => handoffs.issue(path), /Invalid workspace destination/);
  assert.equal(requestLogPath(`/cli-workspace/${ticket}?other=secret`), "/cli-workspace/[redacted]");
  assert.equal(requestLogPath(`/%63li-workspace/${ticket}`), "/%63li-workspace/[redacted]");
});
