# Cluster 48 · a11y-keyboard-layout

**Accessibility, keyboard shortcuts and phone layout**

Status: **fixed and verified** · 11 entries / 9 distinct issues · branch `codex/qa-a11y-keyboard-layout`

Planner notes: t25-1: Menu and select triggers replace their visible text with a fixed aria-label (ui/panel-bits.tsx:177, model-select). Include the value (WCAG 2.5.3) and add that rule to the axe sweep. t25-2/t26-10: scroll regions capped with overflow:auto (plan body, the .run-task bubble, code blocks, phone shortcuts) need tabIndex=0 and an accessible name. t23-7: the memory provenance graph's <g role=button tabIndex> is not focusable in Preact SVG; set the tabindex attribute. t25-6: j/k recomputes its target from the live DOM, so opening an unseen run moves it out of 'Needs you' under the cursor. t25-7/S05-4: [ and ] do nothing on solo and chat runs but still call preventDefault (ui/run.tsx:174). t25-8: <select> controls under 16px make iOS zoom (ui/styles.css:1756). t26-5: JS smooth scrolling ignores prefers-reduced-motion; add a helper in ui/lib.ts. t25-16: in phone landscape the conversation gets only 84px; add height media queries. t25-18: the lazy-view error has no padding. Keep the axe e2e at 0 violations. Duplicate groups: [["t25-2","t26-10"],["t25-7","S05-4"]]

Likely files: `ui/panel-bits.tsx`, `ui/model-select.tsx`, `ui/run.tsx`, `ui/team.tsx`, `ui/bits.tsx`, `ui/memory-analysis.tsx`, `ui/app.tsx`, `ui/lib.ts`, `ui/lazy-view.tsx`, `ui/styles.css`

## Final integrated follow-up · 2026-10-26

The full original shared-projects audit found the archive count visible but absent from its accessible name. Commitd2ce8a0 derives the name from visible label and count. Both toggle states and the original six-case shared-projects suite pass. Updated old selectors retain keyboard-hint and step-outcome assertions. See [daily evidence](../final-partials-daily.md) and [validation](../final-validation.md).

## Repair and independent verification · 2026-10-26

Implemented and tested in `/private/tmp/codeflow-qa-continue/a11y-keyboard-layout`, based on integration `d905023`. Every test, build, and application-import command used an explicit scratch `CODEFLOW_HOME`. Browser fixtures created temporary repositories and homes, used fake agents and ephemeral loopback ports excluding 4317/4318, and removed their servers and data afterward. No live home, live server, external remote, push, or PR was used.

| Entry | Confirmed cause and outcome | New verification |
| --- | --- | --- |
| t25-1 | Fixed. Text-bearing Menu triggers include their visible value in the accessible name; icon-only triggers retain their labels. ModelSelect, Improve and command-palette buttons include the displayed value/shortcut. Every existing axe sweep now includes `wcag21a`. That exposed adjacent Inbox count, workflow-step metadata and SVG-node name mismatches, which were also corrected. | Composer audits in light/dark and at 390px; provider/model/permissions accessible-name assertions; original broad accessibility sweep. Existing menu/model test selectors now match the value-bearing names. |
| t25-2, t26-10 | Fixed. Task text, plan/question bodies, Markdown code blocks and shortcut lists have explicit keyboard focus and names. | Real End/PageDown scrolling in long task, approval, code fence and phone shortcut list; axe audits on task/plan/shortcut views. Current Auto-team approval renders structured prose, so the shared Markdown fence is exercised in a memory entry instead of relying on the old approval fixture's code fence. |
| t23-7 | Fixed the SVG attribute at its source: lowercase `tabindex` produces a browser focus target in Preact. Graph and node names also include visible revision/status text. | Tab from graph scroller reaches the first node; Enter and Space select nodes; graph axe audit. Unchanged baseline reports `tabIndex === -1`; repaired UI reports `0`. |
| t25-6 | Fixed. A keyboard traversal snapshots visible task order and skips removed tasks. Manual route/filter/group changes or pointer interaction reset it. Opening a task can still clear its real attention state immediately. | Three unit cases cover reorder, reverse/edge navigation, resets and deleted/new rows. Chrome opens three unseen tasks with j then reverses with k under both status and project grouping, waiting for persisted seen state between presses. |
| t25-7, S05-4 | Fixed. Brackets now focus and scroll actual agent turns in chats, including a focusable article fallback while a turn is running. Workflow runs retain step selection. Typed brackets in text/editable controls remain untouched. | A real solo follow-up produces two visible agent turns; bracket focus moves between them. An approval workflow still selects a timeline step; textarea input retains `[`. |
| t25-8 | Fixed. Coarse-pointer phone form rules include native selects and apply to short landscape windows as well as narrow portrait windows. | Visible Run defaults selects compute to at least 16px at 390×844; no horizontal overflow. Landscape chat controls remain usable. Device Safari zoom itself was not measured. |
| t26-5 | Fixed. Every explicit smooth-scroll call uses the common helper, which reads reduced-motion preference at the time of the action. | Actual Review plan action records `auto` with reduced motion and `smooth` after changing the preference at runtime. No literal smooth-scroll action remains outside the helper. |
| t25-16 | Fixed. Short windows have a scrolling run header, compact agent strip/composer and a textarea capped at 15dvh. The rail's attention state is unchanged. | At 844×390, empty and five-line drafts leave at least 140px of conversation viewport. At 844×340, a five-line draft leaves at least 120px. Captured screenshots were visually inspected; the header is not sticky and the composer remains usable. |
| t25-18 | Fixed. Loading and failed lazy views share spacing, scoped to their main/side-panel container to avoid double padding inside existing pages. | Abort the actual settings chunk, verify padded recoverable alert at desktop and phone widths, unblock it and reload successfully. |

New regression artifacts: `test/qa-a11y-keyboard-layout.test.ts` and `test/e2e/qa-a11y-keyboard-layout.e2e.ts`. Original reproduction attempts were independently replayed on unchanged `1fca2c6`: all eight scenario groups failed before repair (`a11y48-baseline.log`). A separate SVG-only baseline confirms the actual focus defect (`a11y48-baseline-memory.log`). The phone native-select baseline was also isolated on unchanged `d905023` (`a11y48-baseline-selects.log`).

Validation and evidence, all under `/private/tmp/codeflow-qa-continue/`:

- `a11y48-final-tsc.log`: `tsc --noEmit` passed.
- `a11y48-final-unit.log`: **21/21** passed: new navigation, conversation rendering, review and ACP UI tests.
- `a11y48-final-browser.log`: **8/8** new Chrome/server scenarios passed. `a11y48-final-browser/` contains screenshots, axe JSON, server log and an empty page-error list. Only Node's expected experimental SQLite warning was present. Audits wait for theme changes and finite CSS transitions to settle; no accessibility rule was suppressed.
- `a11y48-original-accessibility.log`: **2/2** original broad accessibility/keyboard scenarios passed with WCAG 2.1 A included.
- `a11y48-original-improve.log`: **6/6** original Improve scenarios passed.
- `a11y48-original-models.log`: **4/4** original setup/model/free-model scenarios passed.
- `a11y48-related-browser.log`: **11/11** permission-menu and attention scenarios passed.
- `a11y48-original-memory.log`: **4/4** original memory/graph scenarios passed.

The expanded `test/assets.test.ts` check found an existing startup-budget failure, separately owned by the integration task: unchanged `d905023` is **897,856 bytes**, this repair is **900,058 bytes**, against the unchanged **850,000-byte** limit (`a11y48-baseline-d905-assets.log`, `a11y48-assets.log`). The earlier `1fca2c6` baseline was already **893,606 bytes**. Compression and lazy xterm checks pass; the threshold was not loosened. Root will repair the integrated startup bundle after the remaining UI clusters. This does not leave an unresolved issue among the eleven entries here.

Limits: real Safari/iOS, screen-reader speech and voice-control software were not run. The evidence establishes browser semantics, computed font sizes, real keyboard behavior and zero violations for the exercised axe rules; it is not a claim of complete WCAG conformance.

## Follow-up from the original team onboarding replay · 2026-10-26

The expanded WCAG 2.1 A audit exposed the same visible-name issue in People and access: explicit labels on member buttons excluded decorative avatar text and replaced the visible `You` badge with `(you)`. The buttons now use their native content-derived names; initials remain decorative and the visible name/You badge supplies the accessible name. Expansion state and controlled detail IDs are unchanged.

New `test/e2e/qa-a11y-people-names.e2e.ts` independently fails on the unmodified component at both 1440px and 390px (`/private/tmp/codeflow-qa-continue/people48-baseline.log`). The desktop failure includes the owner, Alice and Émilie Dupré. After repair, both new scenarios pass: complete people-region axe sweeps, exact names, real Enter/Space expansion and collapse, retained focus, and no horizontal overflow. The complete original `team-onboarding.e2e.ts` also passes (12/12 combined including the two new cases), with no invitation-count cascade. `tsc --noEmit` passes. Logs: `people48-fixed.log`, `people48-tsc.log`; screenshots and audit JSON: `people48-fixed/`, with an empty page-error list and no unexpected server errors. All commands used an explicit scratch home, fake providers and isolated ephemeral listeners; no live home/server was used.

## Issues

### t25-1 · minor · Menu/select trigger buttons hide their visible value from the accessible name (WCAG 2.5.3); the project's own axe sweep never checks this rule

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-01.

**Repro**

> 1. Start a fresh fake QA server and open the composer at 1440x900.
> 2. Inject node_modules/axe-core/axe.min.js and run axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}}).
> 3. Look at the violations, or inspect the composer's Provider/Model/Effort/Permissions buttons in the accessibility tree.

**Expected:** No violations. A screen reader or voice-control user hears the current value, e.g. 'Claude Code, Provider'.

**Actual:** label-content-name-mismatch (serious) fires on 7-9 nodes on every screen, in light/dark and at every width. The buttons visibly read 'Claude Code', 'Default model', 'Default effort', 'Ask for approval', 'This computer', 'Code Flow', 'Improve · Auto', 'Current branch · main' and '⌘K'. Their accessible names are 'Provider', 'Model', 'Effort', 'Permissions', 'SSH connections', 'Application menu', 'Improve', 'Start from branch' and 'Open command palette', so the current choice is never announced. test/e2e/accessibility.e2e.ts:32 runs axe with ['wcag2a','wcag2aa','wcag21aa','wcag22aa'], which leaves out 'wcag21a' (the tag on this rule), so CI cannot catch it.

**Root cause (verifier):** Trigger components replace visible text with a fixed aria-label:
- ui/panel-bits.tsx:177: Menu always renders `aria-label={label}` (and title={title ?? label}) on its button, even when the `trigger` prop renders visible text. This affects Provider/Effort/Permissions in ui/chat-controls.tsx:36,46,65, Provider in ui/composer.tsx:325, "Application menu" in ui/rail.tsx:519, "SSH connections"/"Project computer" in ui/ssh-projects.tsx:35, and "Chat mode" in ui/side-chat.tsx:368.
- ui/model-select.tsx:56: the trigger has `aria-label={label}` while it shows `{selected?.label ?? placeholder}`. This affects Model in chat-controls.tsx:39, Start from branch in composer.tsx:710, and the other ModelSelects (task-team.tsx:52, composer.tsx:1096/1107/1229).
- ui/app.tsx:213: the command button is aria-label="Open command palette" but shows "⌘K".
- ui/composer.tsx:831: aria-label={improve.busy ? "Stop" : "Improve"} while it shows "Improve · Auto".
CI gap: test/e2e/accessibility.e2e.ts:32 uses tags ["wcag2a","wcag2aa","wcag21aa","wcag22aa"]. The other e2e axe calls use the same list or a narrower one (ui.e2e.ts:840, ux-flows.e2e.ts:158, improve.e2e.ts:280, team.e2e.ts:64, shared-projects.e2e.ts:28, a …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/panel-bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/model-select.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ssh-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/accessibility.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/accessibility.md`

**Suggested fix:** 1. Menu (panel-bits.tsx:177): when `trigger` is given, stop setting aria-label. Render `<span class="sr-only">{label}: </span>{trigger}` inside the button (the .sr-only class already exists in styles.css:1539), or use aria-labelledby pointing at a hidden label span plus the content span. The name becomes, for example, "Provider: Claude Code" or "Permissions: Ask for approval". Keep aria-label={label} only for icon-only menus. Drop title when it just repeats the label, so the redundant description "Provider" goes away. The role=menu's own aria-label stays.
2. ModelSelect (model-select.tsx:56): do the same. Remove aria-label and render `<span class="sr-only">{label}: </span><span>{selected?.label ?? placeholder}</span>`, giving names like "Model: Default model" and "Start from branch: Current branch · main".
3. app.tsx:213: use aria-label "Open command palette (⌘K)" or "Commands ⌘K", or keep the label, mark the glyph aria-hidden and add aria-keyshortcuts="Meta+K". Re-check with axe wheth …

**Suggested regression test:** test/e2e/accessibility.e2e.ts:32: add 'wcag21a' to the runOnly tag values (ideally from a shared WCAG_TAGS constant that every e2e axe call imports). The existing assert.deepEqual(failures, []) at the end of the main test then fails on label-content-name-mismatch for the composer, light/dark and mobile screens until the triggers are fixed.
Add a focused assertion in the same file (or ui.e2e.ts): on the composer, getByRole('button', { name: /Claude Code/ }) and getByRole('button', { name: /Ask fo …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake QA server v4667t251 on 127.0.0.1:4667 (new home, no runs), fresh headless Chrome profile, composer at #/. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667t251/axe.mjs, ax.mjs and menu.mjs, with logs axe.log, ax.log and menu.log in the same folder.
(1) Injected the repo's own axe-core 4.14.0 and called axe.run(document, {runOnly:{type:'tag', values:[wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa]}}).
- Results: label-content-name-mismatch (serious) on 8 nodes at 1440x900 light, 8 at 1440x900 dark and 6 at 390x844 (the 390 layout hides the rail and the command button). With a repository selected (localStorage repo = MQTT-MCP) it is 9 nodes, because the "Current branch · main" / "Start from branch" trigger appears.
- Visible text vs accessible name: "Code Flow" / "Application menu", "This computer" / "SSH connections", "⌘K" / "Open command palette", "Improve · Auto" / "Improve", "Current branch · main" / "Start from branch", "Claude Code" / "Provider", "Default model" / "Model", "Default effort" / "Effort", "Ask for approval" / "Permissions".
(2) Ran the CI tag list from test/e2e/accessibility.e2e.ts:32 (no wcag21a) on the same page: 0 violations, and the rule is absent from passes, violations, incomplete and inapplicable, so it never runs. In axe 4.14 the rule is no longer marked experimental, and wcag21a covers exactly this one rule. Every other e2e axe call also leaves out wcag21a.
(3) Chrome AX tree via CDP Accessibility.getFullAXTree: Provider has name "Provider" and description "Provider"; Model has name "Model" and no description; Permissions has name "Permissions" and description "Permissions"; Start from branch has no description. None of these four exposes the current value. Effort carries it only in its title description ("Effort: Default effort"), and Improve only in its aria-description.
- getByRole('button', {name: 'Claude Code'}) and {name: 'Ask for approval'} both return 0, so a voice-control user cannot say what they see.
(4) Mitigation: once opened, the Provider, Effort and Permissions menus do name the chosen item ("Claude Code Selected"), so screen-reader users can find the value by opening the menu.
Refutation attempts failed:
- docs/accessibility.md says "WCAG 2 A/AA, 2.1 AA and 2.2 AA". That describes the tag list but gives no reason for skipping 2.1 Level A, and AA conformance includes A.
- Not caused by the tester's environment: a fresh se …

</details>

### t25-2 · minor · Scrollable regions that cannot be focused: plan-approval body, long task bubble, code blocks, phone shortcuts list

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-01, UX-08.

**Repro**

> 1. On a fresh fake server, POST /api/runs {pattern:'auto-team', task:'Team fake run AUTO-USER-QUESTION add a greeting', roles:{coordinator:['claude'],pool:['claude']}} on a scratch repo and wait until it is awaiting 'Approve Auto team'.
> 2. Open #/run/<id> and run axe with the wcag2a/2aa/21aa/22aa tags.
> 3. Also start a solo run with a task over 3,000 characters, open it and run axe.
> 4. At 390x844, press '?' and run axe.

**Expected:** Scrollable content is keyboard-reachable in every browser (tabindex=0 plus an accessible name), as the project's 'keep axe at 0' goal requires.

**Actual:** scrollable-region-focusable (serious): .aw-body on the plan approval card (320px max, 484px content); .run-task on the long-task header (280px tall, 3761px content); '.md > pre' in the approval body at 768 and 390; and .dialog-body in the shortcuts dialog at 390. Chrome 130+ makes these scrollers focusable on its own (verified: Tab reaches .aw-body in Chrome 155), but Safari and Firefox keyboard users cannot scroll the plan they are asked to approve. The project's e2e sweep never opens these screens.

**Root cause (verifier):** Each scroll container has a capped height and overflow:auto but no tab stop or accessible name, and has no focusable children:
- ui/run.tsx:1717: `<div class="aw-body"><Markdown text={awaiting.content} /></div>`. Same markup in ui/team.tsx:261 (TeamQuestionCard). CSS at ui/styles.css:1484: `.aw-body { max-height: 320px; overflow: auto; }`.
- ui/run.tsx:281: `<div class="run-task"><BrowserMessage text={run.task} /></div>`. CSS at ui/styles.css:759: `.run-task { max-height: 20em; overflow: auto; }`.
- ui/bits.tsx:57: Markdown code fences render as a bare `<pre>`. The global rule at ui/styles.css:101 gives every pre `max-height: 280px; overflow: auto`. Once the plan's code block wraps at 768px or narrower it overflows, and it is nested inside .aw-body.
- ui/app.tsx:470: ShortcutsDialog `<div class="dialog-body">` holds only a table. CSS at ui/styles.css:1376: `.picker-inner > .dialog-body { overflow-y: auto }`. At 844px tall the 13 rows overflow by about 34px.
Chrome 130+ makes such scrollers focusable on its own. Safari does not, so a Safari keyboard user cannot scroll to the end of the plan they are asked to approve, a long task, a long code block, or the last shortcut row. Severity …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/accessibility.e2e.ts`

**Suggested fix:** Use the pattern the codebase already follows (insights.tsx:122, collab-board.tsx:87, memory-graph.tsx:31): tabIndex={0} plus role="region" plus an aria-label on each capped scroller.
- run.tsx:1717 and team.tsx:261: `<div class="aw-body" tabIndex={0} role="region" aria-label="Proposed plan">` (for TeamQuestionCard, "Team question").
- run.tsx:281: `<div class="run-task" tabIndex={0} role="region" aria-label="Your task">`.
- bits.tsx:57: `<pre tabIndex={0}>` for Markdown code fences, matching run.tsx:1084. A role/label is optional for a pre.
- app.tsx:470: `<div class="dialog-body" tabIndex={0} role="region" aria-label="Shortcut list">`. Alternatively, let the shortcuts dialog grow or use a smaller row height so it does not overflow at 844px.
Optional refinement to avoid needless tab stops on short content: a tiny useOverflowFocus(ref) hook (a ResizeObserver that sets tabIndex 0 only while scrollHeight > clientHeight, else -1) applied to .run-task and .aw-body. Add a :focus-visible outl …

**Suggested regression test:** Extend test/e2e/accessibility.e2e.ts, reusing its audit() helper and tag set, which already fails on any wcag2a violation. Start a fake auto-team run with "AUTO-USER-QUESTION" and wait for `.awaiting-card` "Approve Auto team", then audit at 1440x900 and again at 390x844; the plan text has a fenced block, which covers .aw-body and '.md > pre'. Start a solo run whose task is over 3,000 characters, open it and audit. At 390x844, press "?" and audit the shortcuts dialog. Assert zero violations in ea …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server "v4669t252" on port 4669 with an empty home. Scratch git repo at clones/v4669t252-tiny (one commit). Fresh Chrome profile for every script.
1. As setup, POST /api/runs {pattern:"auto-team", repo:<scratch>, task:"Team fake run AUTO-USER-QUESTION add a greeting", roles:{coordinator:["claude"],pool:["claude"]}}. It reached awaiting "Approve Auto team" within a few seconds. Also POST a solo run (roles {agent:["claude"]}) with a 6,124-character task; it finished as done.
2. Opened #/run/<id> and injected the repo's own axe-core 4.14.0. Ran it with exactly the tag set from test/e2e/accessibility.e2e.ts:32 (wcag2a, wcag2aa, wcag21aa, wcag22aa). Note that scrollable-region-focusable is tagged wcag2a, so the project's own suite would fail on it.
Results (work/v4669t252/audit-1440.log, audit-768.log, audit-390.log):
- 1440x900: plan approval has 1 violation, scrollable-region-focusable (serious) on .aw-body (clientH 320, scrollH 484, no tabindex/role/label, 0 focusable children). Long task: .run-task (280 / 2687). Shortcuts dialog: 0.
- 768x1024: .aw-body (320 / 592) plus '.md > pre' (278 / 461). .run-task (280 / 2709). Shortcuts: 0.
- 390x844: .aw-body (320 / 722) plus '.md > pre' (278 / 576). .run-task (280 / 4030). Shortcuts dialog .dialog-body (545 / 579): the screenshot shows the last row "? This list" cut off, and the only focusable control, Done, is outside the scroller.
- Console and page errors and 5xx responses: none.
3. Real-impact check: in Chrome 155, Tab from the card heading goes straight to div.aw-body, and PageDown scrolls it (0 to 164 px). So Chrome users are fine, as reported. I tried to stand in for Safari by launching Chrome with --disable-features=KeyboardFocusableScrollers. It made no difference: the flag no longer exists in Chrome 155, so that test proves nothing either way. No WebKit or Firefox build is installed, so I could not test Safari directly. I did confirm that the "Review plan" next-action only focuses the #run-approval wrapper (run.tsx:322, tabIndex -1), not the scroller, so it gives no other keyboard route into the plan text.
4. Fix check (fixcheck.mjs): adding tabindex=0, role=region and aria-label to .aw-body, '.md > pre', .run-task and the shortcuts .dialog-body in the live DOM brought axe to 0 violations on all three screens.
Refutation attempts that failed:
- Not by design: docs/accessibility.md says "keyboard access to scrolling results" was already fixed, and the existing fixes use the same pattern (insigh …

</details>

### t26-10 · minor · Long task bubble (.run-task, max-height 280px, overflow:auto) is a scroll region with no tabindex: axe scrollable-region-focusable

Source: tester unit usability-failure-cases-2; observed with fake-agents; features UX-21.

**Repro**

> 1. Start a run whose task is longer than about 15 lines.
> 2. Open the run at 390 or 768 px, light or dark, and run axe-core (wcag2a/2aa/21aa/22aa).

**Expected:** 0 violations; the clipped task text can be scrolled with the keyboard in every browser.

**Actual:** scrollable-region-focusable(1): .run-task. Chrome makes the scroller Tab-focusable on its own (verified: Tab reaches it, and the arrow keys scroll it), but Safari does not. Clipped text has no 'show more' affordance.

**Root cause (verifier):** In ui/run.tsx:281 the task bubble is rendered as a bare `<div class="run-task"><BrowserMessage text={run.task} /></div>`, with no tabIndex, role or accessible name. ui/styles.css:759 gives it `.run-task { font-size: 14px; max-height: 20em; overflow: auto; }`, which is 280 px at 14 px. A task taller than that therefore becomes a scroll container with no focusable descendant (BrowserMessage/Markdown output for plain text has none), so axe flags it as scrollable-region-focusable (WCAG 2.1.1 Keyboard).

Chrome and Firefox make such scrollers keyboard-focusable on their own, but the focused element has no name. Safari/WebKit does not make them focusable, so keyboard-only Safari users cannot reach the hidden lines. Nothing in the UI shows that the text is cut off.

test/e2e/accessibility.e2e.ts:22 uses a one-line fixture task, so its "run result" audit never renders an overflowing bubble.

**Files:** `ui/run.tsx`, `ui/styles.css`, `test/e2e/accessibility.e2e.ts`

**Suggested fix:** Minimal fix, matching how the codebase already handles scrollers: in ui/run.tsx:281 render `<div class="run-task" tabIndex={0} role="region" aria-label="Your task">`. Add a `.run-task:focus-visible` outline in ui/styles.css if the global focus style does not already cover it.

Better fix: only make the bubble focusable when it actually overflows. A ref plus ResizeObserver can compare scrollHeight against clientHeight, so short tasks do not add a needless Tab stop on every run page.

Alternatively, or as well, replace the inner scroll with a collapsed bubble and a real `<button aria-expanded>` labelled "Show full task" / "Show less", with a bottom fade while collapsed. That gives a visible cue that text is clipped, works on every browser and keeps an even reading flow on phones. Keep the max-height only for the collapsed state.

**Suggested regression test:** In test/e2e/accessibility.e2e.ts, create a second fixture run in before() whose task is about 25 plain-text lines with no links, for example Array.from({length:25},(_,i)=>`Line ${i+1}: ...`).join("\n"). Add it to the audited routes in the light/dark loop ("long task run"), and also audit it at the 390x844 mobile viewport. The existing assert.deepEqual(failures, []) then catches scrollable-region-focusable.

In the same test, add a direct assertion: locate .run-task and check that either (await e …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, "v4655t2610", on port 4655 with a new empty home, and created a throwaway git fixture repo in the scratchpad (scratchpad/qa/clones/v4655-fixture). I created two solo runs with POST /api/runs, using the same body as test/e2e/accessibility.e2e.ts: (a) a plain-text task of 25 lines, and (b) a one-line control task. I used the API because the composer would not start until a project was chosen for the fixture repo, and the issue is about the run view, not run creation. Both runs finished with status "done".

Script: scratchpad/qa/work/v4655/t26-10.mjs. Output: t26-10.log and t26-10.json. For each scheme (light, dark) and width (390, 768, 1440) it opened #/run/<id> in headless Chrome 155 with reduced motion, waited for animations to settle, injected the repo's node_modules/axe-core and ran it with tags wcag2a, wcag2aa, wcag21aa and wcag22aa (the same settings as the repo's accessibility e2e).

Results:
- Long task: exactly one violation in all 6 combinations, scrollable-region-focusable on ".run-task". This includes 1440 px, which the reporter did not test. At 390/768 px, scrollHeight/clientHeight is 1120/280; at 1440 px it is 560/280. tabindex attribute is null, tabIndex is -1, there is no role or aria-label, and there are 0 focusable descendants.
- Short control task: 0 violations at every width and in both schemes.
- Keyboard check at 768 px in Chrome: 27 Tab presses from the page start reach .run-task, which then shows a focus ring (screenshot shots/v4655t2610/001-long-dark-768-focused.png), and two ArrowDown presses move scrollTop from 0 to 80. Chrome makes scrollers keyboard-focusable on its own, but the focused element has no accessible name.
- Screenshot shots/v4655t2610/001-long-light-390.png shows the bubble cut off mid-line ("Line 7: update the fixture README with a ..."). There is no "show more" control, fade or other cue that more text is hidden.

I could not test Safari directly because no Playwright WebKit is installed. The claim that Safari does not do this rests on known browser behaviour: Chrome 130+ and Firefox make scrollers keyboard-focusable on their own, and WebKit does not.

Attempts to refute:
- Not by design: no doc, comment or test mentions the clipped task bubble. The rule came in with commit a87a47e ("Claude-style run thread"). Elsewhere the codebase gives scrollers tabIndex={0}, role="region" and aria-label: insights.tsx:122, memory-graph.tsx:31, collab-board.tsx:87, terminal.tsx:595, run.tsx: …

</details>

### t23-7 · minor · Memory provenance graph nodes cannot be reached or selected with the keyboard

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-05.

**Repro**

> 1. Project memory with a few entries → Advanced memory tools → Source and derived-entry graph.
> 2. Focus the graph scroller and press Tab.
> 3. Or focus a node with element.focus() and press Enter.

**Expected:** Each role=button node takes focus, and Enter or Space selects it and shows its status line.

**Actual:** Tab goes from the graph scroller straight to the next summary and skips every node. el.getAttribute('tabIndex') is '0' but el.tabIndex is -1. Enter does nothing (it toggles the surrounding details). A mouse click works.

**Root cause (verifier):** The bug is at ui/memory-analysis.tsx:88, where MemoryProvenanceGraph renders each node as `<g ... role="button" tabIndex={0} ...>` inside an `<svg>`.

The cause is in node_modules/preact/src/diff/props.js (Preact 10.29.8), function setProperty:
- For the SVG namespace, Preact only rewrites xlinkHref and className. It skips the property path and calls `dom.setAttribute('tabIndex', 0)`.
- The DOM lowercases attribute names only for HTML-namespace elements. On an SVG element the name keeps its case, so Preact creates an attribute literally named "tabIndex".
- The browser does not treat that as the `tabindex` attribute, so the element's tabIndex property stays -1. The nodes are skipped by Tab, cannot be focused with focus(), and so their onKeyDown (Enter/Space -> setSelected) can never fire.

The same JSX works on HTML elements. For example, the `<div class="memory-graph" tabIndex={0}>` on line 84 gets lowercased.

The comment on lines 82-83 ("axe doesn't count the SVG node buttons as focusable content") was a symptom of this same bug. axe did not count the nodes because they really are not focusable.

The e2e test test/e2e/memory-conflict.e2e.ts:156-160 only clicks a node with the mou …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/memory-analysis.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/memory-conflict.e2e.ts`

**Suggested fix:** In ui/memory-analysis.tsx:88, change the node's `tabIndex={0}` to lowercase `tabindex={0}`. Preact's JSX types already allow `tabindex` (node_modules/preact/src/jsx.d.ts:1533/1629). Preact then writes the real `tabindex` attribute on the SVG `<g>`, and the existing onKeyDown handler and the `.mem-node:focus-visible` style (styles.css:2448) start working with no other changes.

Optional cleanups:
- Reword the comment on lines 82-83. Keep the focusable scroller for keyboard scrolling, but the comment should not claim the nodes can't be focused.
- Consider a roving tabindex: one node at tabindex 0 and arrow keys to move between nodes. Up to 60 nodes would otherwise mean 60 tab stops. This is a nicety, not required to fix the bug.

**Suggested regression test:** Extend the test in test/e2e/memory-conflict.e2e.ts that opens "Source and derived-entry graph" (around lines 156-160). Instead of only `.click()` on the "Setup database safely, revision N" button, also check keyboard use:
1. Assert `await node.evaluate(el => el.tabIndex) === 0`.
2. Focus the `.memory-graph` scroller, press Tab, and assert that document.activeElement is a `g.mem-node` (its aria-label matches one of the node buttons).
3. On the source node, call `node.focus()`, press Enter, and as …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (qa-server.sh start v4619 4619 fake). In the UI I created a project "v4619-mqtt" pointing at a scratch clone of MQTT-MCP, then added three entries through Project memory -> Add project knowledge: Alpha, Beta and Gamma guidance. Next I opened Advanced memory tools -> Source and derived-entry graph in headless Chrome (scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619/setup.mjs and graph.mjs, output in graph.log in the same folder).

What I saw on each g.mem-node:
- The attributes are [transform, role, tabIndex, aria-label, class].
- getAttribute('tabIndex') returns '0', but getAttribute('tabindex') returns null and hasAttribute('tabindex') is false.
- The element's tabIndex property is -1.
- The outerHTML shows a literal camelCase `tabIndex="0"`.
- The scroller div gets a proper lowercase `tabindex` (its tabIndex property is 0).

Keyboard results:
- Tab from the .memory-graph scroller goes to SUMMARY "Read source references as a list", then the other summaries. It never reaches any of the 3 nodes.
- Shift+Tab from that summary returns to the scroller.
- Calling node.focus() leaves document.activeElement on the scroller div.
- Pressing Enter or Space after that leaves the role=status line empty. The graph details stayed open, so in my run Enter did nothing. It did not toggle the details. That is a small difference from the report, and the core claim holds.
- The aria snapshot still lists the 3 nodes as buttons, so screen readers announce them as buttons that can't be reached by keyboard.

Control: I set a lowercase tabindex="0" on the nodes in the page. After that each node's tabIndex property is 0, and Tab goes scroller -> Gamma -> Beta -> Alpha -> summary. Enter on Beta shows "Beta guidance · revision 1. 0 source references; 0 derived references." and Space on Alpha shows the Alpha status line. So the attribute case is the only fault; the existing onKeyDown handler works.

The browser profile, selectors and credentials are not involved. The same result came from a fresh server and data I created through the UI. I found nothing saying this is by design: docs/application-improvements.md item 39 only lists the feature, and styles.css:2448 defines `.mem-node:focus-visible`, so the nodes were meant to take focus.

Console errors and 5xx responses: none.

</details>

### t25-6 · minor · j/k run navigation bounces: opening an unseen finished run moves it out of 'Needs you' under the cursor

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-05.

**Repro**

> 1. On a fresh fake server, create 2-3 solo runs via the API, let them finish and don't open them, so they show under 'Needs you'.
> 2. Open an older, already-seen run.
> 3. Application menu > View and filter runs > Group by Status.
> 4. Focus main and press k six times, noting the URL after each press.

**Expected:** k walks steadily up the visible list one run at a time and reaches the top.

**Actual:** Each unseen run moves from 'Needs you' into 'Recent' as soon as it is opened, so the next k starts from its new position. Trace: af0759e5 → fbf63a99 → 531cc6c0 (Team) → 5dd91c92 → 531cc6c0 (Team again) → 875141cc. Runs are revisited, and the list reorders under the keyboard cursor. The same reordering happens in Project grouping, which also has a 'Needs you' section.

**Root cause (verifier):** ui/app.tsx:448-456 (case "j"/"k") recomputes the target from the live DOM on every key press: items = document.querySelectorAll(".rail .run-item"), at = index of .active, next = items[at ± 1], next.click(). Clicking opens the run.

ui/run.tsx:117 (and ui/side-chat.tsx:418) then calls markSeen() for a finished, unseen run. That flips run.seen, so needsYou() (src/run-status.ts:33, `run.status !== "running" && (... || !run.seen)`) returns false.

ui/rail.tsx then moves the row:
- rail.tsx:165 `waiting = list.filter(taskNeedsYou)`
- Status grouping, rail.tsx:318-322: the row goes from the "Needs you" section to "Recent".
- Project grouping, rail.tsx:366 (`if (!taskNeedsYou(r)) groupOf(r).runs.push(r)`) and 382-387: the row goes from the top "Needs you" section into its project group.

Both target lists are sorted by updatedAt (src/chat-family.ts:7,27), and marking a run seen doesn't change that. So the opened row lands at its date position below the remaining unseen rows. The next j/k press measures ±1 from that new index. Going down, the rest of "Needs you" is skipped, or j sticks on the last item. Going up, already-visited rows get revisited.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Recommended: keep section membership stable while the user is stepping through runs (the way mail clients leave a just-read message in place until you leave the view).

In ui/rail.tsx:
- Keep a small set in module state or a signal in ui/state.ts, e.g. `heldInNeedsYou: Set<taskId>`.
- When the current run (`currentTask`) becomes a task that taskNeedsYou() is true for, add it to the set.
- Compute the section list as `list.filter(r => taskNeedsYou(r) || heldInNeedsYou.has(chatTaskId(r)))`, used for both the Status sections and the Project-grouping exclusion at line 366.
- The "Needs you" count badge, waitingCount and the tab title keep using taskNeedsYou only, so the count still drops.
- A held row can render without the `unseen` style.
- Clear the set when the route leaves run/review, or when grouping, filter or search changes.
- With every visited unseen row held, j walks H → G → F → … and k walks up steadily, as expected.

Note that holding only the currently open run is not enough.  …

**Suggested regression test:** Add to test/e2e/ui.e2e.ts a test such as "j/k step through Needs you without skipping or revisiting":
- Via POST /api/runs (fake claude), create 3 solo runs one after another and wait until each is not running.
- Leave them unseen. Mark one older run seen via POST /api/runs/:id/seen.
- For each grouping (Status, then Project), open #/ (no run open), focus #main-content, and press j once per run.
- After each press, wait for the URL hash to change and record the run id.
- Assert the recorded ids  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4677 on 127.0.0.1:4677. I moved the old v4677 home aside, so it started with 0 runs. Repo was my own scratch clone of MQTT-MCP. Using POST /api/runs, I created solo fake-claude runs A..E one at a time, each finishing before the next started, so the end times are strictly ordered. All finished as "done", seen=false. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/nav.mjs. It switches grouping via Application menu > View and filter runs, focuses #main-content, presses keys, and after each press logs location.hash and the rail order (section + active marker).

1) Status grouping, start at #/ (no run open), j j j j k k k k, 700 ms apart (s2-status.log):
- Rail before: Needs you [E D C B A].
- j opens E, and E moves into Recent below the remaining unseen runs: rail = D C B A(Needs) *E(Recent).
- The next three j presses stay on E, because it is now the last item.
- k presses go A, E, B, E.
- TRAIL: #/ → E → E → E → E → A → E → B → E. j gets stuck, k revisits E twice, and D and C are never reached.

2) Project grouping, start on already-seen run B, k ×6 (s1-project.log):
- Rail before: Needs you [D C], Project [E *B A].
- TRAIL: B → E → C → E → D → E → E. E is revisited 3 times; C and D each jump from Needs you into the project group under the cursor.

3) Three more unseen runs F, G, H, Status grouping, j ×6 at a fast 150 ms (fast-status.log):
- TRAIL: #/ → H → E → D → C → B → A. j skips the unseen runs G and F entirely.
- So this is not a timing artifact of the reporter's 700 ms waits.

No console errors or 5xx responses. The screenshot shows E active under "Recent" while D and C are still listed above it under "Needs you".

Refutation checks:
- docs/runs.md:125 says unseen finished runs are listed in "Needs you", and test/e2e/ui.e2e.ts:1398 acknowledges that opening one moves its row out. The reorder itself is intended.
- docs/runs.md:138 only says "j/k move between runs". Nothing documents or tests j/k across that reorder, and no e2e test presses j/k.
- Not environmental: plain fresh profile, no team runs needed, deterministic in both groupings.

Cleanup: all 8 runs deleted through the UI (Select runs > Delete 8 runs). Server stopped. Scratch clone (and the worktrees/branches the delete dialog keeps by design) removed.

</details>

### t25-7 · minor · '[ / ]' (previous/next step) silently does nothing on solo runs, the default run type

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-06.

**Repro**

> 1. On a fresh fake server, start a solo run from the composer and let it finish.
> 2. On #/run/<id>, focus main and press '[' or ']'.

**Expected:** The shortcut works ('Show work' steps) or is clearly scoped, e.g. the dialog says 'team/workflow runs only'.

**Actual:** Nothing happens: no .tl-step elements exist, main text is unchanged, and there is no feedback. The shortcuts dialog says '[ / ] Previous / next step of the open run'. It works on team runs (Plan ↔ Alpha steps).

**Root cause (verifier):** The reporter's suspected cause is wrong; the symptom is real.
- **Handler not empty:** in ui/run.tsx:174-175, `listed.current = teamSteps(...)` is set on every run. For a solo run it holds the agent turns, e.g. ["s1"], so it is not empty. The keydown handler at ui/run.tsx:129-145 therefore gets past the `if (!ids.length) return` at line 134. It calls `e.preventDefault()` (the probe confirmed defaultPrevented=true), sets `follow.current=false` and `setWorkOpen(true)`, and changes `selected`.
- **Chat view ignores that state:** ui/run.tsx:196 sets `chat = !!p?.chat && !run.checkpointOnFinish`, and solo has `chat: true` (src/patterns/solo.ts:18). For chat runs, the render at ui/run.tsx:~338-340 shows `<ChatThread>` instead of the `details.work` timeline with `.tl-step` rows. ChatThread (ui/run.tsx:783) and TurnBody (ui/run.tsx:737) never get `selected` or `workOpen`; each turn has its own local "Show work" state.
- **Result:** the key is consumed, hidden state changes, and nothing appears on screen.
- **Unscoped docs:** the text comes from ui/app.tsx:390 `["[ / ]", "Previous / next step of the open run"]` and docs/runs.md:138, neither of which limits it to timeline runs.
- **Who is af …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** Preferred: make [ / ] step through agent turns in the chat view.
1. Keep `chat` in a ref so the keydown effect can read it.
2. In chat mode, set `listed.current` to the ChatThread turn ids, i.e. the agent turns that are not side steps. Give each turn's `.fu` wrapper a `data-step` attribute.
3. On [ / ], scroll the target turn into view (block: "nearest") and move focus to its "Show work" button, so the change is visible and announced. Do not call setWorkOpen or setSelected in chat mode.
4. If you don't want that behavior, at minimum return early without preventDefault when `chat` is true (stop swallowing the key and changing hidden state), and rescope the wording. In ui/app.tsx:390 use e.g. "Previous / next step (team and workflow runs)" or "Previous / next step or agent turn", and update docs/runs.md:138 to match.

**Suggested regression test:** Add a test to the browser e2e suite under test/e2e (the run-view/keyboard spec that covers j/k and \). Use fake agents.
1. Start a solo run from the composer (the default) and send one follow-up so the run has two agent turns.
2. Open #/run/<id>, focus #main-content and press [. Assert that the earlier turn's .fu is in the viewport and its "Show work" button is document.activeElement. Press ] and assert focus returns to the last turn.
3. Run the existing auto-team check: [ moves .tl-step.selecte …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4679-t257 on port 4679, with a new home and a new browser profile. I added a scratch clone of MQTT-MCP through "Open another repository". The composer's default mode is solo ("AI team Off"). I sent "Add a short note to the README about running tests" from the composer. Run 2610252304-5bc5e600 (pattern solo) reached status done.
- **Solo run:** on #/run/<id> I focused #main-content and pressed [, [, ], ]. There were 0 .tl-step elements, no details.work and no selection. The text and HTML of main were the same before and after the keys, and a control with no key press also showed no change. The page had no console errors.
- **Hidden handler:** I added a keydown listener on window after the view mounted. It saw defaultPrevented=true for every [ and ] press. So the run view's handler did run and swallowed the key, but nothing visible happened.
- **Shortcuts dialog:** the ? dialog still says "[ / ]  Previous / next step of the open run". docs/runs.md:138 also says, unscoped, "In a run, [/] move between steps."
- **"AI team On" run:** this run (2610252305-b148a26c) is also pattern solo with the chat view, and it behaves the same way (0 .tl-step, no effect).
- **Timeline run (contrast):** I created an auto-team run through the API and approved its plan in the UI. The shortcut works there: Review, then [ selects "Alpha implementation", [ selects "Plan", ] selects "Alpha".
- **Why this is not the tester's setup:** a fresh profile and server show the same thing, and the selectors are correct. It is not by design: nothing in the docs or code comments limits the shortcut to team or workflow runs.

Cleanup: I deleted all 4 runs through the bulk "Delete…" action in the run list (rail), stopped the server, and removed the scratch clones (bare and working copy). The only leftover is the browser profile at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/profiles/v4679-t257 and the QA home. Bulk delete did not remove the runs' .worktrees or codeflow/* branches in the clone; this may be by design, and it did not matter because the clone was removed. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679-t257 (r1-r6.mjs and .log).

</details>

### S05-4 · cosmetic · The [ / ] step shortcut is registered on Agent (chat) runs too, where no timeline is rendered; it calls preventDefault and changes hidden selection state without visible effect, despite being advertised in the shortcuts dialog.

Source: code-level suspect at `ui/run.tsx:131` (confirmed hands-on).

**Repro**

> Fake-mode s05: on a finished Agent (solo) run with steps, I blurred focus and pressed [, [, ]. A later window keydown listener saw defaultPrevented=true for all three keys. .runview innerHTML was byte-identical before and after. There are no .steps or .tl-step elements. The '?' dialog still advertises the shortcut. Control: on a Fix & review run, the same keys opened the Work section and moved the selection (Proof… → Check), so the shortcut only fails in chat runs.

**Expected:** In an Agent chat, [ and ] either do something visible, such as step through turns or tool events, or are not handled, with the shortcuts dialog saying they apply to team runs only.

**Actual:** The keys are swallowed silently in Agent chats, with no feedback.

**Root cause (verifier):** RunView registers the window keydown handler for [ and ] for every run. listed.current is filled from teamSteps(...) even when `chat` is true. In chat mode the `.steps` timeline is not rendered, and ChatThread does not use `selected`/`workOpen`. So the handler calls preventDefault and updates selected, follow.current and workOpen, with no visible result. The shortcuts dialog (ui/app.tsx:390) lists '[ / ] Previous / next step of the open run' globally.

**Suggested fix:** In the onKey handler, return early when the run is a chat. Keep a ref like chatRef.current = chat and check it before preventDefault, or skip filling listed.current when chat is true. Reword the shortcuts entry to 'Previous / next step of a team run'.

**Suggested regression test:** E2E: open an Agent run, press ']' and assert that the event's defaultPrevented is false (or that nothing changes). Open a Fix & review run and assert that ']' selects a .tl-step.

### t25-8 · minor · On phones, <select> controls stay 12-14px, so iOS zooms in when they take focus

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-08.

**Repro**

> 1. On a fresh fake server, open a mobile context (390x844, isMobile, hasTouch; matchMedia('(pointer: coarse)') is true).
> 2. Read computed font-size of the visible inputs, textareas and selects on the composer, on a team run awaiting approval, and on #/settings/runs.

**Expected:** Every form control a phone user can focus is at least 16px (the app's own rule says the browser zooms otherwise).

**Actual:** Inputs and textareas are 16px. Selects are not: Run priority 13px, 'Who gets this' 12.5px, Workflow, Agent execution and verification-profile 14px, Default workflow 12px, settings-trust 14px. iOS Safari zooms the page on focus and stays zoomed.

**Root cause (verifier):** The phone zoom guard at ui/styles.css:1756-1759 covers only typing fields:

  /* A phone's browser zooms into a field set under 16px when it takes focus (and stays zoomed): typing fields are 16px there */
  @media (max-width: 760px) and (pointer: coarse) {
    input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"]), textarea { font-size: 16px !important; }
  }

It leaves out `select`. Every select therefore keeps its desktop size from these rules:
- `.live-progress-controls .field` 13px (styles.css:3473): Run priority
- `.to select` 12.5px (styles.css:925): Who gets this
- `.settings-row-control select` 12px (styles.css:2761): Default workflow
- `.advanced-controls [aria-label="Agent execution location"] select` 14px (styles.css:2162)
- the 14px base for `.field` selects: Workflow, Saved templates, Verification gates, Agent permissions
- also, not measured here, `.mpick select` 12px (1514), `.dependency-edit select.field` 12.5px (2307), `.ship-panel select.field` and `.side-toolbar select.field` 13px (1344/468)

On iOS Safari, focusing any of them zooms the page.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/styles.css:1758, add `select` to the coarse-pointer rule:
`input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"]), textarea, select { font-size: 16px !important; }`
Also change the comment to say "form fields" instead of "typing fields", so the guard does not get narrowed again later.

Then check at 390px that the compact selects still fit:
- `.to select` (height 28px) in the reply bar
- `.mpick select` (30px)
- `.live-progress-controls`
- `.settings-row-control select` (max-width:100%)

16px text fits these heights with line-height ~20px. If anything wraps or gets cut off, raise its height or min-height inside the same media query. Do not drop the font size.

Do not use maximum-scale=1 in the viewport meta instead: it would also block pinch zoom, which hurts accessibility.

**Suggested regression test:** Add the check to test/e2e/ui.e2e.ts in the existing phone context (line ~437: viewport 390x844, isMobile, hasTouch), after the phone lands on "What would you like to work on?":
1. Tap "Edit run options" and open the Advanced summary.
2. Collect every rendered `input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file]), textarea, select`.
3. Assert parseFloat(getComputedStyle(el).fontSize) >= 16 for each, with the aria-label in the failure message.
4. Repeat on #/settings/runs. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake QA server v4681 on 127.0.0.1:4681, then again with FAKE_SLEEP_MS=150000 exported so a run stays in "running". I used my own Playwright scripts with a fresh, non-persistent context (viewport 390x844, isMobile, hasTouch), not the reporter's lib.mjs. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681/sel.mjs and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681/team.mjs. matchMedia('(pointer: coarse)') and '(max-width: 760px)' were both true.

Computed font-size of each rendered input, textarea and select:
(1) Composer (#/) with Run options and Advanced open: every textarea and text/number input was 16px. Selects: Workflow 14px, Saved templates 14px, Agent execution 14px, Verification gates 14px.
(2) #/settings/runs: Search settings and the number inputs were 16px. Selects: Default workflow 12px, Agent permissions 14px.
(3) In the UI I picked MQTT-MCP, opened Edit run options > Advanced, set Workflow to "Plan -> Build -> Review" and started the run. On the running run page, the "Message the team" textarea was 16px. Selects: Run priority 13px, Who gets this 12.5px. Focusing each one programmatically gave the same sizes. The screenshot shows both selects on screen: "Priority Normal" in the Work in progress card and "To Next agent" in the reply bar (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681-team-3-run.png). No console or page errors.

ui/index.html:5 sets the viewport meta to "width=device-width, initial-scale=1" with no maximum-scale, so nothing else stops iOS from zooming on focus.

Limits: I could not run real iOS Safari, so I did not watch the zoom happen. What I reproduced is the condition that triggers it: a focusable <select> computed below 16px on a coarse-pointer phone. iOS WebKit zooms on focus for select as well as input and textarea in that case.

Trying to refute it: no doc says selects are meant to be excluded (I checked docs/accessibility.md and the other docs). The CSS comment's stated purpose, "A phone's browser zooms into a field set under 16px when it takes focus (and stays zoomed)", applies to <select> just as much. The rule's wording "typing fields" reads as an oversight from PR 26 (commit 0a5c35c), not a design choice. The tester's environment did not cause this: I got th …

</details>

### t26-5 · minor · prefers-reduced-motion does not stop the app's JS smooth scrolling

Source: tester unit usability-failure-cases-2; observed with fake-agents; features USAB-GAP-01.

**Repro**

> 1. Emulate prefers-reduced-motion: reduce (DevTools/Playwright emulateMedia).
> 2. Use any control that calls scrollIntoView({behavior:'smooth'}): the run next-action buttons ('Review plan', 'Answer question', 'Review result'), team map 'Inspect assignment' or 'Answer this question', project briefing 'Review proposal', memory-analysis links.
> 3. Measured in the run view: element.scrollIntoView({block:'center', behavior:'smooth'}) inside .run-task, with scrollTop sampled per frame.

**Expected:** As docs/accessibility.md:9 states, reduced-motion preferences disable smooth scrolling and the jump is instant.

**Actual:** scrollTop animates over about 10 frames (3, 13, 41, 102, 159, 193…) with matchMedia reduce true. CSS animations do stop correctly.

**Root cause (verifier):** ui/styles.css:87-89 handles reduced motion only in CSS. Inside `@media (prefers-reduced-motion: reduce)` it sets `scroll-behavior: auto !important`. Nothing in ui/styles.css ever sets `scroll-behavior: smooth`, so that rule changes nothing. All of the app's smooth scrolling comes from JavaScript calls that pass `behavior: "smooth"` explicitly. Under CSSOM View, an explicit behavior wins over the CSS scroll-behavior property, so these scrolls animate whatever the media query says.

The unguarded call sites:
- ui/run.tsx:205 `section?.scrollIntoView({ block: "center", behavior: "smooth" })` in focusSection. This is used by the next-action buttons Review plan, Answer question and Review result (act() at ui/run.tsx:227).
- ui/team.tsx:299, twice: "Inspect assignment" and "Answer this question".
- ui/project-teams.tsx:192: "Review proposal".
- ui/memory-analysis.tsx:114: memory links.
- ui/ml/workspace.tsx:48: `detail?.scrollIntoView({ block: "start", behavior: "smooth" })` in selectJob. The reporter missed this one.

No code anywhere calls matchMedia('(prefers-reduced-motion: reduce)'), so the promise in docs/accessibility.md:9 is not kept for any of these controls.

Severity stays min …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/memory-analysis.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ml/workspace.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/accessibility.e2e.ts`

**Suggested fix:** Add one shared helper to ui/lib.ts (or ui/preferences.ts):

`export const scrollBehavior = (): ScrollBehavior => matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";`

Optionally also add `export function revealElement(el, block = "center") { el?.scrollIntoView({ block, behavior: scrollBehavior() }); }`.

Then replace the hard-coded `behavior: "smooth"` at all six call sites with `behavior: scrollBehavior()`, or with revealElement:
- ui/run.tsx:205
- ui/team.tsx:299 (two calls)
- ui/project-teams.tsx:192
- ui/memory-analysis.tsx:114
- ui/ml/workspace.tsx:48

Check matchMedia at the moment of each call rather than caching it, so a preference change while the page is open takes effect without a reload.

Keep the CSS rule at ui/styles.css:88 as a backstop for any CSS smooth scrolling added later. Optionally add a lint or grep check that fails on any new literal `behavior: "smooth"` in ui/.

No documentation change is needed: once the code honours the preference, doc …

**Suggested regression test:** Add a test to test/e2e/accessibility.e2e.ts, or to test/e2e/ui.e2e.ts next to "approve the plan from the UI".

1. Start a pipeline run with "Let me approve the plan" checked.
2. Call `page.emulateMedia({ reducedMotion: "reduce" })` and set the viewport to 1280x520.
3. Set `.run-scroll` scrollTop to 0, install a requestAnimationFrame sampler, and click the "Review plan" button.
4. Assert that no sampled scrollTop falls strictly between 0 and the final value; the first non-zero sample must equal t …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4645m on port 4645, with a new home. I added a scratch clone of MQTT-MCP through "Open another repository". In the composer I chose Workflow=pipeline, checked "Let me approve the plan" and started a run (2610252327-07d4083c). It reached awaiting={kind:'plan'}, and the next-action card showed the "Review plan" button.

The script is measure.mjs in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645m. For each trial it opens a fresh headless Chrome context at 1280x520, sets .run-scroll scrollTop to 0, records .run-scroll scrollTop on every requestAnimationFrame, and clicks the real "Review plan" button. The tester called scrollIntoView on paragraphs in .run-task from a script; I clicked the app's own button instead.

Results:
- no-preference: matchMedia reduce=false, scrollTop 0,3,13,40,101,160,196,220,237…281, with 15 in-between frames over about 250 ms.
- reducedMotion 'reduce' (context option, the same thing as emulateMedia): matchMedia reduce=true, computed scroll-behavior 'auto', and exactly the same curve: 3,13,40,101,160,196,220…281, 15 in-between frames over about 250 ms.

The preference changes nothing for this control. The issue is not caused by the tester's setup: the button is real, the page saw the reduce media query, and the profile was fresh.

Control check (fixcheck.mjs, under reduce, same #run-approval target):
- behavior 'smooth' gives 3,13,40,101,160,196 (animated).
- behavior chosen as matchMedia(reduce) ? 'auto' : 'smooth' gives 281 on the first frame (instant).
- behavior 'instant' gives 281 on the first frame.

So the proposed fix works. I also tried launching Chrome with --force-prefers-reduced-motion as a stand-in for the OS setting, but matchMedia stayed false, so that tells us nothing about an OS-level reduce. I did not change the OS setting.

I found nothing saying this is intended. docs/accessibility.md:9 says "Reduced-motion preferences disable sustained animation and smooth scrolling", and no code comment explains the explicit smooth calls.

Cleanup: I stopped and deleted the run through the UI (Stop run, then More run actions > Delete…; GET now returns 404), stopped server v4645m, and removed my scratch clones v4645m-mqtt and v4645m-mqtt.git. One leftover: QA home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4645m. It has no runs.

</details>

### t25-16 · minor · Phone landscape: the run view leaves only about 84px (22% of the screen) for the conversation

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-08.

**Repro**

> 1. On a fresh fake server, open a mobile context at 844x390 (isMobile, hasTouch).
> 2. Open any finished run.

**Expected:** On short screens the run header, title and agent tab strip shrink or scroll away, so the transcript stays usable.

**Actual:** Top bar 0-48, agent tab strip 56-86, run head 95-173 (large serif title), chatbox 257-374. The transcript only gets y 173-257 (84px). The rail is visible because the width is over 760px, and it shows no runs until you scroll it.

**Root cause (verifier):** The vertical space in the run view is only adapted by width, never by height.

- ui/styles.css:641: `.run-head { position: sticky; top: 0; padding: 4px 28px 14px }` with a 26px Georgia h2 (:648). This uses 78px of the .run-scroll viewport and never scrolls away.
- ui/styles.css:1665-1676: the only rule that makes the head static (`.run-head { position: static }`, smaller title, `.run-scroll { scroll-padding-top: 0 }`) sits inside `@media (max-width: 760px)`. A phone in landscape (844 or 932px wide) never matches it.
- ui/run.tsx:231: `{chat ? <AgentTabs run={run} /> : null}` puts the agent strip outside .run-scroll, so another 47px is fixed above the thread. The 48px topbar is also fixed.
- ui/styles.css:899 and :903: `.convo { flex: none; padding: 20px 28px 16px; margin-top: -20px }` and `.chatbox textarea { max-height: 220px }`. The docked composer keeps its full size (about 133px empty, up to about 237px), so it squeezes .run-scroll and can leave it no taller than the sticky head.
- ui/styles.css:242-246: the only `@media (max-height: 600px)` block, which only makes the rail scroll. Its sticky .rail-foot also covers the first run row at 390px.

At 390px tall: 48 (topbar) + 47 (s …

**Files:** `ui/styles.css`, `ui/run.tsx`, `test/e2e/ui.e2e.ts`

**Suggested fix:** Add a short-viewport block to ui/styles.css, for example `@media (max-height: 560px)`, or reuse the rail's 600px threshold. In it:

1. Make the run head scroll away: `.run-scroll { scroll-padding-top: 0 } .run-head { position: static; animation: none; border-bottom: 0; padding: 4px 28px 8px } .run-title h2 { font-size: 20px }`. The simplest version is to extend the existing rule to `@media (max-width: 760px), (max-height: 560px)` for the run-head and scroll-padding lines only, leaving the wrapping and title-clamp lines width-only.
2. Cap the composer on short screens: `.chatbox textarea { max-height: 25dvh }`, a smaller `.convo` padding (8-12px), and hide the chatbox hint. This stops a multi-line draft from taking the whole thread.
3. Make the agent strip scroll with the thread or shrink it. Either render AgentTabs inside .run-scroll when the viewport is short (ui/run.tsx:231), or reduce `.runview > .sess-strip` padding and height under the same media query.
4. Optional: collapse the r …

**Suggested regression test:** Add a test to test/e2e/ui.e2e.ts, next to the other phone tests that create a finished chat run, for example after "chat menus apply model, effort and permissions...". Open the run in `browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true })` and assert:

(a) `getComputedStyle(document.querySelector('.run-head')).position !== 'sticky'`, or, after `.run-scroll.scrollTop = 200`, that `.run-head`'s bottom is at or above `.run-scroll`'s top.
(b) The visible threa …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake server: qa-server.sh start v4601 4601 fake (the home had no runs). In a desktop browser I added a scratch clone of MQTT-MCP with "Open another repository" and "Create project", then sent a task from the composer. The fake agent finished the run (id 2610252312-046f26b2, status done). I then opened that run in a fresh Playwright context with isMobile, hasTouch, deviceScaleFactor 2 and an iPhone user agent, and measured with getBoundingClientRect. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601/measure.mjs; output in measure.log in the same folder.

Results at 844x390:
- topbar 0-48, agent strip (.runview > .sess-strip) 48-95, .run-scroll 95-257 (clientHeight 162).
- .run-head is position:sticky at 95-173, the serif title is 26px, and it stays at 95-173 after scrolling the thread by 200px.
- .convo 237-390 and .chatbox 257-374.
- The transcript is visible only from 173 to 257 (84px). The bottom 20px of that sits under the convo's fade, so about 64px is clear.
- The rail is visible (width over 760px). Its first run row (331-365) is under the sticky rail footer, so no run shows until you scroll the rail.

Other sizes:
- 932x430: 104px for the transcript.
- 844x340 (a realistic Safari landscape height with toolbars): about 14px. The "Ready to review" card is barely visible.
- 1280x500 desktop: 204px.
- 740x390, below the 760px width breakpoint: the head is static and scrolls away, so the transcript gets 195px or more. This shows the narrow-width rule handles the problem and the short-height case is simply not covered.

Extra finding (grow.mjs): at 844x390, typing 5 lines into "Message agent" grows the chatbox to 173-374. .run-scroll shrinks to 95-173 (clientHeight 78), which is exactly the sticky head, so the transcript gets 0px while you write.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4601/m-844x390-top.png, m-844x390-scrolled.png, m-844x340-scrolled.png and m-844x390-typing.png in the same folder. No console errors.

Attempts to refute it:
- Not by design. The comment at ui/styles.css:241 names "short screens (phones in landscape, high zoom)", but only the rail is adapted. The run head is meant to "scroll away" only in the width rule at :1671.
- Not environmental. The numbers match the reporter's and do not depend on the selector, profile or fake agents.
- …

</details>

### t25-18 · cosmetic · The lazy-view error message has no padding and sits flush against the main column edge

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-11.

**Repro**

> 1. On a fresh fake server, block /assets/settings-*.js (Playwright route abort).
> 2. Open #/settings/general.

**Expected:** The error is laid out like other page content, with padding.

**Actual:** 'This view could not load. [Reload app]' is drawn at x=248, touching the rail border, with no page padding.

**Root cause (verifier):** ui/lazy-view.tsx:8: `LoadBoundary.render()` returns a bare `<div role="alert" class="msg err">`. ui/lazy-view.tsx:13 does the same with the Suspense fallback, a bare `<div role="status" class="help">Loading view…</div>`. Neither has a page wrapper.

ui/app.tsx:153-154 renders `<SettingsView/>` (built with lazyView) directly inside `<main id="main-content">`. main has no padding (ui/styles.css:276: `main { flex: 1; min-height: 0; overflow-y: auto; min-width: 0; }`), because each page brings its own: `.settings-page` (styles.css:2726, `padding: 36px 40px 64px`) and `.composer` (styles.css:280, `padding: 16px 40px 64px`). `.msg` (styles.css:324) only sets font-size and margin-top: 8px.

When the chunk import fails, the page wrapper never renders, so the message sits flush against main's left edge: the rail border on desktop, the viewport edge on a phone.

The same boundary is reused elsewhere: side panel tabs in ui/side.tsx:3-5,35, whose `.side-body` at styles.css:444 also has no padding, plus project.tsx, workbench.tsx, team-terminals.tsx and others. The flush layout likely shows up in those contexts too. I only reproduced the main-column case.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lazy-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** Give both lazy-view states their own class and lay them out like page content.

1. In ui/lazy-view.tsx, render `<div role="alert" class="lazy-state msg err">` and `<div role="status" class="lazy-state help">`.
2. In ui/styles.css, add `main > .lazy-state { max-width: 900px; margin: 0 auto; padding: 16px 40px; }`. This matches `.composer`'s padding and centring, and also drops the stray 8px margin-top.
3. Add a phone override in the existing narrow media block, the one that sets `.composer { padding: 16px 16px 48px }`: `main > .lazy-state { padding: 16px; }`.
4. Optionally add `.side-body > .lazy-state { padding: 12px 16px; }` so side panel tabs get the same treatment.

Scoping the rule with child selectors keeps embedded uses from getting doubled padding (for example the Team server wizard inside the already padded settings content).

Optional polish: style the alert as a small card with a heading, like `.boot-error` at styles.css:1729.

**Suggested regression test:** Add a test to test/e2e/settings.e2e.ts named "a settings chunk that fails to load shows a padded, recoverable error". Steps:
1. Call `page.route(/\/assets\/settings-[^/]*\.js/, r => r.abort())` before loading the app.
2. Navigate to #/settings/general.
3. Assert `getByRole('alert')` contains "This view could not load" and a "Reload app" button.
4. Assert the alert's boundingBox().x minus `#main-content`'s boundingBox().x is at least 16, at both 1440 px and 390 px widths. Optionally, at 1440 px,  …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode QA server: `qa-server.sh start v4605 4605 fake`, serving the dogfood build whose settings chunk is public/assets/settings-V36USTHR.js. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605/t25-18.mjs. It uses a fresh browser profile with no saved state and does three things:
1. Opens #/settings/general normally as a baseline. The page header starts at x=288 at 1440 px wide and at x=16 at 390 px wide, so the page padding is 40 px on desktop and 16 px on a phone.
2. Adds the Playwright route `/\/assets\/settings-[^/]*\.js/` set to abort, then reloads the app.
3. Sets location.hash to #/settings/general and waits for `[role=alert].msg.err`.

At 1440x900 the alert reads "This view could not load. [Reload app]". It is a direct child of MAIN#main-content at x=248, which is exactly main's left edge (the rail's right edge is also 248). Its computed padding is 0px and its margin is 8px 0 0. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605/002-w1440-lazy-error.png. The red text touches the rail border, while the topbar content above it is indented to x=272.

At 390x900 (phone) the alert sits at x=0, flush against the viewport edge. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605/002-w390-lazy-error.png.

The only console error is the expected net::ERR_FAILED for the aborted chunk.

I also tried to refute the report:
- Nothing in docs/, the code comments or the e2e tests mentions or intends this layout.
- A fresh browser profile does not change the result.
- Blocking the chunk only simulates a real failure mode: a stale chunk hash after an upgrade, or going offline.

So the bug is real, but it only appears in the rare error state.

</details>
