# Repository defaults under filesystem restrictions

Base: `1f12b74`. The conventions follow-up exposed another Settings → Projects request leak: `RepositoryRunDefaults` always requested `/api/repo-config` and `/api/check`, including for a repository whose owning project restricts filesystem access. Both requests returned 403 and left avoidable loading/error guidance.

Actual isolated API controls establish the scope: with Alpha restricted, both Alpha reads return 403; both unrelated Beta reads return 200, including the detected `npm test` command. These read-only endpoints are repository-scoped, rather than globally paused. A repository shared by multiple projects is subject to any owning project's restriction. Server authorization is unchanged.

`ui/project-run-settings.tsx` now suppresses discovery while an owning project is restricted. It identifies the relevant policy and links to it, while keeping browser preferences editable and saveable. Remembered commands initialize immediately even when discovery cannot run. Pausing clears discovery errors and cancels their pending UI results; recovery retains user-edited commands and verification/container preferences. A late successful response cannot overwrite an edited command after a pause. Existing repository-keyed settings and project-switch behavior remain: saved values follow their repository; ordinary project/repository switches and leaving Settings do not gain unsaved-draft persistence. The policy-review link has the narrow one-use transfer described below.

The new browser regression uses private copied build output, reserved loopback ports, scratch homes/repos and fake providers. It covers:

- Alpha403/Beta200 API positive controls and no restricted repository GETs from Settings.
- An unrestricted project sharing Alpha's repository still pauses its reads; Review targets the actual restricted owner.
- Local preferences are editable/saveable under restriction, and remembered Alpha/Beta commands stay separate.
- Unsaved command and verification changes survive pause/removal without being implicitly saved.
- Both successful Beta discovery responses are held after the server finishes; restriction is applied, a command is edited, then the old responses are delivered. Recovery preserves the edit.
- Explicit saves, project switches and page reload restore each repository's independent values.

Validation evidence is under `/private/tmp/codeflow-qa-continue/final-repo-defaults/`:

- `baseline.log`, `baseline/browser.json`: the new scenario against a private copy of the old production file fails at the missing pause guidance; both forbidden repository GETs return403. `baseline-copy.cjs` changes only that private copied input, never the checkout.
- `complete.log`, `complete/`: final expanded new Chrome case **1/1 passes** (10.46s). Browser page errors and server500 responses are empty; every issued repo-config/check request is200. Screenshots were visually inspected for readable pause guidance and editable saved fields.
- `original-defaults.log`: the existing invalid-package/defaults-edit/save/reload case **1/1 passes**.
- `tsc-final.log`: TypeScript check passes; `git diff --check` passes.
- Separate API contract: `/private/tmp/codeflow-qa-continue/repo-defaults-contract.json` and its server log.

This source base predates the sibling conventions guard `950e81b`. Its full browser receipt therefore also records known `/conventions` and boot `/team-rollout`403 responses. Those are not reported as fixed by this change or removed from the receipt. The parent will replay the original complete filesystem-policy file after combining both production fixes and the separate fixture synchronization commit `0574e3f`.

## Independent-review follow-up

Review found that the newly introduced Review link could switch from an unrestricted project sharing a restricted repository to its restricted owner. Settings keys the editor by project, so that deliberate link discarded unsaved check/setup/profile fields despite keeping the same repository.

The link now captures an in-memory, one-use handoff for the exact destination project and repository. Destination Settings selects that repository and consumes its commands, preferences, edited state and saved indicator. No localStorage write occurs; ordinary project/repository navigation does not create or restore a handoff. Optional projectless mounting is explicitly guarded.

The expanded new regression edits check, setup and verification before clicking shared-owner Review, verifies all three after navigation, and verifies that the previous saved command is unchanged. It then explicitly saves before continuing the remaining pause/recovery/late-response/reload matrix. `review-final.log` and `review-final/` show **1/1 passing** in 10.56 seconds; `tsc-review.log` is clean. Console failures are now correlated to recorded exact endpoint/status responses instead of accepting every403/409 message. The source-base conventions limitation above remains explicit. `review-followup.log` retains the unsuccessful first iteration, before fixing an optional-project initialization guard; it is not counted as a pass.
