# Final policy fixture synchronization follow-up

Base: `cd93ad1`. Scope: the final collaboration replay and the original filesystem-policy browser replay. No production admission or permission code changed.

The frozen full run reported `qa-final-partials-collab.e2e.ts` failing at its policy-cleanup PUT (line 100), and `qa-fs-policy-gate.e2e.ts` waiting for a successful close-terminal-and-apply result. An isolated original collaboration replay passed 6/6, so the first result alone did not establish a cause. A scratch server-only observer showed that `FilesystemAccess.operations` can still contain `GET /api/doctor` when policy setup or cleanup begins. That request genuinely holds the policy admission gate. The original policy-panel replay reproduced 3/4: its final case received the generic active-operation 409 while it was waiting for the terminal-specific refusal. The application retained the draft and its action error.

The collaboration fixture now parks its other account pages before global policy setup and cleanup. It waits for an unchanged-policy PUT to succeed, asserting that the entire saved snapshot remains equal. Only the exact in-flight-application-operation refusal is accepted while waiting; other conflicts and errors still fail. The subsequent restriction, host-dispatch 403, absent job, and unchanged run-count assertions remain intact.

The last policy-panel scenario tracks finite browser API requests and lets their responses finish before its navigations and policy actions. Event streams are excluded after their headers arrive. The existing terminal refusal, explicit terminal closure, successful restriction, successful removal, and no-terminal-reopen assertions remain intact. Earlier cases retain their existing explicit refusal/retry and stale-revision checks.

Evidence is in `/private/tmp/codeflow-qa-continue/final-collab-followup/`:

- `baseline.log`: unmodified collaboration 6/6.
- `fs-policy-baseline.log`, `fs-policy-observer.jsonl`: original policy file 3/4, with the final refusal traced to actual provider discovery.
- `fixed.log`, `fixed-policy-observer.jsonl`, `fixed/`: corrected collaboration 6/6; all four admission/change calls entered with no active requests. Browser page errors and unexpected HTTP errors are empty.
- `combined.log`, `combined/`: both complete files together at concurrency 2, **9/10**. All six collaboration cases and the repaired close-terminal case pass. One separate conventions-policy issue remains below.
- `units.log`: 11/11 targeted filesystem-policy, engine-policy and gate checks.
- `tsc-final.log`: typecheck passed.

The exploratory `observed.log` is not counted as a valid full replay: its first observer was inherited by fake-agent subprocesses and broke one handoff with a module-resolution error. `observed-source.ts` and that log remain for audit. The observer was narrowed to server processes for subsequent diagnosis; final combined validation runs without any observer. The discarded broad request-tracker experiment is retained in `fs-policy-fixed.log` and is not counted as a pass.

## Separate finding retained for integration

The corrected original policy file still exposes a real conventions UI problem: following the paused GitHub picker's “Review the filesystem policy” link mounts `ConventionsPanel` unconditionally in Settings → Projects. It requests `/api/projects/:id/conventions` under the saved restriction and gets 403. This violates the existing no-refused-private-requests assertion in case 2. It reproduced in `fs-policy-final.log` and `combined.log`; it is not excluded or reclassified as expected. The parent was notified to coordinate the narrow production repair with the memory/conventions owner. This report does not claim the complete policy file is green at this base.
