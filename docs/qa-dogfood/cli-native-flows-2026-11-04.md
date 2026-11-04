# Native CLI end-to-end flow validation — 2026-11-04

The requested flow matrix passed through both native CLIs in separate disposable Git repositories, each with isolated Codeflow state and an owner on a temporary port. The final suites each passed 14 scenario groups. A further native Codex run passed the cancellation regressions after the fix.

## Tested configurations

| Host | Version | Host model | Managed workers |
| --- | --- | --- | --- |
| Codex CLI app-server | 0.165.0 | gpt-6-luna, high | Claude haiku-5-5 and Codex gpt-6-luna, high |
| Claude Code stream-json | 2.1.318 | claude-sonnet-5-5, high | Claude haiku-5-5 and Codex gpt-6-luna, high |

Both hosts discovered fourteen MCP tools and the Codeflow skill. Both executed a natural-language connection request. Codex's remaining deterministic test operations used its native `mcpServer/tool/call` API; Claude's operations were actual model turns invoking the MCP tools. A transparent stdio recorder retained the actual tool responses. A separate read-only observer synchronized assertions with the owner; it did not perform tested workflow mutations.

Native confirmation requests traversed each actual CLI. The driver replied with scoped accept/decline fixture responses, matching the proposal/run before responding. This verifies the native protocol, not a human clicking through or visually inspecting a terminal dialog. No production proposal or handoff was approved by the driver.

## Flow matrix

| Scenario | Codex | Claude |
| --- | --- | --- |
| Connection, providers, tools and skill | Pass | Pass |
| Proposal preview; decline starts no work | Pass | Pass |
| Accept starts one run; duplicate start returns it | Pass | Pass |
| Unanswered task question clearly waits without worker calls | Pass | Pass |
| Pause/resume while awaiting input | Pass | Pass |
| Guidance saved and delivered to the next managed worker | Pass | Pass |
| Close native CLI during accepted work; reconnect and find the same run | Pass | Pass |
| Real plan and independent agreement review | Pass | Pass |
| Continue the plan into the same chat with retained context | Pass | Pass |
| Real implementation, fixed check and independent code review | Pass | Pass |
| Pause active execution, observe settling, resume | Pass | Pass |
| Retrieve the complete result across multiple pages | Pass | Pass |
| Cancel active execution and preserve work | Pass | Pass |
| Read complete diff; decline application leaves checkout unchanged | Pass | Pass |
| Dirty checkout, stale preview and committed conflict block application | Pass | Pass |
| Approved application stages only app.mjs; destination tests pass | Pass | Pass |
| Duplicate apply with same or new operation ID does not replay changes | Pass | Pass |
| Cancel unanswered question without launching workers | Pass | Pass |
| Owner restart preserves application receipt | Pass | Pass |

Each final full suite used four real managed worker calls: two for plan/agreement and two for implementation/review. Host model turns are additional calls; this is not a total usage or billing count. Codex wrote the Codex fixture and Claude independently reviewed it; Claude wrote the Claude fixture and Codex independently reviewed it. Original tests stayed byte-identical. Applying the result did not change HEAD or create a commit/push. The destination checks were separately executed after staging.

## Product fixes found by this test

Cancellation stopped execution correctly, but its readable status only said “Stopped,” listed the unanswered task question as though it still needed an answer, and marked the interrupted activity as failed.

The fix:

- Explicit cancelled progress and a message that work stopped and completed work is preserved.
- No pending questions or host assignments after execution ends; historical records remain intact.
- Reject late answers to stopped task questions.
- No reconnection/attachment instruction for a stopped host-bound assignment.
- Activity interrupted by cancellation/shutdown is marked interrupted rather than failed.

The fixed cancellation paths were exercised in a fresh native Codex regression run and the final full Claude run. Automated regressions also cover late answers and cancelled host-bound assignments.

## Validation and installation

- CLI/team and presentation suite: 47 passed before the final host-assignment regression was added.
- Final targeted cancellation run: 3 passed, including the additional host-assignment regression.
- Workspace/browser synchronization and task conversations: 34 passed.
- Final packaged-runtime suite: 13 passed.
- Typecheck, source syntax checks, package build and git diff whitespace check: passed.
- Rebuilt and reinstalled 0.1.0-preview.10 at the existing `~/.local` installation. Confirmed the installed progress, presentation, service and workflow files match the rebuilt package.
- Checked for active work before gracefully restarting the user's owner. Its existing web port was retained.
- Fresh installed-host discovery passed in both CLIs: fourteen tools, skill present, live compatible connection, current project configuration. `codeflow doctor --catalog` passed.

This change used focused regression and live-flow suites; it did not rerun every unrelated repository test. The earlier broad-suite results are in `cli-ux-2026-11-04.md`.

## Harness failures and model limitation

Early attempts exposed test-driver issues: source loader resolution outside the repository, matching handoff confirmation against its schema instead of just its message, Claude's decline response requiring omitted rather than null content, and keeping the auxiliary observer connection alive during long host turns. These were corrected. A harmless task-list call during connection discovery was allowed. Failed attempts were retained and were not counted as passing full suites.

Haiku as the **host** intermittently emitted malformed JSON for the large proposal tool call, rejected by Claude Code before it reached Codeflow. One corrective retry was allowed only when no invocation reached the MCP server, preserving the same operation ID. This did not consistently resolve the provider-generated formatting failure. The final full Claude suite used Sonnet and passed. Haiku remained a real managed planning/writing/review worker. This is a remaining host-model limitation, not a claim that all models or arbitrary prompts are reliable.

A previous Haiku-host attempt passed through application and destination tests, but stopped near the end because the test observer expired. That attempt is partial evidence only; the final Sonnet run completed the entire matrix after the observer fix.

## Reproduce

```sh
CODEFLOW_TEST_LIVE_AGENTS=1 npm run test:cli-native-flows:live
```

This spends real host and managed-provider calls. It creates new temporary repositories and state; it does not use the working repository as a task target. Logs and wire evidence stay in the printed temporary directory with private permissions. Never publish those raw logs without review.

Optional selection:

```sh
CODEFLOW_TEST_LIVE_AGENTS=1 CODEFLOW_TEST_HOSTS=codex npm run test:cli-native-flows:live
CODEFLOW_TEST_LIVE_AGENTS=1 CODEFLOW_TEST_HOSTS=claude CODEFLOW_TEST_FOCUS=cancellation npm run test:cli-native-flows:live
```

`CODEFLOW_TEST_CLAUDE_HOST_MODEL` explicitly overrides the default Sonnet host model. It does not change the managed workers.

## Local evidence

Temporary evidence may be cleaned by the operating system. Each final directory contains the structured scenario report, actual MCP response journal, owner log and destination test output.

- Full Codex suite: `/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-native-flows-tVKiGf`
- Codex cancellation rerun: `/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-native-flows-ueqhWc`
- Full Claude suite: `/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-native-flows-EYqjuI`
- Partial Haiku-host suite: `/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-native-flows-aA9k01`

## Pre-merge CI follow-up

The first PR CI run exposed a terminal restart race in browser shard 2: restarting a remembered terminal can issue DELETE using a cached shell list after the server has already lost that shell. The resulting 404 polluted the otherwise successful browser flow. Closing an already-removed shell now returns HTTP 200 with `closed: false`; reads and input still return 404. This also handles another tab closing the shell concurrently.

The added API regression first reproduced the 404, then passed after the fix. The complete side-panel API suite passed 13 tests, and all eight side-notes/terminal browser tests passed without relaxing their network-error audit. The fix is included in the PR for a fresh complete CI run.
