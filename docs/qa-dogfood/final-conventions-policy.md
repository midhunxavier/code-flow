# Final conventions policy guard

A final filesystem-policy replay found that opening Settings → Projects mounted ConventionsPanel and fetched private guidance for a restricted project, returning 403. The UI now uses the selected project's `filesystemRestricted` inventory flag to pause conventions reads and actions, with a notice naming that project and a policy link that stays on it. The backend gate is unchanged. This distinction matters: direct API replay confirms Alpha conventions return 403 under Alpha's restriction, while unrelated unrestricted Beta conventions return 200 and remain editable.

Settings mounts the panel from the project inventory, which already carries its policy flag; owner boot also resolves provider inventory before mounting App. The browser regression delays that boot response and verifies no premature conventions request. FilePolicyPanel refreshes project inventory after applying or removing policy, so pause/recovery works without a reload. The panel remains mounted, retaining the local draft, revision note and original CAS revision. It invalidates pending operation callbacks and clears restore/publication previews when policy changes. A retained draft is not replaced by an automatic recovery fetch. Late-response suppression was source-reviewed; this regression does not inject a delayed mutation callback.

A selected-project notice is essential: the generic global pause notice links to the first restricted project. With Alpha and Beta both restricted, following that link while Beta has a dirty draft could switch projects and unmount it. The new replay checks that Review stays on Beta and that clearing Beta restores its draft while Alpha remains restricted.

Validation:

- New real-server Chrome regression: 1/1 passed, 9.9 seconds. It covers restricted initial load with zero conventions GETs, unrestricted other-project access, remove/reapply/remove policy through the UI, exact draft/note preservation, stale-save 409 and explicit compare/rebase/save, and two-restriction selected-project link/recovery.
- Original conventions CAS/restore/publication scenario and original filesystem gate case 2: 2/2 passed. This replay preceded the final selected-project notice refinement; the new regression exercises that final refinement.
- Original conventions and filesystem gate unit tests: 10/10 passed. Final TypeScript check passed. Diff whitespace check passed.
- Screenshots inspected; no page exceptions. Server log contains the known Node SQLite warning and normal shutdown only.

Evidence: `/private/tmp/codeflow-qa-continue/final-conventions-policy-final.log`, `final-conventions-policy-final/` (screenshots, browser request/response/console receipt, server log), `final-conventions-original.log`, `final-conventions-unit.log`, and `final-conventions-tsc-final.log`.

The browser receipt is not globally console-clean: it records the deliberate stale conventions PUT 409, a policy-activation stream 409, an existing restricted team-rollout 403, and adjacent `/api/repo-config`/`api/check` 403s from RepositoryRunDefaults. The defaults issue was confirmed and delegated to a separate repair; the new regression strictly asserts conventions requests and preserves those other observations for the combined replay. No backend authority or unrelated test assertion was relaxed. Setup used scratch homes/repos/accounts, reserved ephemeral ports, fake CLIs only, and stopped its owned browser/server.

## Integrated fixture synchronization

The first integrated new-case replay correctly returned the policy gate's temporary `409: Wait for active application operations to finish before changing filesystem policy` when the test changed Alpha's policy immediately after selecting Beta. The conventions editor can finish loading before Beta's repository defaults/check requests finish. This is a legitimate gate, not a production conventions failure. Receipt: `/private/tmp/codeflow-qa-continue/integrate-conventions-policy.log`.

The fixture now tracks its finite browser API requests (excluding persistent streams), waits for those reads before this external policy change, and allows only that exact status/message to be retried for at most ten seconds with the unchanged original revision and body. Other errors, revision conflicts, all permission assertions and every conventions assertion remain strict. Any such activity conflicts are recorded in the browser receipt. No production source changed.

The synchronized complete regression passed 1/1 in 9.0 seconds; finite-request synchronization sufficed without a policy retry (`activityConflicts: []`). TypeScript passed. Evidence: `/private/tmp/codeflow-qa-continue/final-conventions-policy-synchronized.log`, `final-conventions-policy-synchronized/`, and `final-conventions-sync-tsc.log`. The owned browser/server stopped normally. Related defaults and transition responses remain recorded as described above.
