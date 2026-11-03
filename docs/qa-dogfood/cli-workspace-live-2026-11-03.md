# Real-provider CLI workspace test — 2026-11-03

Tested the CLI proposal → plan agreement → implementation → failed check/review → recovery → verified result flow with real managed Claude and Codex workers. No fake provider supplied these nine live responses.

## Results

| Phase | Run | Real calls | Result |
| --- | --- | --- | --- |
| Read permissions | `2611031551-65fd415b` | Haiku 1, Luna 1 | Both read `app.mjs`; writes were blocked |
| Plan agreement | `2611031552-5c8f4def` | Haiku 2, Luna 1 | Haiku drafted; both approved the plan |
| Implementation and recovery | `2611031552-7b869835` | Haiku 2, Luna 2 | First check failed and Luna rejected; repaired snapshot passed checks and Luna approved |

All assignments recorded `claude-haiku-5-5` or `gpt-6-luna` with `high` effort and a native session ID. Model and effort evidence describes recorded dispatch settings, not independent provider attestation of internal computation.

Haiku's native Bash result was “This command requires approval”; the command did not execute. Luna's native session recorded the attempted write failing with `EPERM`, exit code 1. Both read the actual source and no permission-probe file was created. The Luna native tool receipt was checked separately from its textual review.

The fixture starts with `value = 1` and an immutable Node test expecting `2`. Haiku deliberately retained the broken value on pass one, as instructed for failure injection. Luna independently identified the mismatch and returned `changes_requested`. Code Flow was stopped gracefully at the pending user-decision checkpoint, restarted with the same state directory, then resumed through MCP. The run retained its chat, two completed calls, worktree and prior review. After answering the checkpoint, Haiku changed the value to `2`; the fixed test passed and Luna returned `approve`. Total implementation calls remained four. An independent test rerun also passed. Only `app.mjs` changed; original checkout HEAD and status stayed unchanged.

Browser inspection confirmed all three tasks in one chat, including “Plan agreed”, “Changes verified”, both review passes, the failed first gate, and Haiku/Luna high-effort participation with native session receipts.

## Issues found and fixed

- Routine Codex `remoteControl/status/changed` notifications caused misleading unknown-protocol warnings. Recognize this bookkeeping notification while retaining warnings for genuinely unknown output. The fake app-server emits it in regression tests.
- Resuming a completed task correctly returned `accepted: false`, but added “Resume requested from CLI” to the chat. Declined controls no longer create workspace events. Regression coverage checks the no-op, idempotent replay and reconciliation.

The full live run preceded these two small fixes. Their regressions were validated separately; the reusable live script now also asserts that declined resumes leave the chat unchanged.

Validation after the fixes: 73 adapter/CLI/handoff tests and 50 conversation/browser tests passed (123 total, including 17 real-browser tests with deterministic providers). Typecheck and build passed. Browser tests cover approval synchronization and owner restart without spending additional provider calls.

## Reproduce

```sh
CODEFLOW_TEST_LIVE_AGENTS=1 npm run test:cli-workspace:live
```

Requires authenticated native Claude/Codex CLIs with the pinned models available. This command spends real provider calls: at most 12 across the three phases. It creates an isolated temporary repository, state directory and random local port, preserves evidence, and stops its own server. It does not use the development server on 4317/4318. It does not push or deploy.

The operator's explicit opt-in accepts the exact bounded test proposals through the private owner API; start, status, artifacts, checkpoint answers and recovery use public stdio MCP. This test does **not** certify native human approval dialogs, arbitrary shell permissions, abrupt termination during a write, or all failure modes. Restart recovery was tested at a settled review checkpoint.

## Evidence

Local evidence directory (temporary, not committed):
`/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-team-live-wWFzDj`

- `report.json`: models, efforts, native session IDs, calls, review decisions and shared workspace IDs.
- `permissions-artifacts.json` and `luna-native-permission-receipt.json`: permission observations and the native Codex denial.
- `before-restart.json`, `after-restart.json`: preserved call budget and interrupted execution.
- `repair-recovery-artifacts.json`: failed/passed checks and rejected/approved reviews.
- `independent-check.txt`: independent passing test output.
- Browser screenshot: `output/playwright/cli-live-participation.png` (ignored local artifact).

The temporary test server is shut down after verification; its workspace URL is not a persistent demo link.
