# Independent repository-defaults review

Reviewed `65b3cc1` and repair `cda10e1ac42dbd5e6c5167fc0b5df6744f0ab425` in `/private/tmp/codeflow-qa-final-repo-defaults` read-only. The one confirmed P2 is fixed and independently reverified. No remaining actionable finding within the reviewed delta.

## Resolved P2 — new policy link discarded unsaved defaults for a shared repository

An unrestricted project Beta and restricted Alpha both own the same repository. The panel correctly suppresses discovery and allows editing browser defaults. After typing unsaved check/setup commands and changing verification, following its new “Review the filesystem policy” link changes the selected project to Alpha. `ProjectSettings` keys `ProjectRunSettings` by project ID, so it remounts even though the repository is identical. The replacement initializes from saved preferences and silently loses the three edits.

Independently reproduced with actual Chrome rendering the production ProjectRunSettings and the exact project-keyed mounting/link consumption used by Settings. Before clicking: `unsaved check from Beta`, `unsaved setup from Beta`, verification `thorough`. After clicking: selected `alpha`, `remembered check`, `remembered setup`, empty verification. Browser storage remained unchanged and there were zero page exceptions. This is a new navigation affordance introduced by this delta, not a request for broad unsaved persistence across ordinary project switches. A narrowly guarded link or preservation across this handoff is sufficient; implicit saving would be inappropriate.

Evidence: `/private/tmp/codeflow-qa-continue/final-repo-defaults-review-probe.mjs`, `final-repo-defaults-review-probe.log`, and `final-repo-defaults-independent/shared-owner-receipt.json` plus screenshot. The independent probe controls the state/API boundary and is not an end-to-end server replay. The owner's initial regression tested this link only after saving, so it did not catch the dirty shared-owner handoff.

The owner repaired this in `cda10e1` with a one-use in-memory handoff scoped to the destination project and exact repository. Only the new policy Review link creates it. The destination initially selects that repository and consumes the commands, defaults, edited flag and saved-state indicator. It does not save to browser storage or broaden persistence for ordinary project switches. The owner expanded the real-app browser regression to cover the originally failing dirty handoff.

Independent actual Chrome verification against the committed repair passed four groups, with zero page exceptions:

- Dirty check, setup, verification, container enabled/image/auth-volume values survive the Review handoff to a multi-repository owner whose usual selected repository differs. The exact shared repository is selected; intercepted storage writes remain empty and no saved-success indicator appears.
- The handoff is consumed once. Subsequent ordinary project switches restore remembered defaults, not the consumed draft.
- Deliberately mounting a wrong project sharing the repository and then the correct project on a wrong repository cannot display or consume the pending draft. A later exact project/repository match receives it. These are controlled component boundary probes, not normal UI navigation claims.
- The transferred edited flag survives restriction/recovery. Old successful configuration and failed detector callbacks cannot overwrite fields or clear a newer loading operation; fresh responses finish recovery while retaining edits. Storage writes remain empty.

Final evidence: `final-repo-defaults-handoff-review.mjs`, `final-repo-defaults-handoff-review.log`, and `final-repo-defaults-handoff-independent/receipts.json` plus `retained-draft.png` under `/private/tmp/codeflow-qa-continue/`. The owner's checkout remains clean. Its expanded actual-app Chrome and typecheck receipts were reviewed, not represented as independently rerun here.

## Reviewed boundaries

The restriction check considers every owning project and uses a live signal read before applying asynchronous discovery results. Unrelated project restrictions do not suppress these repository-scoped GETs, matching FilesystemAccess's existing target policy gate. Restricted initial mounting loads remembered local values without issuing discovery requests. Same-component pause/recovery preserves the edited flag and local defaults; old promise callbacks are invalidated through the effect lifetime and live policy check. Repository-keyed remounts retain the preexisting explicit repository-switch semantics. The backend authority boundary is unchanged.

An additional independent Chrome probe passed the callback-order boundary: begin discovery, restrict, type a command, unrestrict to begin new discovery, then deliver the old configuration success and detector failure. The old outcomes neither replaced the command nor added an error nor cleared the new loading state. Fresh outcomes finished loading while retaining the edited command and remembered setup. Receipt: `final-repo-defaults-independent/late-read-receipt.json`.

The owner's new browser scenario was read and its qualified scope noted: actual isolated Alpha403/Beta200 controls, shared ownership, dirty edits surviving policy toggles, held successful discovery responses, explicit save/reload. It records other known policy-related 403s rather than claiming global console cleanliness. No source files were edited during this review. The independent app import/browser command used explicit outer scratch CODEFLOW_HOME and an owned headless Chrome process, which was closed afterward.
