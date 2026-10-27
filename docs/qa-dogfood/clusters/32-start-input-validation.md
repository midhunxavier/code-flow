# Cluster 32 · start-input-validation

**Start-input validation & numeric run limits: 500s, silent clamps, compare setups caps**

Status: **fixed and verified** · 15 issue entries · branch `codex/qa-start-input-validation`

Planner notes: Server side: buildStartInput in src/server.ts (874-967) calls validators that throw a plain Error outside attempt(), which gives 500s (t03-13; validateTaskTeam for out-of-range AI team limits, t10-1/S02-4). A missing repo folder reports 'spawn git ENOENT' (t16-9); check that the folder exists before repoRoot in src/git.ts. requestedRoles cuts the list to 6 before removing duplicates (t10-16). Compare setups: startComparison keeps only the first 6 variants while the dialog allows 9 (t24-1/S02-1, major). An Agent draft whose AI team was toggled off still sends taskTeam (S02-8). comparisonDraft is filled only by a mounted Composer, so 'Compare setups…' is disabled after a reload (t23-14/t24-16, ui/workflow-ui.ts). Client: the Minutes and Agent steps inputs use Number(v)||DEFAULT, so they can't be cleared and they show values the server then clamps (t02-13, t03-7/S03-1); workflow options behave the same way (t10-3); acceptance criteria are silently capped at 100 lines x 2000 characters (t02-15). Prefer one shared number-field helper that reports validity. composer-draft-config decides which limits are sent (explicit vs derived). Duplicate groups: [["t03-7","S03-1"],["t10-1","S02-4"],["t24-1","S02-1"],["t23-14","t24-16"]]

Likely files: `src/server.ts`, `ui/composer.tsx`, `ui/state.ts`, `ui/task-team.tsx`, `src/task-team.ts`, `src/git.ts`, `src/execution-budget.ts`, `ui/workflow-ui.ts`, `ui/insights.tsx`, `ui/onboarding.tsx`

## Resolution and verification · 2026-10-26

The causes in all 15 entries were confirmed against the source and repaired from `14dde57`, with the provider preflight prerequisite merged from `653d38c`. The original reports below remain the reproduction record.

| Issue | Resolution and evidence |
| --- | --- |
| t02-13, t03-7, S03-1 | Shared execution bounds now reject invalid API values instead of coercing, rounding or silently clamping them. `NumberField` retains unfinished raw text, shows an accessible inline error and blocks Start; only valid numbers update summaries and saved settings. Required fields stay empty after Backspace until the user types a valid value. Optional empty limits remain optional, but an unfinished exponent is invalid. Old invalid browser limit preferences fall back to visible application defaults. Chrome replayed Cmd+A/Backspace, typed 45, negatives, 0.5, 999/500 and an incomplete optional token value; the accepted run retained exactly 45 minutes and 12 steps. The context byte field also clears and retypes normally, blocks invalid ceilings, and recovers when disabled. Resetting a completed draft to configured defaults remains intentional. |
| t10-3 | Workflow numeric options use the same raw input and validation path, and the API rejects out-of-range, fractional and numeric-string values. Chrome entered 99 and -3 critique rounds, saw Start disabled while the summary kept its accepted value, then selected valid zero rounds. |
| t02-15 | Acceptance text is preserved exactly in draft state and browser persistence. Exceeding 100 lines or 2,000 characters per line produces a visible error and blocks Start. Chrome retained the 101st line and character 2001; correcting the criteria re-enabled Start. Unit coverage also preserves an empty 101st line. |
| t03-13 | All admission validators now use the existing typed request-error mapping, retaining known conflict and storage statuses. Invalid team config, permission requirements, Antigravity execution, context budget, trust and settings containers return actionable 400s without run records. Valid numeric settings retain their submitted values. |
| t16-9 | `repoRoot` checks that the requested directory exists before invoking Git; missing paths and file paths have explicit diagnostics. Build admission resolves the repository before deferred execution, so a removed unassigned repository is a rejected start rather than an unknown launch. Chrome/API replay queued two jobs, stopped the isolated server, moved both fixture directories, restarted and observed rejection without run IDs for both project-scoped and unassigned jobs. Non-Git directories and repository symlinks are covered separately. |
| t10-16 | Role lists are de-duplicated before the six-distinct-provider bound. Oversized distinct sets are rejected instead of truncated. The live API replay submitted six Claude entries followed by Codex; the resulting race retained both distinct contestants. |
| t10-1, S02-4 | AI team limits share the server's 3–6 members, 4–200 calls and 1–720 minutes rules, with visible field labels in errors. Invalid text disables Apply and cannot be saved as a preference. Invalid old limit preferences are discarded before a fresh team is created; enabled restored teams are also checked by Start. Chrome replayed 9 members, 1,000 calls, zero minutes and blank members, while API requests returned 400. The local conversation team's three-member minimum remains distinct from the dynamic Team workflow's design. |
| t24-1, S02-1 | Comparison accepts every requested setup up to the shared nine-run limit; repeat counts must be integers 1–3. The API replay retained all nine labeled runs, and Chrome submitted seven workflows and received exactly seven IDs. Engine admission is shared through `prepareStart` / `validateStart`; a later Loop setup with no check rejects the entire request before a run exists. Custom result prefixes get a unique comparison/run suffix, avoiding collisions between variants and repeats. A deliberate ref creation after preflight proves the late-failure path returns the started IDs, group and failed setup; the UI navigates to that group and shows an explicit partial-start warning. A scoped offline comparison request preserves the dialog/selections, starts nothing, and succeeds on retry. |
| S02-8 | The request builder omits disabled AI teams. Comparison also retains an enabled team only for a local Agent variant, so toggling On then Off no longer poisons every non-Agent setup. Both the ordinary Send request and the seven-workflow comparison were observed without a disabled `taskTeam` payload. |
| t23-14, t24-16 | `composerRunBody` reads restored global draft state, and `comparisonDraft` is computed independently of the Composer screen. Draft readiness and project-switch guards prevent stale bodies. Chrome reached Insights through full navigation and reload, retained the saved task, then switched projects and saw only the new draft in Experiments. Verification defaults are resolved on direct visits; unit tests also cover a changed or removed default and preserve explicitly restored profiles. |

Validation:

- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/start32-adjacent-home SHELL=/private/tmp/codeflow-qa-continue/start32-bash/bash BASH_ENV= ENV= node --import tsx --test --test-concurrency=1 test/qa-start-input-validation.test.ts test/qa-start-input-validation-draft.test.ts test/qa-composer-draft-config.test.ts test/git-reliability.test.ts test/context-budget.test.ts test/engine-review.test.ts test/loop.test.ts`: **60/60 passed** before the additional verification-default regression. Log: `/private/tmp/codeflow-qa-continue/start32-targeted-final.log`.
- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/start32-unit node --import tsx --test test/qa-start-input-validation.test.ts test/qa-start-input-validation-draft.test.ts`: **18/18 passed**, including the additional default-profile regression. Log: `/private/tmp/codeflow-qa-continue/start32-unit-final.log`.
- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/start32-e2e node --import tsx --test test/e2e/qa-start-input-validation.e2e.ts`: **11/11 passed** against a built isolated server in real headless Chrome. Log: `/private/tmp/codeflow-qa-continue/start32-e2e-final.log`.
- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/start32-check node_modules/.bin/tsc --noEmit` and `git diff --check`: **passed**.

Evidence: `/private/tmp/codeflow-qa-start-input-validation/output/playwright/qa-start-input-validation/`. Screenshots include `editable-limits.png`, `criteria-kept.png`, `context-invalid.png`, `team-invalid.png`, `workflow-options.png`, `seven-setups.png`, `partial-comparison-receipt.png` and `deferred-moved-repo.png`. `browser.json` records zero unexpected application errors and separates deliberate server-restart connection failures from the explicitly aborted `/api/compare` request. `server.log` contains expected startup/shutdown and Node's SQLite warning, without unexpected application errors. Earlier failed runs in scratch logs were test selector/response-shape/assertion problems and were corrected before the final replay.

All execution used explicit scratch `CODEFLOW_HOME` values, fake provider CLIs, a shell without startup dotfiles, disposable repositories/tokens and checked ports 4359/4360. The ref-race fixture alters only its own temporary Git repository. The server was stopped and scratch repositories removed; no live CodeFlow home/server, real provider credentials, user repositories or remotes were used. No issue from this cluster remains unresolved.

## Issues

### t02-13 · minor · Run limits above the server caps are shown unclamped in the composer, but the run is clamped

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-20.

**Repro**

> 1. Open Run options > Branches and limits.
> 2. Type Minutes 999 and Agent steps 500.
> 3. The summary shows 'Limit 500 calls · 999 minutes' and the details say 'stops after 999 min or 500 steps'.
> 4. Start and GET /api/runs/<id>.

**Expected:** The inputs clamp to 720/200, or the summary shows the effective limits.

**Actual:** Run 2610251438-000493f2 has loop.maxMinutes=720 and maxSteps=200.

**Root cause (verifier):** - **ui/composer.tsx:1185 and :1191:** the Minutes and Agent steps inputs rely only on the HTML min={1} max={720} and max={200} attributes. Their onInput stores any non-zero number through the local setLimits (ui/composer.tsx:1144): `setLimits({ maxMinutes: Number(e.currentTarget.value) || DEFAULT_EXECUTION_BUDGET.maxMinutes })`. 999, 500 and negative values reach limits.value unchanged.
- **Displays read the raw values:**
  - the Branches and limits summary (ui/composer.tsx:1150, "stops after {maxMinutes} min or {maxSteps} steps")
  - the composer summary (ui/composer.tsx:341, "Limit {maxSteps} calls · {maxMinutes} minutes")
  - the Run details row (ui/onboarding.tsx:305)
- **runBody sends the raw values:** ui/composer.tsx:225-226.
- **No validation blocks Start:** the problem() validator (ui/composer.tsx about 540-571) only checks auto-team maxSteps < 4, never the upper bounds.
- **The server clamps silently:** src/server.ts:838-841 (number(): Math.min(max, Math.max(min, n))) with bounds at src/server.ts:847-848 (maxMinutes 1–720, maxSteps 1–200). It sends no feedback, so the run gets 720/200 while the UI promised 999/500.
- **Separate problem in the same row:** Run details labels …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/execution-budget.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`

**Suggested fix:** 1. Put the bounds in one place. Export EXECUTION_LIMIT_BOUNDS = { maxMinutes: [1, 720], maxSteps: [1, 200] } and a clampExecutionLimit(key, n) helper from src/execution-budget.ts. Use them for:
   - the server parser (src/server.ts:847-848)
   - the composer inputs (min/max attributes)
   - the Settings NumberSetting max values (ui/settings.tsx:145-146)
2. Add an upper-bound check to problem() in ui/composer.tsx. Example messages: "Minutes must be between 1 and 720" and "Agent steps must be between 1 and 200". This disables Start and explains why, and it matches how Settings rejects out-of-range values.
3. Alternatively, clamp on blur or change in composer.tsx:1185/1191 and write the clamped value back into the field. Do not clamp on every keystroke, because that breaks typing.
4. Either way, the summaries at composer.tsx:341 and :1150, and the Run details row at onboarding.tsx:305, should only ever show values the server will accept.
5. Optional: have the server reject out-of-range li …

**Suggested regression test:** Add a case to test/e2e/settings.e2e.ts next to the existing "Branches and limits" assertions at lines 209-211:
- Fill #maxMinutes with 999 and #maxSteps with 500.
- Assert that one of these holds: .composer-problem contains "between 1 and 720" and .task-start is disabled, or (with the clamp-on-blur approach) the inputs read back "720"/"200".
- Assert that .composer-summary contains "200 calls · 720 minutes" and that the Branches and limits summary contains "720 min or 200 steps". Neither summary …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4617lim 4617 fake, with a new home and no runs. Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617lim/clamp.mjs in a fresh headless Chrome profile with no saved 'limits' in localStorage. The script opened #/project/p-ef01794b/new (MQTT-MCP) and clicked "Edit run options", then Advanced, then "Branches and limits". It selected the Minutes and Agent steps fields and typed 999 and 500 key by key.

What I saw:
- Both inputs report validity.valid=false with rangeOverflow=true ("Value must be less than or equal to 720/200"). Nothing on screen marks them invalid; screenshot shots/v4617lim/001-limits-typed.png shows plain fields.
- The Branches and limits summary changed to "stops after 999 min or 500 steps".
- The composer summary reads "Limit 500 calls · 999 minutes" (screenshot 002-summary.png).
- The Run details table shows "Limits 999 minutes · 500 steps", with the source given as "Application defaults".
- No composer problem message appears about the limits, and the Start button stays enabled.

I typed a task and clicked Start. The POST /api/runs body had loop {maxMinutes:999, maxSteps:500} and returned 201 with id 2610251910-d53fde2c. GET /api/runs/2610251910-d53fde2c then returned loop.maxMinutes=720 and maxSteps=200. The server clamped the values silently, and the run page shows no limits at all, so the user never sees the effective values. There were no console or 5xx errors.

This is not by design:
- The docs (docs/*.md) do not describe silent clamping as the intended UX.
- Settings > Run limits (ui/settings.tsx:125-131, NumberSetting) rejects out-of-range values: it checks validity.valid on blur, shows a toast and restores the previous value. The composer has no such guard.
- This is not caused by the tester's environment. A fresh profile, fresh home and typing that mimics a real user all reproduce it.

Cleanup: I deleted the run through the rail's "Delete…" menu, which then returned 404. Deleting keeps git worktrees by design, so I removed my own run's worktree, the branch codeflow/2610251910-d53fde2c/solo, and the leftover .worktrees/2610251910-d53fde2c/.context directory from MQTT-MCP by hand. I stopped server v4617lim, and ports 4617/4618 are free. Nothing is left over except the QA home and shots under the scratchpad.

</details>

### t03-7 · minor · Limit number fields can't be cleared and accept out-of-range values that the server silently clamps

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-30, CMP-34.

**Repro**

> 1. New run > Run options > Advanced > Branches and limits.
> 2. Click Minutes (240), select all, press Backspace: the field shows '240' again. Type 45: the field reads '24045' and the summary says 'stops after 24045 min'.
> 3. Enter -5 in Minutes: the composer summary says 'Limit 200 calls · -5 minutes'. Start: run 2610251407-6ed06d47 has loop.maxMinutes = 1.
> 4. Enter 999 in Agent steps: the summary says 'Limit 999 calls'. The server clamps to 200.
> Same snapping in Context inspector > Invocation context budget > Maximum explicit input bytes (clearing shows 65536 plus an error).

**Expected:** The field can be emptied while editing. Values are clamped or flagged on the client to the documented 1–720 / 1–200 range, and the summary shows what the run will actually use.

**Actual:** Clearing snaps to the default so typed digits append. Negative and too-large values are shown as accepted, then silently clamped by the server (a typed -5 becomes a 1-minute run).

**Root cause (verifier):** 1. ui/composer.tsx:1185 (maxMinutes) and :1191 (maxSteps): `onInput={(e) => setLimits({ maxMinutes: Number(e.currentTarget.value) || DEFAULT_EXECUTION_BUDGET.maxMinutes })}` on a controlled `value={String(limits.value.maxMinutes)}`. An empty or partial value (empty, or '-') becomes Number('') = 0, which is falsy, so the default 240/200 is used. setLimits (line 1144) always makes a new object, so Preact re-renders and writes '240' back into the DOM. The caret goes to the end and the next digits are appended ('24045'). The value is never clamped to min/max, so -5, 0.5, 1000 or 999 are stored as typed in the `limits` signal, which is persisted to localStorage via ui/state.ts:652. The summaries at ui/composer.tsx:1150 ("stops after X min or Y steps") and :341 ("Limit N calls · M minutes") show the raw signal. runBody (ui/composer.tsx:225-226) sends the raw values. startProblem (around line 559) only checks the auto-team minimum of 4 steps and ignores the range.
2. src/server.ts:838-841 validateLoop `number()` silently clamps with `Math.min(max, Math.max(min, n))`, so -5 becomes 1 and 999 becomes 200 (lines 847-849). This is inconsistent with src/engine.ts:699 followUpBudget, which reje …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/context-budget-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/insights.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`

**Suggested fix:** Composer limits (ui/composer.tsx):
- Keep a local string draft for each number field, e.g. a small `NumberField` component holding `useState(String(value))`. onInput only updates the draft.
- Commit to the `limits` signal only when the draft parses to an integer inside [min, max].
- Re-sync the draft from the signal only when the field is not focused (or on blur/reset), so clearing leaves the field empty while you type.
- Show an inline error ("Enter 1–720 minutes" / "Enter 1–200 steps") with aria-invalid, and add a range check to startProblem() so Start is disabled with that message instead of sending an out-of-range value.
- Have the summaries at lines 341 and 1150 read the committed (valid) values, or show the error, so they always match what the run will use.
- On load, clamp or validate the values restored from localStorage (ui/state.ts:652 store.json("limits")), so a stale -5 or 1000 from an older build cannot be sent.

Server (src/server.ts:838-849):
- Replace the silent clamp i …

**Suggested regression test:** 1. Browser e2e (extend test/e2e/settings.e2e.ts, which already drives #maxMinutes/#maxSteps, or add test/e2e/composer-limits.e2e.ts):
- Open Branches and limits, focus #maxMinutes, press Meta+A and Backspace. Assert inputValue() === ''.
- Type '45'. Assert inputValue() === '45' and that the summary contains 'stops after 45 min'.
- fill('-5'). Assert an error matching /1–720/ is visible, .task-start is disabled, and the summary does not contain '-5'.
- fill('999') in #maxSteps. Assert the same fo …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4647 on 127.0.0.1:4647 with a new persistent browser profile. Project MQTT-MCP, New run > Run options > Advanced > Branches and limits. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647/ (a1/a2/a3 .mjs and .log). I used real key events (keyboard.press/type), not just fill():
- Minutes 240, Cmd+A then Backspace: the field shows '240' again. Typing "45" gives '24045'. The summary says "stops after 24045 min" and "Limit 200 calls · 24045 minutes".
- Minutes 30, then Backspace twice: '3', then '240'. Deleting the last digit always snaps to the default (240), not the previous value.
- Typing "-5" over a selection gives '2405', because '-' alone is an empty value that snaps to 240. Pasting/fill "-5" gives '-5' and the summary says "-5 min". Typing 1000 minutes and 999 steps is shown as "Limit 999 calls · 1000 minutes". validity.valid is false for all of these, but nothing is styled or reported, and Start stays enabled (title "Start run (⌘↵)").
- Started a run with Minutes=-5 and steps=999 (run 2610251814-e3144893). GET /api/runs/:id returned loop {"maxSteps":200,"maxMinutes":1,"checkTimeoutMin":10}. The server silently turned -5 into a 1-minute run and 999 into 200, and the run page does not show the effective limits.
- Context inspector > Invocation context budget: enabled, Cmd+A then Backspace in "Maximum explicit input bytes" shows '65536' plus the error "Choose at least one context ceiling." Typing 4096 then gives '65536409' and the error "Context ceilings must be positive bounded integers." 65,536,409 bytes stays as the active budget ("Active budget: 65,536,409 bytes"), which is worse than reported.
No console or 5xx errors. Not caused by the environment: this happens with a fresh home, a fresh profile and real keystrokes. Not by design: the inputs declare min=1 max=720 / max=200, docs/task-reruns.md and the follow-up budget path (src/engine.ts:699) document and enforce 1–720 minutes / 1–200 calls by rejecting, and no doc describes silent clamping. Cleanup: deleted the run through the UI (Select runs > Delete). The dialog keeps branches and worktrees by design, so I removed my own run's worktree (.worktrees/2610251814-e3144893/solo) and branch (codeflow/2610251814-e3144893/solo) in MQTT-MCP with git. Server v4647 is stopped. No leftovers apart from the browser profile in qa/profiles/v4647 (its limits localStorage may still hold 10 …

</details>

### S03-1 · minor · Minutes/Agent steps inputs use `Number(value) || DEFAULT`: clearing snaps to 240/200, 0 can't be typed, values above max aren't clamped client-side (summary shows 1000 min while server clamps to 720); local setLimits doesn't persist so resetComposer reloads stored limits after each start.

Source: code-level suspect at `ui/composer.tsx:1185` (confirmed hands-on).

**Repro**

> Fake server s03 (4513), scratch repo project. Composer > Edit run options > Advanced > Branches and limits (script work/s03/limits.mjs). Minutes field 240, put caret at end, Backspace x3: field goes '24' -> '2' -> '240' (empty snaps back to 240). Typing '60' then gives '24060' and the summary reads 'stops after 24060 min'. Select-all + '0' gives 240. Select-all + '1000' / steps '500': the field shows 1000 (validity.rangeOverflow=true but no invalid styling or error), the Branches summary reads 'stops after 1000 min or 500 steps' and the composer summary reads 'Limit 500 calls · 1000 minutes'. Start is not blocked. Clicking Send (limits-start.mjs) POSTed loop {maxMinutes:1000,maxSteps:500}. GET /api/runs/<id> returned loop {maxMinutes:720,maxSteps:200} with no warning. After the start, the composer showed 'Limit 200 calls · 240 minutes' again (shots/s03/003-limits-1000.png).

**Expected:** The field can be cleared and retyped normally. Out-of-range values (<1, >720 min, >200 steps) are rejected or clamped visibly before start, so the summary matches what the run gets.

**Actual:** Clearing re-inserts 240/200 on every keystroke, so ordinary editing yields values like 24060. Out-of-range values show in the summary and are silently clamped by the server (src/server.ts:838-847).

**Root cause (verifier):** onInput maps every keystroke straight into the limits signal with `Number(v) || DEFAULT_EXECUTION_BUDGET.x`. An empty or 0 value becomes the default and is written back into the controlled input. There is no client-side range check; the server's loopSettings number() clamps silently. The third part, reset to stored limits after start, is by design: resetComposer is commented 'Fresh composer for the next run', and Settings > Run defaults is the documented persistent store (configuration.md: 'Numeric run limits save when you leave the field').

**Suggested fix:** Reuse the Settings NumberSetting pattern (ui/settings.tsx:125): keep a string draft per input, commit on blur or Start only when validity.valid. Otherwise restore the previous value or show an inline error, and disable Start while a limit is invalid. Clamp to [1,720]/[1,200] before building runBody. Optionally have the server return a note when it clamps.

**Suggested regression test:** e2e: in Branches and limits, press Backspace until the Minutes field is empty and assert it stays empty (not 240). Type 60 and assert the summary says 60 min. Type 1000 and assert an error shows or the value clamps to 720, and that the POST /api/runs body has loop.maxMinutes <= 720.

### t10-3 · minor · Out-of-range workflow options are shown as entered while the server silently clamps them

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-05, TEAM-08.

**Repro**

> 1. Advanced -> Plan → Build → Review -> Branches and limits -> 'Max review rounds' (opt-maxRounds) = 99.
> 2. Read the team sentence and start the run.

**Expected:** The input rejects or clamps to its max (5), and the sentence matches what will run.

**Actual:** The sentence reads 'up to 99 rounds of fixes'; the run is stored with options.maxRounds = 5. There is no feedback.

**Root cause (verifier):** The UI keeps and displays the raw number; only the server clamps it, and it does so silently.

- ui/composer.tsx:1173: the numeric option input passes `min={o.min} max={o.max}`, but `onInput` stores `Number(e.currentTarget.value)` through setOption with no clamping. min/max only feed the browser's constraint validation. Nothing styles :invalid, there is no form submit, and the field never shows the browser message.
- ui/state.ts:794-796: `setOption` writes the raw value into the optionValues signal.
- ui/state.ts:789-793: `optionsFor` returns that raw value, falling back to the default only when it is undefined.
- optionValues is also saved with the composer preferences (ui/state.ts:1201), so 99 carries over to the next run.
- ui/composer.tsx:1029/1036: `teamSentence` uses `optionsFor(p)` and renders "up to ${opts.maxRounds} rounds of fixes". Other sentences have the same problem: loop at :1052 "(max N rounds)" (max 30) and auto-team at :1034 "up to N members" (2-6).
- ui/composer.tsx:206: the start request sends `options: optionsFor(p)` unchanged.
- src/server.ts:857-871: `validateOptions` rounds the value and clamps it to the pattern's min/max (src/patterns/pipeline.ts:29-30 sets …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`

**Suggested fix:** 1. Clamp in one place in the UI, using the same rule as validateOptions: round the value and limit it to [min, max], and use the default for non-finite values. Apply it in `optionsFor` in ui/state.ts so that the team sentence, the start payload (composer.tsx:206), the presets (composer.tsx:475) and the saved preferences all see the effective value. Ideally move the helper into a shared module and have server validateOptions import it, so the two rules cannot drift apart.
2. In the Settings input at composer.tsx:1173:
   - Keep the raw text while the user is typing.
   - On change/blur, write back the clamped value so the field shows 5.
   - While the raw value is out of range, set `aria-invalid` and show inline help such as "1–5 (will use 5)".
   - Add `.field[aria-invalid=true]` or `:invalid` styling.
3. Optional: have the server return a `warnings` or `adjustedOptions` field when it clamps, so API and automation callers learn about the change too.

**Suggested regression test:** Unit test, for example a new test/composer-options.test.ts or an addition to test/composer-tools.test.ts:
- Build a PatternInfo for pipeline with options maxRounds 1-5 and checkFixes 0-5.
- Call setOption(p, "maxRounds", 99) and setOption(p, "checkFixes", -3).
- Assert optionsFor(p) deep-equals {maxRounds: 5, checkFixes: 0}.
- Assert teamSentence(p, roles) contains "up to 5 rounds" and not "99".
- Add one case for loop maxRounds = 99 → 30.

Browser e2e in the composer suite:
- Fill #opt-maxRound …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server: `qa-server.sh start v4639 4639 fake`. The home had 0 runs. I used a fresh headless Chrome with no profile and drove it with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t103.mjs.

Steps in the UI:
1. New run, then project MQTT-MCP.
2. Run options, then Advanced, then workflow "pipeline" (Plan → Build → Review).
3. Opened "Branches and limits".

Before any change the sentence read "Claude Code plans → Codex builds → Codex reviews (up to 2 rounds of fixes)". The #opt-maxRounds input has min=1 max=5.

4. Filled #opt-maxRounds with 99 and #opt-checkFixes with -3, then blurred.
   - The inputs still showed 99 and -3. The browser flagged them as out of range (validity.rangeOverflow true, "Value must be less than or equal to 5."), but nothing on screen showed it: border and background stayed normal and there was no message (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/001-pipeline-99.png).
   - The team sentence changed to "... Codex reviews (up to 99 rounds of fixes)".
5. Set the check to `true`, unticked plan approval, typed a task and clicked Start.
   - The start went through: no error, no toast about the values.
   - Run 2610252028-c77a5538: GET /api/runs/<id> returned options {"maxRounds":5,"checkFixes":0}, and runs/2610252028-c77a5538.jsonl holds the same values.
   - The UI never said that 99 became 5 or that -3 became 0. The behaviour matches the report exactly.

Attempts to refute it:
- Not a selector or profile artifact: I used a fresh browser, and the reporter's #opt-maxRounds selector is the real input id.
- Not by design: no doc describes UI behaviour for out-of-range workflow options. The only clamping note, docs/configuration.md:124, is about terminal config.
- Not environmental: the cause is plain UI code.

Cleanup:
- Deleted the run through the UI (Select runs → Delete). The delete dialog says branches and worktrees are kept.
- So I removed only my run's worktree MQTT-MCP/.worktrees/2610252028-c77a5538/build and branch codeflow/2610252028-c77a5538/build with git.
- Stopped v4639.
- Another tester's worktree 2610252028-a1424ec3 is still in MQTT-MCP. I left it alone.

</details>

### t02-15 · minor · Acceptance criteria are silently capped at 100 lines × 2000 characters

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-21.

**Repro**

> 1. Run options > Acceptance criteria.
> 2. Paste 105 lines whose first line is 2500 characters long.

**Expected:** A visible notice that criteria were truncated.

**Actual:** 105 lines become 100 and the first line becomes 2000 characters, without any message. The summary just says '100'.

**Root cause (verifier):** ui/state.ts:632-635: `setAcceptanceCriteria` runs `acceptanceCriteria.value = criteria.slice(0, 100).map((c) => c.slice(0, 2000))` and persists the result, with no flag or message saying that anything was cut. ui/state.ts:631 applies the same 100-entry cap when the draft is loaded from localStorage.

ui/onboarding.tsx:29: the textarea is controlled. Its value is `acceptanceCriteria.value.join("\n")` and its onInput passes `e.currentTarget.value.split("\n")` straight to that setter. The re-render then replaces what the user pasted or typed with the shortened value. That is also why an Enter on line 100 vanishes and the following keystrokes join the last criterion.

ui/onboarding.tsx:27: the summary counts only the kept non-empty entries ("100"), so nothing on screen shows that text was lost.

The limits themselves are deliberate. They match ui/composer-tools.ts:116, which rejects templates with more than 100 criteria or any criterion over 2000 characters. Only the missing feedback, and the fact that edits at the limit corrupt text, are defects.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Keep the 100 × 2000 limits, but stop trimming silently.

1. In ui/state.ts, have setAcceptanceCriteria report what it removed, for example by returning `{ droppedLines, truncatedLines }`, or expose a computed `acceptanceOverflow` signal.
2. Better: keep the raw textarea text in its own signal and do not clamp it while the user types. Validate it instead, and clamp only when building the run task or saving a template. Then a paste is never altered under the user's caret, and Enter on line 100 no longer merges text into the previous criterion.
3. In AcceptanceEditor (ui/onboarding.tsx:25-32), show an inline `<p class="msg warn" role="status">` such as "Only the first 100 criteria are used; 5 lines were removed" or "Criteria are limited to 2,000 characters; 1 line was shortened". State the limits in the help text ("Up to 100 lines, 2,000 characters each").
4. Optionally show the summary as "100 of 105" when there is overflow.
5. If raw input is kept over the limit, either block Start run  …

**Suggested regression test:** Add a case to test/e2e/ui.e2e.ts next to the existing acceptance-criteria flow (around line 1031). It opens Run options > Acceptance criteria and pastes 105 lines whose first line is 2500 characters, using `locator.fill`. It then asserts:
- the acceptance editor shows a role="status" (or .msg.warn) notice that mentions 100 criteria and 2,000 characters;
- the run task created from the composer contains exactly 100 numbered criteria, with criterion 1 at 2000 characters.

Add a second assertion fo …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (qa-server.sh start v4621 4621 fake, new home, no runs) and opened it in a fresh headless Chrome profile (no saved cookies or drafts) at http://127.0.0.1:4621. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/t02-15.mjs. It clicks "Edit run options", expands "Acceptance criteria", focuses #acceptance-criteria and pastes 105 lines with keyboard.insertText, which fires one input event like a real paste. The first line is 2500 'A' characters, then "Criterion 2" to "Criterion 105".

What I saw (log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/t02-15.log):
- 100 lines were kept. The first line is 2000 characters and the last line is "Criterion 100".
- The summary reads "Acceptance criteria 100 · explicit requirements for the team".
- localStorage draftAcceptance also holds 100 entries.
- The editor has no alert, status, .msg or .warn element. The only help text is the usual "These requirements are included in the run's task…".
- Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4621/002-after-paste.png shows the textarea ending at "Criterion 100" with no notice.

Two related behaviours I also found, which the reporter did not mention:
1. With 100 lines already present, I put the caret at the end and pressed Enter, then typed "Line 101". The newline is dropped right away, so the text joins the previous criterion: the last line becomes "Criterion 100Line 101" and there are still 100 lines. The user's 100th criterion is silently changed.
2. Typing "XYZ" at the end of the 2000-character first line does nothing; the keystrokes are swallowed.

I could not refute it:
- The behaviour does not depend on the browser profile or the reporter's script; it comes straight from the store setter.
- No docs/*.md file or code comment mentions the 100-line or 2000-character limits for composer criteria.
- The limits are intentional (they match the template validator), but the silent handling is not explained anywhere.

The console errors were unrelated 403s ("Connected projects unavailable"). I did not create any runs. Server v4621 is stopped. Leftovers: only the scratch script, log and screenshots.

</details>

### t03-13 · minor · POST /api/runs returns 500 for some invalid inputs, and a missing repo path reports 'spawn git ENOENT'

Source: tester unit composer-run-options-2; observed with api; features CMP-39.

**Repro**

> curl -X POST http://127.0.0.1:<port>/api/runs with Bearer token and origin header, valid repo/project/task/pattern solo plus:
> (a) "taskTeam":"yes" -> 500 {"error":"Choose whether Team is enabled"}
> (b) "permissionRequirements":["nope"] -> 500 {"error":"Unknown required permission enforcement"}
> (c) "repo":"/tmp" (not git) with explicit project -> 500 'git rev-parse … not a git repository'
> (d) "repo":"/tmp/does-not-exist" -> 500 (with project) / 400 (without) 'git rev-parse --show-toplevel failed: spawn git ENOENT'

**Expected:** 400 with a clear message, e.g. 'Repository not found', for all invalid client input.

**Actual:** 500 Internal Server Error for (a)-(c), logged as 'POST /api/runs failed'. (d) says git can't be spawned when the folder is missing. Invalid agentSettings/roleSettings/trust are silently sanitized and the run starts (201).

**Root cause (verifier):** buildStartInput (src/server.ts:874-967) calls several validators that throw plain Error outside attempt(). The request listener (src/server.ts:2799-2801) turns any non-HttpError into 500 and logs "POST /api/runs failed":
- src/server.ts:901: `projects.get(body.project)?.repos.includes(await repoRoot(repo))` is not wrapped. repoRoot (src/git.ts:278) uses gitOk (src/git.ts:181-184), which throws a plain Error, so a non-git or missing repo gives 500 whenever projectSelection is "explicit". src/server.ts:906 (journeyId) has the same pattern.
- src/server.ts:910 validateLoop -> src/server.ts:852 validateContextBudget (src/context-budget.ts:5-11) throws plain Error.
- src/server.ts:912 permissionRequirements (src/run-permissions.ts:44) throws plain Error.
- src/server.ts:913 antigravityExecution (src/run-permissions.ts:16-17) throws plain Error.
- src/server.ts:914 narrowerTrust (src/run-permissions.ts:39) can throw plain Error on the parent-run path.
- src/server.ts:934 validateTaskTeam (src/task-team.ts:83-86) throws plain Error.
Without an explicit project, the same bad repo reaches manager.start inside attempt() (src/server.ts:975), so it returns 400, but still with the raw git text. …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/context-budget.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** 1) In buildStartInput, resolve the repo once, right after the absolute-path check (src/server.ts:897), with `const root = await validRepo(repo)`. validRepo already returns 400 "Not a git repository". Before calling git, give it an existence check: if the folder is missing, throw `new HttpError(400, "Repository folder not found: <path>")`. Reuse `root` at lines 901, 906 and 916 instead of calling repoRoot(repo) again.
2) Turn validator failures into 400 in buildStartInput. The simplest option is a small sync wrapper: `const valid = <T>(fn: () => T) => { try { return fn(); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message); } }`. Wrap permissionRequirements, antigravityExecution, narrowerTrust, validateLoop (it covers contextBudget) and validateTaskTeam with it. Alternatively, have these validators throw a typed validation error that attempt() and the listener map to 400.
3) In src/git.ts git(), on a child 'error' with code ENOENT, check whether the …

**Suggested regression test:** Add a test in test/server-reliability.test.ts, next to the existing Improve `refused` helper at about lines 526-534, using the same startServer/api fixture. Add a `refusedRun(body, message)` helper that POSTs /api/runs with a valid solo body (repo, project, projectSelection:"explicit", roles {agent:["claude"]}) plus one bad field, and asserts status 400 and the message. Cases:
- taskTeam:"yes" -> /Team is enabled/
- taskTeam with preset:"nope" -> /team template/
- permissionRequirements:["nope"] …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server v4659 on port 4659. Sent POST http://127.0.0.1:4659/api/runs with curl, using "Authorization: Bearer qa-v4659-token" and "Origin: http://127.0.0.1:4659". The base body was the composer's own shape: repo MQTT-MCP, project p-ef01794b, projectSelection "explicit", pattern solo, roles {agent:[claude]}. Each case changed one field. Results:
(a) taskTeam:"yes" -> HTTP 500 {"error":"Choose whether Team is enabled"}
(b) permissionRequirements:["nope"] -> HTTP 500 "Unknown required permission enforcement"
(c) repo:"/tmp" with an explicit project -> HTTP 500 "git rev-parse --show-toplevel failed: fatal: not a git repository..."; the same repo without project/projectSelection -> 400 with the same raw git text
(d) repo:"/tmp/does-not-exist" with an explicit project -> HTTP 500 "git rev-parse --show-toplevel failed: spawn git ENOENT"; without a project -> 400 with the same ENOENT text
Three extra cases also return 500:
- antigravityExecution:"bogus" -> 500 "Invalid Antigravity execution mode"
- loop.contextBudget:"x" -> 500 "Context budget must be an object."
- taskTeam with preset "nope" -> 500 "Choose a team template"
Control: projectSelection:"bogus" -> 400, as expected.
server.out lines 8-14 log each 500 as "code-flow: POST /api/runs failed: ...".
Sanitization sub-claim: trust:"bogus" with agentSettings:"garbage" and roleSettings:"garbage" -> 201. The run finished with trust "standard" and agentSettings {}, so invalid values are silently replaced.
Not by design: docs/api.md:18-20 says "validation errors use 400". The composer always sends projectSelection:"explicit" (ui/composer.tsx:198), so this 500 path is the one the UI uses, for example when a project's repo folder has been moved or deleted.
Cleanup: deleting the one probe run (2610251819-1f7427bf) through DELETE /api/runs/:id kept its worktree and branch. That is by design: the dialog says "Git branches, worktrees and repository files are kept". I removed only that run's worktree, branch codeflow/2610251819-1f7427bf/solo and .worktrees/2610251819-1f7427bf folder in MQTT-MCP; nothing else was touched. Server v4659 is stopped. No leftovers.

</details>

### t16-9 · minor · A missing repository folder is reported as 'spawn git ENOENT'

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-28.

**Repro**

> 1. Queue a deferred run for repository R, stop the server, move R's folder away and start the server. Alternatively, POST /api/deferred-runs or /api/runs with a non-existent absolute repo path.

**Expected:** 'The repository folder <path> no longer exists. Restore it or choose another repository.'

**Actual:** The deferred card reads 'Start rejected · git rev-parse --show-toplevel failed: spawn git ENOENT'. The two POST endpoints return the same message, which suggests git is not installed.

**Root cause (verifier):** - src/git.ts:278-280: repoRoot(path) calls gitOk(["rev-parse","--show-toplevel"], path, {discover:true}) without checking that `path` exists.
- src/git.ts:97 (git()): runs spawn("git", …, {cwd: folderOf(cwd)}). When cwd doesn't exist, Node fails the spawn with ENOENT and blames the executable ("spawn git ENOENT").
- src/git.ts:147-150: the child 'error' handler pushes e.message into stderr unchanged.
- src/git.ts:175-178: gitError() wraps it as "git rev-parse --show-toplevel failed: spawn git ENOENT".
Where callers pass this through unchanged:
- POST /api/runs: buildStartInput, src/server.ts:901/906 (repoRoot for explicit projects). Without a project the error comes from engine.start, src/engine.ts:5077.
- POST /api/deferred-runs: src/server.ts:1994, via attempt().
- Deferred launch: src/deferred-launch.ts:58-64 calls build(). With a project, buildStartInput's repoRoot throws, which is wrapped in DeferredRunRejectedError -> "Start rejected" with the raw text.
- Without a project, the first repoRoot call is inside host.start (engine.ts:5077). The catch-all at deferred-launch.ts:65 then marks the job "unknown", although no side effect has happened.
Other repoRoot callers that let the …

**Files:** `src/git.ts`, `src/server.ts`, `src/engine.ts`, `test/git-reliability.test.ts`, `test/deferred-launch.test.ts`

**Suggested fix:** 1. In src/git.ts, make missing folders a typed, actionable error at the source:
   - Add `export class MissingRepositoryError extends Error`.
   - In repoRoot(path), before spawning, check the path with `lstat`/`existsSync`. If the path (or the folder holding it) is missing, throw new MissingRepositoryError(`The repository folder ${path} no longer exists. Restore it or choose another repository.`). If it exists but isn't a directory, give a similar clear message.
   - Also harden git(): in the child 'error' handler, when e.code === "ENOENT", check whether folderOf(cwd) exists. If it doesn't, report "Folder <path> no longer exists". If it does, report "git isn't installed or not on PATH". This way no caller ever shows "spawn git ENOENT" again; src/checks.ts:204 does something similar for docker.
2. In src/server.ts buildStartInput, after the absolute-path check, call `await attempt(() => repoRoot(repo))` unconditionally, not only for projectSelection === "explicit". A missing or non-git …

**Suggested regression test:** 1. test/git-reliability.test.ts: add `test("repoRoot of a folder that was moved away says so instead of 'spawn git ENOENT'")`. Make a repo in mkdtemp, rename it, then await assert.rejects(repoRoot(oldPath), (e) => e instanceof MissingRepositoryError && /no longer exists/.test(e.message) && !/ENOENT/.test(e.message)). Also assert that git(["status"], missingDir) returns code 1 with stderr matching /no longer exists/ and not /spawn git ENOENT/.
2. test/deferred-launch.test.ts: queue a job whose bu …

<details><summary>Verifier's independent reproduction</summary>

Ran on a fresh fake-mode QA server, v4611 on 127.0.0.1:4611, with 0 runs and an empty deferred queue. git 2.39.5 is installed at /usr/bin/git.
1. Node check: spawn("git", [...], {cwd:"/nonexistent/..."}) emits error "spawn git ENOENT" (code ENOENT, path "git"). A missing cwd is reported as if the git binary were missing.
2. POST /api/runs {repo:"/private/tmp/qa-v4611-does-not-exist/repo", pattern:"solo", roles:{agent:["claude"]}} -> 400 {"error":"git rev-parse --show-toplevel failed: spawn git ENOENT"}. For comparison, an existing non-git folder gives the accurate "fatal: not a git repository".
3. POST /api/deferred-runs with the same missing repo -> 400, same "spawn git ENOENT" message.
4. Deferred card, the reporter's exact case: created a scratch git repo and a project p-8be986b7 containing it. Queued a deferred run with notBefore=now+60s, project and projectSelection:"explicit" (what the composer always sends, ui/composer.tsx:198). Stopped the server, moved the folder away and restarted. After the start time passed, Scheduling -> Run once later showed the card "t16-9 project scoped · Start rejected · git rev-parse --show-toplevel failed: spawn git ENOENT · Retry after reviewing the failure" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611/002-start-rejected-card.png).
5. Extra finding: a deferred request queued without a project (API only) fails the same way after the folder is moved. It lands in "Launch outcome unknown" instead, with the duplicate-run recovery UI ("A run may have started before its receipt was saved…"), even though nothing started. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611/001-deferred-card.png.
Ruled out other explanations:
- Not by design: docs/deferred-runs.md describes only the rejected/unknown states, not this message. engine.ts:5359 (resume) already checks existsSync and says "Repository <path> no longer exists", so start is simply missing the same guard.
- Not environmental: git is on PATH, and every other git call in the same server works.
Cleanup:
- Cancelled the unknown job's queue recovery.
- Deleted the test project.
- No runs were created.
- Stopped server v4611 and removed the scratch repo.
Leftovers:
- Two deferred-queue history records (one failed, one cancelled) remain in the v4611 QA home.
- Unrelated pre-existing clone dir clone …

</details>

### t10-16 · minor · API role lists are truncated to 6 before de-duplication, dropping distinct agents

Source: tester unit ai-teams-patterns-1; observed with api; features TEAM-03.

**Repro**

> 1. POST /api/runs {pattern:'race', roles:{contestants:['claude','claude','claude','claude','claude','claude','codex'], judge:['codex','claude']}, ...}.

**Expected:** De-duplicate first (contestants claude+codex) or reject the request.

**Actual:** 201 created; stored roles.contestants = ['claude'] (codex silently dropped); the run then fails 'A race needs at least two contestants'.

**Root cause (verifier):** src/server.ts:619-628 `requestedRoles()` filters for valid ids, then caps multi roles with `list.slice(0, 6)` at line 625 while the list still holds duplicates. De-duplication only happens later in `validateRoles()` at src/server.ts:661 (`spec.multiple ? [...new Set(list)] : ...`), after `resolveAuto` (src/routing.ts:70 also de-dups). So duplicates use up the 6 slots and any distinct agents after them are dropped silently.
validateRoles (src/server.ts:662) only rejects an empty non-optional role. It never checks a pattern's minimum, so the reduced role is accepted with 201, and the failure only shows up asynchronously at src/patterns/race.ts:45 (and src/patterns/debate.ts:55 for debaters).
The same truncation can also drop agents with no error at all: judge = 6x'claude' + 'codex' quietly becomes a single claude judge, and contestants = 5x'claude' + 'codex' + 'agy' runs a 2-way race instead of 3-way. The project-defaults path at src/server.ts:2436 re-uses requestedRoles, so a remembered team can lose the same agents.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** In requestedRoles (src/server.ts:624-625), de-duplicate before capping: `const list = [...new Set(...filter(...))]; requested[spec.id] = spec.multiple ? list.slice(0, 6) : list.slice(0, 1);`. Keep "auto" as one entry, or count repeated "auto" separately if several autos are meant to resolve to different agents; check resolveAuto first.
Better still, turn the silent cap into a 400 when more than 6 distinct entries are supplied (for example "Pick at most 6 agents for \"Contestants\""), so callers are not quietly truncated. This also covers a UI user with 7+ registered providers, such as ACP connections.
Optionally move the per-pattern minimum into the role spec (for example `min: 2` on race contestants and debate debaters) and enforce it in validateRoles next to the existing "Pick an agent for" check. A too-small team would then get a synchronous 400 instead of a 201 followed by a failed run.

**Suggested regression test:** In test/server-reliability.test.ts (or another server test that already POSTs /api/runs on a fake-bin server), POST /api/runs with pattern "race", roles {contestants:['claude','claude','claude','claude','claude','claude','codex'], judge:['claude']}. Assert either a 201 where GET /api/runs/:id shows roles.contestants deep-equals ['claude','codex'] and the run does not fail with "A race needs at least two contestants", or (with the stricter fix) a 400. Add a second case with 7 distinct ids (or the …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4651t1016" on 127.0.0.1:4651 (new home, no runs). Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4651t1016/repro.mjs POSTs /api/runs to the MQTT-MCP repo with pattern "race", empty check/setup and judge ['codex','claude'].
(1) contestants = 6x 'claude' + 'codex' (7 entries) returned 201 {id:2610252031-5a46e7cf}. The first poll showed status=failed, roles.contestants=["claude"] and error "A race needs at least two contestants". codex was silently dropped (log: .../work/v4651t1016/seven.log).
(2) Control at the boundary: contestants = 5x 'claude' + 'codex' (6 entries) returned 201 {id:2610252031-7d75ca11} with roles.contestants=["claude","codex"], and the run finished "done" (six.log).
So the only difference is whether codex sits inside the first 6 raw entries, which shows that truncation happens before de-duplication.
Refutation checks:
- Nothing in docs/patterns.md or docs/api.md documents a 6-agent cap or says duplicates count toward it. patterns.md says the race needs "contestants (2+)".
- The tester's environment and script are not the cause: I reproduced it on a fresh home with my own script.
- The UI cannot send duplicates. The toggle at ui/composer.tsx:971 adds or removes an agent id, so this only affects API, automation, webhook and team-link callers.
Cleanup: both runs were archived with cleanup+deleteBranches and then deleted, which removed the worktrees and branches in MQTT-MCP. The server is stopped. Nothing is left over except the QA home directory.

</details>

### t10-1 · minor · AI team setup accepts out-of-range limits, saves them, then Send fails with HTTP 500

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-02.

**Repro**

> 1. New conversation, AI team On -> Advanced -> Limits and approval.
> 2. Set Maximum members 9, Maximum calls 1000, Maximum minutes 0. 'Apply team settings' stays enabled; click it.
> 3. Type a task and Send.

**Expected:** The dialog rejects or clamps values outside 3-6 / 4-200 / 1-720 before saving, and a server validation error is a 400 with a user-facing label.

**Actual:** The values are saved to localStorage taskTeamPreferences and apply to every new conversation. Send -> POST /api/runs 500 {'error':'maxMembers must be between 3 and 6'}, shown under Run options with the internal field name. Through the API, each field gives a 500 (maxCalls, maxMinutes too).

**Root cause (verifier):** The server and the client each have a gap.

Server:
- src/server.ts:934 in buildStartInput runs `taskTeam: body.taskTeam === undefined ? undefined : validateTaskTeam(body.taskTeam)` directly. It is not inside attempt() (server.ts:579-585) and not converted to an HttpError, unlike agentSettings a few lines below.
- validateTaskTeam (src/task-team.ts:81-98, limits loop at line 87) throws a plain Error.
- listener() (server.ts:2800) maps any non-HttpError to 500. So every invalid taskTeam on POST /api/runs is a 500. The same applies to the other buildStartInput callers: batch at :784, automations at :2214/:2245 and variants at :2857.
- For comparison, POST /api/runs/:id/task-team (server.ts:2526) wraps manager.configureTaskTeam in attempt() and returns 400.

Client:
- ui/task-team.tsx:96: the limit inputs have min/max attributes but onInput stores Number(value) with no clamping or validity check.
- The Apply button (task-team.tsx:101) is disabled only for busy, no providers, permissionProblem or availabilityProblem. It ignores limit validity.
- TaskTeamControl.save (task-team.tsx:36-43) calls onChange and then store.set("taskTeamPreferences", ...) without validating.
- defaultTaskTeam …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`

**Suggested fix:** 1) Server: at server.ts:934, wrap the call the same way agentSettings is handled: `try { validateTaskTeam(body.taskTeam) } catch (err) { throw new HttpError(400, (err as Error).message) }`. A better option is a TaskTeamValidationError class with status 400 that attempt() recognises. This also covers batch, automation and variant starts.

2) Server message: in validateTaskTeam, use friendly labels such as "Maximum members must be a whole number from 3 to 6" instead of the internal key, so the composer error makes sense to users.

3) Dialog:
- Keep a list of out-of-range fields, using the same [key, min, max] table as the server (export the bounds from src/task-team.ts so the UI and server share them).
- Disable "Apply team settings" and show an inline role=alert while any field is out of range. Alternatively clamp with Math.round and Math.max/Math.min on blur.
- Mark the inputs aria-invalid.

4) Saved preferences: in defaultTaskTeam, clamp or discard out-of-range saved limits when readi …

**Suggested regression test:** Server: add to test/server-reliability.test.ts (it already starts a server and posts /api/runs). POST /api/runs with taskTeam {...valid, maxMembers: 9}, then maxCalls 1000, maxMinutes 0, and the string "x". Assert status 400 for each and that body.error matches /Maximum members|3 and 6/. Also assert that enabled:false with out-of-range limits returns 400 (or 201 if the composer/server change makes disabled configs skip limit checks).

Validator unit test: in test/task-team.test.ts, assert that v …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4625, port 4625) from the dogfood-qa source.

1) API check (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/api.mjs): POST /api/runs to MQTT-MCP with pattern solo and a valid taskTeam, changing one field per request:
- maxMembers 9 -> 500 {"error":"maxMembers must be between 3 and 6"}
- maxCalls 1000 -> 500 {"error":"maxCalls must be between 4 and 200"}
- maxMinutes 0 -> 500 {"error":"maxMinutes must be between 1 and 720"}
- maxMembers 3.5 -> 500
- enabled:false with maxMembers 9 -> 500
- taskTeam "x" -> 500 "Choose whether Team is enabled"
server.out logs each one as "POST /api/runs failed: ...". docs/api.md:19-20 says validation errors use 400, so these should be 400.

2) UI check in a new headless Chrome profile with empty localStorage (ui3.mjs):
- Chose project MQTT-MCP, turned AI team On, opened Advanced, then Limits and approval.
- Entered 9 / 1000 / 0. The inputs report validity.rangeOverflow or rangeUnderflow, but "Apply team settings" stays enabled. I clicked it.
- localStorage.taskTeamPreferences then held {"enabled":true,...,"maxMembers":9,"maxCalls":1000,"maxMinutes":0}.
- Typed a task and clicked Send. POST /api/runs returned 500, and the composer showed the red text "maxMembers must be between 3 and 6" under Run options (not role=alert, and it uses the internal field name).
- Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625/002-bad-limits.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625/003-after-send.png

3) Persistence and wider impact (ui4.mjs, same profile):
- Clicked New run, turned AI team on and opened Advanced. The dialog was pre-filled with 9 / 1000 / 0 from the saved preferences.
- Turned AI team OFF and sent a plain one-agent task. It still failed: POST /api/runs 500 with the same maxMembers error. The composer sends the disabled taskTeam object and the server validates its limits anyway.
- Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625/002-team-off-send.png

Is it by design or caused by the environment? No.
- The dialog itself declares min/max for each field (task-team.tsx:96) that match the server ranges, and the template path already clamps  …

</details>

### S02-4 · minor · The AI team setup limit inputs use Number(value) with no client validation. In the composer, invalid maxMembers, maxCalls and maxMinutes are saved to taskTeamPreferences and reused by future drafts; the error appears only at Send from the server. The members range 3-6 differs from the Team pattern's 2-6.

Source: code-level suspect at `ui/task-team.tsx:96` (confirmed hands-on).

**Repro**

> Fake QA server s02. New run (Agent) > AI team On > Advanced > Limits and approval. Clear 'Maximum members' (value becomes 0), set calls to 999 and minutes to 0. The inputs report validity=false, but Apply team settings stays enabled and closes the dialog with no error. localStorage taskTeamPreferences = {…,maxMembers:0,maxCalls:999,maxMinutes:0}. Type a task and Send: POST /api/runs returns HTTP 500 {"error":"maxMembers must be between 3 and 6"}, shown as a red line under 'Run options' (shots/s02/002-s4-send-error.png). The server log shows 'POST /api/runs failed: maxMembers must be between 3 and 6'. In a different draft (#/new/unassigned), turning AI team on and opening Advanced shows 0/999/0 (work/s02/s4-teamlimits.mjs, s4b-persist.mjs).

**Expected:** The dialog refuses out-of-range or empty limits (Apply disabled, with a message naming the field), invalid values are never persisted as preferences, and a server-side validation failure is a 400 with a user-facing field name.

**Actual:** Invalid limits are accepted, persisted and carried into other drafts. Send then fails with HTTP 500 and the internal field name 'maxMembers', far from the AI team control. (The suspect said 400; it is actually 500.)

**Root cause (verifier):** TaskTeamDialog writes Number(event.currentTarget.value) straight into the draft. The dialog is not a <form> and never checks input.validity or calls validateTaskTeam, and TaskTeamControl.save (no run) only calls onChange and store.set('taskTeamPreferences'). defaultTaskTeam spreads the saved prefs without validation. On the server, buildStartInput calls validateTaskTeam, which throws a plain Error (server.ts:934), and that error is mapped to 500.

**Suggested fix:** In TaskTeamDialog, keep the raw string, compute an error with the existing pure validateTaskTeam from src/task-team.ts (or check min/max/integer per field), disable 'Apply team settings' and show 'Maximum members must be 3–6'. In defaultTaskTeam, discard or clamp invalid stored limits. On the server, wrap validateTaskTeam in attempt() or HttpError(400). The members range 3-6 versus the Team pattern's 2-6 looks deliberate (template prefs are clamped with Math.max(3, …)), so at most document it.

**Suggested regression test:** Browser test: enter 0/999/0, assert Apply is disabled with an error and taskTeamPreferences is unchanged. Unit test: defaultTaskTeam ignores a stored maxMembers of 0. API test: POST /api/runs with taskTeam.maxMembers=0 returns 400, not 500.

### t24-1 · major · Compare setups silently drops every setup after the 6th while the dialog offers and confirms up to 9

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features PLAT-18.

**Repro**

> 1. Start a fake-mode QA server and choose a project in New run; type a task. 2. In the app, go to Insights > Experiments > Compare setups... (in-app navigation keeps the draft). 3. Tick 7 setups (e.g. Team, Fix & review, Plan>Build>Review, Best-of-N, Debate, Supervisor, plus the preselected Agent). Footer shows 'Start 7 runs'. 4. Click Start 7 runs. 5. Inspect /api/runs or the Comparisons table for the new group.

**Expected:** 7 runs start (the dialog allows up to 9), or the dialog prevents choosing more than the server accepts and says so.

**Actual:** POST /api/compare returns 201 with only 6 run ids. The last-listed setup (Agent, which is the user's current pattern) is silently omitted and the comparison shows 6 rows with no warning. Groups gmvo2gzttfaaf (UI) and gmvo5xyg5ed74 (API, 7 solo variants -> 6 runs).

**Root cause (verifier):** src/server.ts:2846 — `const variants = Array.isArray(body.variants) ? body.variants.slice(0, 6) : [];` drops every variant after the 6th without telling the caller. The only limit the server reports as an error is the run total, at src/server.ts:2849 (`variants.length * repeat > 9` returns 400). Because the length is already cut to 6 before that check, 7 to 9 setups at repeat 1 pass validation and return 201 with fewer runs than requested.

On the client, ui/composer.tsx:468 (`const runs = picked.size * repeat`), :529 (the "— at most 9" hint) and :534 (`disabled={... runs > 9}`) only enforce the 9-run cap. Users can therefore pick 7 to 9 setups and confirm "Start N runs". The dialog sends the variants in pattern-list order, and 'Agent' (solo) comes last in that list. So the user's current/preselected pattern is the first one dropped once 6 or more others are ticked.

Secondary claim (from reading the code; I did not reproduce it): the loop at src/server.ts:2860-2866 calls manager.start one variant at a time. On a failure it throws HttpError(400) partway through, and the runs that already started are left running in the group without any notice. manager.start (src/engine.ts:5075 onw …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** Make the server reject instead of truncate, and make the dialog enforce the same limits.

1. In startComparison (src/server.ts:2845-2849):
   - Remove `.slice(0, 6)`.
   - Validate explicitly, e.g. `if (variants.length > MAX_COMPARE_SETUPS) throw new HttpError(400, "Compare at most N setups")`. Either raise the setup cap to 9 so the 9-run total is the only limit, or keep 6 and say so.
   - Export the constants (MAX_COMPARE_SETUPS and MAX_COMPARE_RUNS = 9) from a shared module so the UI and server cannot drift apart.

2. In CompareDialog (ui/composer.tsx:457-537):
   - Disable Start when `picked.size > MAX_COMPARE_SETUPS`.
   - Show the reason in the footer, e.g. "7 setups — at most 6", next to the existing run-count hint.
   - Optionally disable the unchecked boxes once the cap is reached.
   - Optionally put the current pattern first so it is never the one left out.

3. Partial starts:
   - Either pre-validate in startComparison everything manager.start can reject, or catch per-varian …

**Suggested regression test:** Server: add a test, e.g. test/compare-api.test.ts or a case in test/server-reliability.test.ts, using that file's harness: a real server on a free port with fake agents and a temporary git repo.
- POST /api/compare with 7 solo variants (labels V1..V7, roles {agent:["claude"]}) and repeat 1.
- Assert one of two outcomes: status 400 with a message naming the setup limit and no new runs in /api/runs; or, if the cap is raised, status 201 with runs.length === 7 and a group label set equal to {V1..V7} …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4659-t24 on port 4659, with a new home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4659-t24. I used my own scratch clone of MQTT-MCP, registered through the API as project "v4659-mqtt".

UI run (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659-t24/cmp7.mjs, log cmp7.log in the same folder):
1. In New run I chose the project and typed a task, then went to Insights > Experiments > Compare setups... using in-app navigation. "Agent" was preselected.
2. I ticked Team, Fix & review, Plan > Build > Review, Best-of-N race, Debate > Synthesize > Build and Supervisor > Workers. That made 7 checked; the footer said "7 runs; they share code-flow's agent slots..." and the button read "Start 7 runs" and was enabled. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4659-t24/001-compare-picked.png
3. I clicked Start. The captured request had all 7 variants in its body (the last one was 'Agent'). The server answered POST /api/compare with HTTP 201 and only 6 run ids, group gmvogp0bl289f. The dialog closed with no error.
4. /api/runs had 6 runs in the group and no Agent/solo run. The Insights comparison for that group (view.mjs) showed 6 rows and no Agent row. The page had no warning text about skipped or limited setups, and errors[] was empty.

API run: I posted 7 solo variants labelled V1..V7 to /api/compare. It returned 201 and group gmvogq4vb9716 started only V1..V6; V7 was dropped silently.

I tried to refute it and could not:
- No document states a 6-setup limit. docs/runs.md:134 only says "several patterns". The only stated limit is "at most 9 runs", in both the UI and the server error text.
- The reporter's environment is not the cause: my server, profile, project and selectors were all fresh.

Both the server's slice(0, 6) and the UI's runs > 9 cap came in the same commit, 824d79f (M7). The 6 is an unadvertised cap; it is not a documented design choice.

</details>

### S02-1 · minor · startComparison silently keeps only the first 6 variants while CompareDialog allows 7-9 picks with repeat=1 and says 'Start N runs'; if manager.start fails on a later variant, the runs already started keep going and the client gets only an error with no group id.

Source: code-level suspect at `src/server.ts:2846` (confirmed hands-on).

**Repro**

> Fake-mode QA server s02 (127.0.0.1:4509) with a scratch two-repo project. (1) UI: New run, set the workflow to Fix & review, type a task, then Insights > Experiments > Compare setups. Tick 7 setups (Team, Fix & review, Plan>Build>Review, Loop until green, Best-of-N race, Debate, Supervisor>Workers). The footer says '7 runs' and the button says 'Start 7 runs'. Click it. The response was 201 {group:'gmvo3vhqxf46f', runs:[6 ids]}. The group held 6 runs and 'Supervisor -> Workers' was dropped with no message; the Insights page showed nothing about it (script work/s02/s1-compare.mjs, screenshots shots/s02/001-s1-compare-7.png and 002-s1-after-start.png). (2) API: POST /api/compare {run:{repo,project,projectSelection:'explicit',task,loop:{check:''}}, variants:[{pattern:'solo',roles:{agent:['claude']}},{pattern:'loop',roles:{workers:['codex']}}]} returned 400 'Loop: Loop until green needs a check command…' with no group id. Run 2610251733-444bde83 (solo, group gmvo3w5vec65b) had already started anyway and ran to 'done' (work/s02/s1b-partial.mjs).

**Expected:** Either every selected setup is started (the button promised 7), or the request is refused up front with a clear limit, e.g. 'Compare at most 6 setups'. In line with the code comment ('Check every setup before starting any, so a typo doesn't leave half a comparison running'), a failing setup should not leave other runs of the group started, or the response should at least return the group id and say which setups started.

**Actual:** The 7th to 9th setups are dropped silently (body.variants.slice(0, 6)), and the UI still says 'Start 7 runs'. When manager.start throws for a later variant, the earlier runs are already started in an orphan group, and the client only sees a 400 error.

**Root cause (verifier):** The server caps setups at 6 (slice(0,6)) while the dialog caps total runs at 9 (runs > 9 disables Start), so the two limits disagree. Preflight only runs buildStartInput. Checks that live only in manager.start (requiresCheck, taskTeam versus pattern, auto-team rollout, remote inventory, docker presence) fire inside the sequential start loop, which has no rollback and returns no partial result.

**Suggested fix:** Pick one limit and enforce it in both places: the server rejects variants.length > 6 with HttpError 400 instead of slicing, and CompareDialog disables extra checkboxes once 6 are picked, with the footer saying 'at most 6 setups'. Move the start-time validations into a shared preflight (for example manager.validateStart(input) called for every input before the loop). If a start still fails, cancel the runs already started for the group, or return {group, runs, failed} so the UI can navigate to the partial group.

**Suggested regression test:** API test in test/server or compare test: POST /api/compare with 7 valid variants should return 400, or 201 with 7 runs, but never 6. POST [solo, loop] with check '' should return 400 and manager.list() should contain no run with that group. Browser test: pick a 7th setup and assert it is disabled, or that the button text matches the number of runs created.

### S02-8 · minor · Additional finding while verifying suspect 1 (not in batch): Compare setups from an Agent draft whose AI team was ever toggled (even if now Off) fails for every non-Agent setup.

Source: code-level suspect at `src/server.ts:2857` (confirmed hands-on).

**Repro**

> Fake QA server s02. New run (Agent): turn AI team On, then Off (limits 4/20/30), and type a task. Insights > Experiments > Compare setups > tick 'Fix & review' and 'Agent' > Start 2 runs. POST /api/compare returns 400 {"error":"Fix & review: Team switching requires a local Agent conversation"} and the dialog shows that error. No runs start (work/s02/s1c-taskteam-compare.mjs, shots/s02/001-s1c-compare-taskteam.png).

**Expected:** Comparing workflows from an Agent draft starts each setup. The Agent-only taskTeam setting applies only to the Agent variant, or is dropped.

**Actual:** Every non-solo variant is rejected by manager.start because the base carries taskTeam. The error is phrased for team switching and gives the user no actionable fix, short of switching the composer to another workflow first.

**Root cause (verifier):** runBody (composer.tsx ~198) includes taskTeam whenever the composer is in Agent mode and taskTeam state exists (it stays defined with enabled:false after the first toggle). comparisonDraft passes it to CompareDialog, whose base clears only approvals. startComparison spreads base into every variant, and engine.startResolved throws 'Team switching requires a local Agent conversation' for any non-solo pattern with input.taskTeam.

**Suggested fix:** In startComparison, pass taskTeam only when the variant pattern is 'solo' (for example `taskTeam: (v.pattern ?? base.pattern) === 'solo' ? base.taskTeam : undefined`), or strip taskTeam in InsightsView's CompareDialog base the way approvals is cleared.

**Suggested regression test:** API test: POST /api/compare with run.taskTeam {enabled:false,…valid} and variants [fix-review, solo] returns 201 with 2 runs. Browser test: compare from an Agent draft after toggling AI team.

### t23-14 · minor · Insights 'Compare setups…' is disabled after a reload or deep link even though a New run draft is saved

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-17.

**Repro**

> 1. New run: type a task in project X.
> 2. Reload the page or open #/insights directly (a full page load).
> 3. Open Experiments.

**Expected:** Compare uses the saved project draft.

**Actual:** The button is disabled: 'Configure a task in New run first.' It works only if you navigate to Insights in-app while the composer is still mounted.

**Root cause (verifier):** ui/workflow-ui.ts:3: `comparisonDraft` is a plain `signal(null)`. Its only writer is the Composer component, at ui/composer.tsx:238-239 (`const comparisonBody = p ? runBody(p) : null; useLayoutEffect(() => { comparisonDraft.value = comparisonBody; }, ...)`). `runBody` (ui/composer.tsx:194-235) is a closure inside `Composer()`.

ui/insights.tsx:24-25 reads only `comparisonDraft.value`; when it is null, `comparisonProblem` becomes "Configure a task in New run first." and the button is disabled (insights.tsx:62).

ui/app.tsx:150-151 renders ActivityView for #/insights and mounts Composer only on the composer route (app.tsx:168). After a reload or deep link to #/insights, Composer never mounts, so the signal stays null. This happens even though ui/state.ts:1312-1332 (`initializeProjectDrafts` → `restoreComposer(saved)`) has already restored task, pattern, roles, options and `composerRunOptions` into global signals.

Side effect: the signal is never cleared or recomputed when Composer unmounts, so after a draft-project switch made without the Composer mounted, Insights can show a stale body.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workflow-ui.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/insights.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/simplification.e2e.ts`

**Suggested fix:** Derive the comparison body from persisted global state instead of the mounted component.

1. Move `runBody` out of `Composer()` into a module-level pure builder, e.g. `composerRunBody(p, runOptions)`. Put it in ui/composer.tsx or a small ui/composer-body.ts. It reads only global signals: repo, composerProject, task, acceptanceCriteria, roles via rolesFor(p), optionsFor(p), baseRef, source, branchPrefix, externalSource, contextPaths, attachments, agentSettings, roleModels, planApprovalFor, trust, limits, checkCmd, setupCmd, contextBudget, rerunDraft, repoConfig, intentDraft, journeyDraft and selectedTeamTemplate. It also reads `composerRunOptions`, which already mirrors the Composer-local taskTeam, remoteWorker, container, verificationProfile, toolApprovals, antigravityExecution and permissionRequirements (composer.tsx:166-168) and is saved with the draft snapshot.

2. Turn `comparisonDraft` into `computed(() => draftsReady.value && !composerLoading.value && pattern.value ? composerRunB …

**Suggested regression test:** Add an e2e case to test/e2e/simplification.e2e.ts:
- On #/, fill Task with "Compare after reload".
- Set `location.hash = "/insights"`, then `await page.reload()`.
- Click "Experiments".
- Assert the "Compare setups…" button is enabled (`isDisabled() === false`), the text "Compare after reload" is visible in the Experiments panel, and "Configure a task in New run first." is absent.
- Open the dialog, route **/api/compare as the existing test does, start 2 runs, and assert `request.run.task` matc …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4631 on 127.0.0.1:4631 and a new browser profile "v4631-t2314". Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631/t2314.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631/t2314.log.

Steps and results:
1. Opened #/project/p-ef01794b (MQTT-MCP), clicked "New run" and typed "Add a short note to README about the MQTT broker port" in Task. The draft was persisted: localStorage had composerProject=p-ef01794b and draftTask=<task>.
2. Control: in-app hash navigation to #/insights, then opened Experiments. "Compare setups…" was enabled and the task line showed.
3. page.reload() on #/insights, then opened Experiments. The button was disabled with title "Configure a task in New run first." and the help text "Configure a task in New run first. Configure task" (screenshot shots/v4631/004-B-after-reload.png).
4. Clicked "Configure task". The composer at #/ showed the saved task restored unchanged. Back on Insights in-app, the button was enabled again (D).
5. Deep link: a new tab opened directly at #/insights also had the button disabled with the same title. In-app navigation to #/ in that tab showed the restored task.

No console errors or 5xx responses. No runs were created. Server stopped and ports 4631/4632 are free.

Not by design: docs/runs.md:134 and the panel's own help text ("Compare workflows against your current New run draft") describe the saved draft. The draft is fully restored into global signals at startup on any route, so the "configure a task first" message is wrong. Not caused by the tester's environment: it reproduces with a fresh profile and real UI clicks. The existing e2e tests (test/e2e/simplification.e2e.ts:139-147 and 184-205) only reach Insights by in-app navigation after typing in a mounted composer, so they never hit this case.

</details>

### t24-16 · minor · Compare setups is disabled after a page reload on Insights even though the New run draft is saved

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features PLAT-18.

**Repro**

> 1. New run: choose a project and type a task (draft saved). 2. Navigate to /#/insights in a way that reloads the page (address bar or bookmark), or reload while on Insights. 3. Expand Experiments.

**Expected:** Compare setups uses the saved New run draft for the current project.

**Actual:** Button disabled with 'Configure a task in New run first.' until the user visits New run again and comes back without reloading.

**Root cause (verifier):** ui/workflow-ui.ts:3 creates `comparisonDraft = signal(null)`. Only ui/composer.tsx:237-239 ever fills it: `const comparisonBody = p ? runBody(p) : null; useLayoutEffect(() => { comparisonDraft.value = comparisonBody; }, [comparisonBody]);`. That code runs inside the Composer component, which is mounted only on the composer route (ui/app.tsx:168).

On a full page load that starts on #/insights, initializeProjectDrafts (ui/state.ts:1315-1332) still restores the saved project draft from IndexedDB into the global signals: task, patternId, roleSel, roleModels, agentSettings, composerRunOptions (the persisted run options) and so on. Nothing derives the comparison body from those signals, though, so comparisonDraft stays null.

ui/insights.tsx:24-25 reads `comparisonDraft.value`, treats null as "no draft", and shows "Configure a task in New run first." It also disables the button (ui/insights.tsx:65). The state only recovers once the Composer mounts and its layout effect publishes the body. The message is also misleading, because a task does exist in the saved draft.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workflow-ui.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/insights.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/simplification.e2e.ts`

**Suggested fix:** Build the comparison body from the restored draft state instead of depending on the mounted Composer.

1. Take `runBody` out of the Composer (ui/composer.tsx:197-235) and turn it into a module-level builder, for example in ui/composer-tools.ts or ui/state.ts. The builder reads the global draft signals (task, acceptanceCriteria, patternId/roles, roleModels, agentSettings, optionValues, baseRef, branchPrefix, source, externalSource, contextPaths, attachments, checkCmd/setupCmd, limits, contextBudget, trust, rerunDraft, repo, composerProject, repoConfig). For the settings that live only in component state it reads `composerRunOptions.value`: taskTeam, remoteWorker, container, verification profile, toolApprovals, antigravityExecution and permissionRequirements. composerRunOptions is already persisted in the snapshot and restored at ui/state.ts:1240.
2. Make `comparisonDraft` in ui/workflow-ui.ts a `computed` that returns null while `!draftsReady.value || composerLoading.value`, and otherwi …

**Suggested regression test:** Add a case to test/e2e/simplification.e2e.ts next to "scheduling shares four purposes and comparisons live in Insights". Steps:
1. `page.goto(base + '/#/')`, fill Task with "Compare after reload".
2. Wait for the draft to persist, then `page.goto(base + '/#/insights')` followed by `page.reload()`, so a full document load lands on Insights.
3. Open Experiments and assert that `getByRole('button', {name: 'Compare setups…'})` is enabled, that the text "Compare after reload" is visible, and that "Co …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4689-t2416 4689 fake. It got a new home because the old v4689 home held another verifier's state. I drove it with a persistent Chrome profile (v4689-t2416) using the script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689-t2416/repro.mjs. Its output is in repro.log in the same folder.
1. In New run (#/) I picked project MQTT-MCP through the project button and filled the Task field with "Add a one-line comment to README.md describing the repo purpose".
2. Control (A): I went to Insights with location.hash = '#/insights', which does not reload the page, and opened Experiments. "Compare setups…" was enabled and the draft task was shown.
3. (B) page.reload() while on #/insights: the button was disabled with title "Configure a task in New run first.", and the help line "Configure a task in New run first. Configure task" appeared with no task text. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689-t2416/003-B-reload-on-insights.png
4. Without another reload I went to #/ in-app. New run showed the restored task, so the draft really was saved. Back on #/insights (C) the button was enabled again.
5. (D) Address-bar style: about:blank, then page.goto(base + '/#/insights'). The button was disabled again with the same message.
6. A separate script (wait.mjs, output in wait.log) opened /#/insights in a new document and waited 10 seconds. The button was still disabled, so this is not a race with draft restore. Clicking the "Configure task" link opened New run with the saved task already filled in.
Result: 4 of 4 full page loads gave the disabled state, and no console, page or 5xx errors were recorded.
It is not by design. The Experiments help text and docs/runs.md:134 both say the comparison uses "your current New run draft". The existing e2e tests (test/e2e/simplification.e2e.ts:141-146 and :199-201) reach Insights only through in-app navigation (menu click or location.hash), so they never exercise a reload.
It is not caused by the reporter's environment either: I used my own server, my own profile, real UI selectors, and a draft that is saved in IndexedDB.

</details>
