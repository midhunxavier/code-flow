# Native approval and active-writer crash testing — 2026-11-03

## Live results

Real terminal interfaces, not simulated MCP confirmation callbacks:

| Host | Model / effort | Decline | Approve |
| --- | --- | --- | --- |
| Claude Code 2.1.317 | `claude-haiku-5-5` / high | Native form declined; no execution created | Checked the initially unchecked approval field and accepted; one execution started |
| Codex CLI 0.165.0 | `gpt-6-luna` / high | Native form submitted with `False`; no execution created | Selected `True`; one execution started |

The second start reused the exact proposal, revision, hash and operation ID. Native transcript tool results independently confirm `acceptance_declined`, then a single successful run ID. Claude's separate MCP tool-use permission prompt was also exercised. Folder trust was granted only for the newly created disposable fixture. No approval bypass flags were used.

| Interrupted writer | Crashed execution | Reviewed continuation | Result |
| --- | --- | --- | --- |
| Haiku | `2611031648-fba7df20` | `2611031650-1ffe8f33` | Haiku repaired; Luna approved; checks passed |
| Luna | `2611031655-340e924f` | `2611031655-40283518` | Luna repaired; Haiku approved; checks passed |

Each crash occurred after a real worker wrote the still-incomplete source file (`value = 1`), appended one event to a tracked ledger, and created an untracked proof file, while its shell command was still running. The ledger was the tracked change at this checkpoint; the source still had its initial value. The test sent **SIGKILL to the Code Flow owner only**, leaving the worker for startup recovery to reap. This exercises actual orphan cleanup, not a graceful shutdown or manually killing the worker first.

On restart, the worker process was no longer live, all four observed files retained their exact bytes, one managed call remained charged, and no automatic writer replay occurred. A resume request was fenced. The new reviewed continuation explicitly selected the untracked proof file and inherited the previous worktree snapshot and chat. Only the remaining source correction was needed. The ledger and proof remained unchanged, tests were not edited, and an independent Node test rerun passed. The original checkout HEAD and status remained unchanged.

Total: six real managed calls (including two interrupted calls), plus four native host turns for the approval interactions. Both providers were pinned to high effort; dispatch receipts and native sessions were recorded.

## Fixes

1. An unsettled writer now sets `recovery.requiresReview` during startup. Previously it could report false until an attempted replay reached the execution guard.
2. Resume now explains the required inspection and reviewed continuation before reporting an exhausted time allowance. It mentions selecting untracked files and does not dispatch another writer.
3. Durable launch receipts include read/write mode, so recovery can recognize an interrupted writer even when the step projection was not saved. Older receipts use the persisted step mode. Settled writes are not falsely fenced.
4. Native approval previews show setup/check commands, limits and permissions before long workflow instructions. The actual terminal test showed these decisions being pushed below the visible form by lengthy instructions. No approval fields, authority or default values changed.

Validation: 110 regression tests passed, including 17 browser tests and the process-cleanup foundation tests. Typecheck, build and the interactive helper syntax check passed. The preview ordering change was checked by regression tests; the real terminal interactions used the prior ordering.

The first crash test stopped at its resume assertion because conservative recovery charged the lost invocation's full reservation and returned `budget_exhausted`. After correcting the recovery guidance, testing continued from that same preserved fixture rather than repeating the original write. Both continuations completed successfully.

## Reproduce

```sh
CODEFLOW_TEST_LIVE_AGENTS=1 npm run test:cli-crash:live
```

Requires authenticated Claude/Codex CLIs with the pinned models. This is an interactive, paid-provider test. The harness prints a command for a second terminal:

```sh
node scripts/cli-native-approval-live.mjs /path/printed/by/test/native-current.json
```

For each host, inspect the exact fixture proposal, decline once, then ask the host to request start again with the same arguments. Approve the second native form. The helper never answers the form automatically. Close the native CLI after it reports the run ID. The harness crashes the isolated owner, verifies preservation, accepts the bounded recovery proposal through the private owner API under the opt-in test authorization, and runs the independent review. Repeat the helper command when the harness prints the Codex phase.

The native confirmation test covers the initial crash run; continuation approvals use the owner API. The harness uses a temporary repository/home and random port, then stops its own server. It never touches development ports 4317/4318 or performs push, merge or deployment.

## Evidence and limits

Local evidence (not committed):
`/private/var/folders/8g/_7c6f3pn6bs_nb97tkbl2t7m0000gn/T/codeflow-crash-live-eTJbpb`

- `claude-native-dialog-receipts.json`, `codex-native-dialog-receipts.json`: native tool call and result evidence for decline/approve.
- `{haiku,luna}-before-crash.json`: active step and exact saved file contents.
- `{haiku,luna}-processes.json`: worker groups left for startup recovery.
- `{haiku,luna}-after-crash.json`, `{haiku,luna}-fenced.json`: interrupted status, preserved accounting, review requirement and unchanged invocation count.
- `{haiku,luna}-recovery-{status,artifacts,run}.json`: actual participants, settings, sessions, checks and reviews.
- `{haiku,luna}-independent-check.txt`: independently rerun checks.

This demonstrates preservation of **saved work** and prevention of automatic duplicate execution in these two fixtures. It does not promise recovery of unsaved model output, atomicity of arbitrary writes interrupted between bytes, or exactly-once external effects such as remote API calls. Both interrupted commands were killed after their fixture writes landed, during their explicit wait.
