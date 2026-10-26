# Cluster 51 · memory-ml-stats

**Project memory analysis, ML training workspace and workflow stats**

Status: **fixed and verified in isolation** · 10 issues · branch `codex/qa-memory-ml-stats`

Planner notes: Memory: 'Why project memory was selected' lists one entry as both Included and Omitted, by raw id, because two turns' verdicts are merged (t23-12; src/engine.ts, src/memory.ts, ui/team.tsx). The curated onboarding summary includes both sides of flagged contradictions and exact duplicates (t23-13, src/memory-analysis.ts:171-184). Message polish: run-on errors and plurals in ui/memory.tsx, filesystem-policy and conventions (t23-15). t24-6: floating-point residue in the Wilson lower bound ranks 0/3 above 0/4 (src/stats.ts:229); clamp when p=0. ML: running from source without the training-worker bundle gives a raw 500 ENOENT (t24-8; src/ml/transport.ts, scripts/dev.mjs); Check computer doesn't check the Python version (t24-9); the planner misreads the unlabeled 'iteration' field (t24-10, src/ml/planner.ts); a paused search with no iterations left offers Resume and then reports the wrong reason (t24-11, src/ml/cycles.ts:158); an interrupted SSH dataset copy restarts at byte 0 (t24-12, src/ml/service.ts:162). t24-17 is docs only: they say removing CODEFLOW_ML_ENABLED blocks deployments, but the saved Settings choice wins.

Likely files: `src/memory.ts`, `src/memory-analysis.ts`, `ui/memory-analysis.tsx`, `ui/memory.tsx`, `ui/team.tsx`, `src/stats.ts`, `src/ml/transport.ts`, `src/ml/planner.ts`, `src/ml/cycles.ts`, `src/ml/service.ts`

## Issues

### t23-12 · minor · 'Why project memory was selected' lists the same entry as both Included and Omitted, by raw id

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-02, PLAT-07.

**Repro**

> 1. Auto-team run on a repo with a path-scoped accepted memory (e.g. paths: mqtt-python).
> 2. Run page → 'Why project memory was selected'.

**Expected:** One line per entry with its title, and context for which turn included or omitted it.

**Actual:** 'Included · m-74996864-… · revision 1 · matching task text' and 'Omitted · m-74996864-… · revision 1 · outside task paths' both appear. The planning and task selections are merged, and there are no titles.

**Root cause (verifier):** Two turns disagree, the merge keeps both verdicts, and the UI shows the merged lists flat.

- src/patterns/auto-team.ts:232 calls ctx.projectMemory(coordinator.id) for planning with no paths.
- src/memory.ts:353 (retrieve) marks any path-scoped entry "outside task paths" when query.paths is undefined.
- src/patterns/auto-team.ts:399 calls the worker turn with task.paths. With ["*"], src/memory.ts:359 includes the entry as "matching task text, tags or paths".
- src/engine.ts:1242 builds run.memoryManifest as `{ included: refs([...previous.included, ...manifest.included]), omitted: refs([...previous.omitted, ...selection.manifest.omitted]) }`. Each list is deduplicated by id@revision on its own. Nothing removes an omitted ref that another turn included, and nothing records which member or task produced each verdict. The live replay path at src/engine.ts:1269 (applyLiveMemoryManifest) has the same merge.
- ui/team.tsx:109-112 renders run.memoryManifest.included and .omitted as flat lists: `<b>Included</b> · {item.id} · revision {item.revision}` and `<b>Omitted</b> · {item.id} …`. There is no title lookup and no turn context. The keys `included-${item.id}` and `omitted-${item.id}` woul …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/memory.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-evaluation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/auto-team-memory.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-memory-replay.test.ts`

**Suggested fix:** 1. Engine (src/engine.ts:1242 and the replay twin at :1269). Factor out one merge helper used by both paths.
   - Keep the run-wide included union. Provenance, feedback validation and retention depend on it.
   - Drop from omitted any id@revision that is in included. "Included" at run level then means "some turn received it".
   - Optionally extend the run-level manifest type with per-ref turn context, e.g. `turns: { memberId?: string; taskId: string | "planning"; included: boolean; reason: string }[]`. The panel could then say "Included for builder · alpha; omitted from coordinator planning (outside task paths)". Keep journaling references only (no bodies), as docs/architecture.md:71 requires.
2. UI (ui/team.tsx:109-112).
   - Render one row per id@revision with key `${id}@${revision}`.
   - Show the entry title, resolved at render time from the project memory list the run page already loads (/api/projects/:id/memory?repo=…). Fall back to the id when the entry was deleted or memory is …

**Suggested regression test:** test/auto-team-memory.test.ts: seed an accepted project memory with paths ["src"]. Run the fake auto team so the planning turn has no paths and a worker task's paths cover src. Assert that run.memoryManifest.included has {id, revision}, and that `!run.memoryManifest.omitted.some(r => r.id === id && r.revision === revision)`. If turn context is added, also assert the included ref's turns contain the builder/alpha inclusion and a planning "outside task paths" omission. Add the same assertion to te …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4627t2312" on port 4627 (new, empty home). Scratch clone of MQTT-MCP at qa/clones/v4627t2312-mqtt (bare origin next to it).
1. Through the UI (Manage projects → New project), created project "v2312-mqtt" (p-0fcfebbc) on the clone.
2. Settings → Projects → Project memory → "Add project knowledge": title "MQTT tests run with uv", path "mqtt-python". Saved as accepted revision 1, id m-4b32fa57-fe6c-4e17-a7ec-5ca32982355a.
3. Started an Auto team run from the composer: task "Add a short note to the MQTT python test docs about running tests with uv", check node --test 'proof-*.test.mjs'. Run id 2610252322-f5b78a54.
4. Before approval, the manifest was {included: [], omitted: [{m-4b32…, rev 1, "outside task paths"}]}. The coordinator planning turn sends no paths, so the path-scoped entry is omitted.
5. Approved the plan in the UI. The run finished done/passed. The fake plan's only task (alpha) has paths ["*"].
6. The final run.memoryManifest held the same ref in both lists: included [{m-4b32… rev 1, "matching task text, tags or paths"}] and omitted [{m-4b32… rev 1, "outside task paths"}].
7. Run page → Team activity → "Why project memory was selected" shows two rows: "Included · m-4b32fa57-fe6c-4e17-a7ec-5ca32982355a · revision 1 / matching task text, tags or paths / Rate this knowledge" and "Omitted · m-4b32fa57-fe6c-4e17-a7ec-5ca32982355a · revision 1 / outside task paths". Neither row has a title or says which turn it refers to. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627t2312/001-why-panel.png. No console or 5xx errors.
8. For comparison, "Context used by each member" correctly shows only "builder · alpha … Memory: m-4b32…@1". The per-turn data exists, but the Why panel merges the turns.

Reproduced 1/1 on the first try. It is deterministic for any path-scoped accepted memory in an auto-team run. The reporter's second run shows the same pattern for several other ids, with omission reasons "entry budget" and "outside task paths".

Attempts to refute:
- docs/auto-team.md:67 says the panel "shows included and omitted entries with reasons, provenance, and branch applicability". Nothing documents one entry appearing as both, and the panel shows neither provenance nor applicability.
- The union of included refs across turns is intentional for provenance (engine.ts:1239-1241 comment; derivedFrom at engine.ts:1409; feedback check at server.ts: …

</details>

### t23-13 · minor · Curated onboarding summary includes both sides of flagged contradictions and exact duplicates

Source: tester unit infra-platform-memory-ml-insights-1; observed with code-reading; features PLAT-05.

**Repro**

> 1. Add 'Always permit guest requests' and 'Never allow guest requests', plus two entries with identical text.
> 2. Advanced memory tools shows '2 conflicts' and 'Same text' pairs.
> 3. Open Curated project onboarding → 'Save onboarding as project knowledge'.

**Expected:** Onboarding should flag or omit known contradictions and duplicates, or at least warn before publishing.

**Actual:** The summary lists both contradictory policies and both duplicates. Once saved as accepted guidance, it can be selected into later auto-team runs.

**Root cause (verifier):** src/memory-analysis.ts:171-184. The onboarding loop decides eligibility from status/acceptedBy (line 173), origins (174), stale (175), branch (176), incomplete freshness (177) and the onboarding-summary tag (178). It never reads `result.claims.findings` (computed on line 50 via analyzeMemoryClaims) or `result.duplicates` (computed on lines 155-166), so contradictory and exact-duplicate entries both pass into the body (line 183).

src/server.ts:2066-2070 publishes the recomputed `analysis.onboarding` without checking findings, and memoryStore.propose (src/memory.ts:183-188) marks a user-authority entry accepted immediately.

ui/memory-analysis.tsx:57-59 shows "Entries needing review … are excluded" with no warning about flagged pairs before the Save button.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/memory-analysis.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/memory-analysis.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/memory-analysis.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/memory-claims.md`

**Suggested fix:** In analyzeProjectMemory, before the onboarding loop (src/memory-analysis.ts:169), build two sets:

1. **Contradictions:** a set of ids from `result.claims.findings` where kind === "contradiction". Add an onboarding reason "Has an unresolved potential contradiction with <other title/id>; review it in Semantic claim review" and skip those entries. Skipping both sides keeps the rule that the analyzer never picks a winner.
2. **Exact duplicates:** a set from `result.duplicates` where kind === "exact". Keep the first entry in the existing deterministic order (title, then id) and omit the later copy with the reason "Same text as <kept id>".

Lexical-overlap pairs and "equivalent" claim pairs should stay advisory, or be listed as a note in the summary, because they can differ in context.

Also add a field such as `onboarding.flagged`, so the publish endpoint and UI can show a warning when the summary is empty because of conflicts. In ui/memory-analysis.tsx, make the help text match the new ru …

**Suggested regression test:** Add a test to test/memory-analysis.test.ts: "onboarding withholds both sides of a potential contradiction and the later exact duplicate". Call analyzeProjectMemory with accepted user entries: guestA "Always permit guest requests", guestB "Never allow guest requests", dupA and dupB with identical bodies, and a neutral "safe" entry. Assert:
- `onboarding.sourceRefs` deep-equals [dupA (the first by title/id), safe]
- `onboarding.body` does not match /Always permit guest requests/ or /Never allow gu …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4629 4629 fake`. I first moved an old v4629 home aside to `homes/v4629.prev-t2313`, so the server began with no memory DB and no runs. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t23-13.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t23-13.log.

All steps used the UI (Settings > Projects > MQTT-MCP > Project memory):
1. Clicked "Add project knowledge" four times and saved 'Guest policy A' = "Always permit guest requests", 'Guest policy B' = "Never allow guest requests", and 'Dup one' / 'Dup two' with the same text ("Use the broker fixture from conftest for every integration test in mqtt-python.").
2. Opened Advanced memory tools. It showed "Repeated wording · 1 pairs: Dup two and Dup one · Same text, ignoring whitespace" and "Semantic claim review · 1 conflicts · 1 equivalent pairs (Potential contradiction: allow · guest request, Guest policy B and Guest policy A … Review both source revisions)".
3. Opened Curated project onboarding. The summary listed all four entries, including both sides of the contradiction and both copies of the duplicate. It said "0 entries omitted" and `analysis.onboarding.reasons` was empty. The help text above it says "Entries needing review … are excluded". There was no warning near the button. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/001-onboarding-before-save.png
4. Clicked "Save onboarding as project knowledge". No confirmation appeared, only the toast "Onboarding guidance saved with its source revisions." The new entry (tag onboarding-summary) had status=accepted and acceptedBy=user, and its body contained "Always permit guest requests" and "Never allow guest requests", plus the duplicated line twice.
5. Re-ran the analysis after saving. Contradiction findings rose from 1 to 4. The saved summary was flagged as contradicting itself (one finding whose refs are only the summary) and as contradicting each guest-policy source. There were no console or 5xx errors.

src/memory.ts:545 `exclusion()` only filters on status, feedback, expiry and branch, so retrieve() (src/memory.ts:333, used by projectMemoryForRun in src/team-memory.ts:38) can select the accepted summary into later runs.

Refutation att …

</details>

### t23-15 · cosmetic · Message polish: run-on errors, raw ids, plural grammar

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-02, PLAT-04, PLAT-09, PLAT-11, PLAT-14.

**Repro**

> Memory edit conflict; policy or memory validation errors; conventions stale restore; memory summary; verification evidence.

**Expected:** Complete sentences, entry titles, correct plurals.

**Actual:** Examples: 'Memory revision conflict: m-ab87d656-… is at revision 2 Your draft is still here.'; 'Policy paths must be literal relative repository paths Your draft is kept.'; a stale restore shows 'Your draft was not saved'; 'Project memory · 1 entries'; '1 attempts'; the exported verification.md has empty code fences for gates with no output.

**Root cause (verifier):** The error text is built by gluing a sentence onto a server message that has no final period, and some UI labels have no plural handling.
- ui/memory.tsx:175 renders `{error} Your draft is still here.`. The error comes from src/memory.ts:127, `Memory revision conflict: ${current.id} is at revision ${current.revision}`, which has no trailing period and includes the raw `m-…` id. On a 409/404 the conflict section at ui/memory.tsx:165 already explains the conflict, so this alert is redundant as well.
- ui/filesystem-policy.tsx:18 renders `{error} Your draft is kept.`. The messages from src/filesystem-policy.ts:18, 20, 25 and 24 ("Policy paths must be literal relative repository paths", "Paths must stay inside the repository; … not allowed", "Use at most 100 literal paths per list", "Choose explicit allow and deny path lists") have no final period.
- The same pattern exists at ui/code-hosts.tsx:19, ui/retention.tsx:56, ui/repo-coordination.tsx:44 and ui/shared.tsx:45.
- src/conventions.ts:85: `expect()` always throws "Conventions changed to revision N. Your draft was not saved." It is shared by save, restore (line ~109) and publish. ui/conventions.tsx:35 then sets `conflicted` for "rest …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/memory.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/memory.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filesystem-policy.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/conventions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/conventions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/verification.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/code-hosts.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/retention.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/repo-coordination.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/shared.tsx`

**Suggested fix:** 1) Make the joined messages complete sentences. Add a small helper in ui/lib (for example `sentence(message)`) that trims the message and adds a period if it does not already end in . ! or ?. Use it everywhere the UI renders `{error} Your draft …`: memory.tsx:175, filesystem-policy.tsx:18, code-hosts.tsx:19, retention.tsx:56, repo-coordination.tsx:44, shared.tsx:45. Also end the server messages in src/filesystem-policy.ts and src/memory.ts with periods.
2) Memory conflict: change MemoryConflictError's text to something like `This knowledge entry changed in another session (now revision N).`, without the raw id. Better, hide the generic alert when the conflict section is shown, because that section already says this.
3) Conventions: give `expect()` an action argument. Save keeps "Your draft was not saved." Restore says "Conventions changed to revision N. Nothing was restored; preview the revision again." Publish gets a matching message. In ui/conventions.tsx:35, set `conflicted` only fo …

**Suggested regression test:** 1) test/verification.test.ts: run runVerification on a profile with one gate `test -f does-not-exist` (exit 1, no output). Assert that renderVerificationReport(report) does not match /```\n\n```/ and does contain "Exit 1" (or "No output").
2) Add a small unit test for the new `sentence()`/`plural()` helpers. Assert that sentence("Policy paths must be literal relative repository paths") ends with "paths." and that plural(1, "attempt", "attempts") === "1 attempt".
3) test/e2e/memory-conflict.e2e.t …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server "v4633t" on 127.0.0.1:4633 with a new home and no runs. I made a scratch clone of MQTT-MCP (bare and working copy under qa/clones/v4633-mqtt*) and created project "v-mqtt" from it in the UI (Settings, Manage projects, New project). Everything below was done through the UI with headless Chrome. The scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633/ (mem.mjs, convpol.mjs, conv.mjs, ver.mjs and their .log files).
1) Memory (mem.log): in Settings > Projects > Project memory I added one entry with "Add project knowledge". The summary changed from "Project memory · 0 entries" to "Project memory · 1 entries". I then opened the same entry for editing in tab A and tab B. B saved a new title, then A saved a new body. The alert under A's form read exactly "Memory revision conflict: m-ab8908af-4ea6-40f9-ae19-a8b0f1869486 is at revision 2 Your draft is still here." That is a run-on sentence with a raw entry id. It also repeats the conflict notice just above it, "This entry is now at revision 2. Your draft is preserved." Screenshot: qa/shots/v4633t/002-memory-conflict.png.
2) Filesystem policy (convpol.log): "Read deny paths" set to "/etc" and then "src/*" gave "Policy paths must be literal relative repository paths Your draft is kept." Setting it to "../outside" gave "Paths must stay inside the repository; traversal, empty components and Git internals are not allowed Your draft is kept." Both are run-on sentences.
3) Conventions stale restore (conv.log): tab A was at revision 2 with no unsaved changes. In A I opened Revision history, chose Revision 1 and clicked "Preview saved revision", which enabled "Restore as new revision". Tab B then saved revision 3, and A clicked Restore. The alert read "Conventions changed to revision 3. Your draft was not saved." and the warning below it read "Your draft is preserved. Review the latest saved guidance before applying it." The user was restoring, not saving a draft, and there were no unsaved edits, so the message is misleading. Screenshot: qa/shots/v4633t/001-conventions-stale-restore.png.
4) Verification (ver.log): in Project > Repositories > Verification, "Detect checks" found no gates in MQTT-MCP's root, so I added custom-1 "test -f README.md && echo readme-ok" and custom-2 "test -f NO-SUCH-FILE.md", leaving "Attempts per gate" at its default of 1. The Evidence column shows "1 attempts" for  …

</details>

### t24-6 · minor · Workflow advice ranks a 0/3 workflow above 0/4 workflows because of floating-point residue in the Wilson bound

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features PLAT-19.

**Repro**

> 1. In one repo, finish 3 Agent runs and 4 Fix & review runs, none of which pass checks (e.g. the repo has no checks). 2. Open New run > Workflow advice from this repository.

**Expected:** Workflows tied at a lower bound of 0 are ordered by the documented tie-break (more completed samples first), so Fix & review (4) comes before Agent (3).

**Actual:** Agent (0/3, interval 0-56%) is listed first. /api/experience shows confidence.low = 5.55e-17 for n=3 and 0 for n=4, so the float residue decides the order. Also, '0/3 runs passed checks' is shown for runs with no configured check, which reads as failure.

**Root cause (verifier):** src/stats.ts:229-236 confidenceInterval computes low as Math.max(0, center - margin). With p=0 the two terms are algebraically equal: center = (z²/2n)/d and margin = z·sqrt(z²/4n²)/d. In IEEE doubles the subtraction leaves residue of up to about 6e-17 for some n (3, 6, 7, 12, ...) and exactly 0 for others (4, 5, ...). Math.max(0, ·) does not remove a positive residue.

Two sorts then compare low with exact subtraction, so the residue wins before their tie-breaks (more samples first) are reached:
- src/experience.ts:35, workflowRecommendations: `b.confidence.low - a.confidence.low || b.completed - a.completed || ...`
- src/stats.ts:221, rankAgents: `b.confidence.low - a.confidence.low || b.attributedJudged - a.attributedJudged || ...`

The rankAgents order feeds Auto role routing (src/server.ts:655, src/engine.ts:1219), so an all-failing provider with 3 samples can be preferred over one with 4. Severity is minor: it only affects ties at a 0 lower bound, where neither option has any passing evidence. The UI shows both as "0–xx%", so the order looks arbitrary rather than harmful. The mirror case (passed=samples gives high=0.9999999999999999) only affects display, which rounds to 100%.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/stats.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/stats.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/experience.test.ts`

**Suggested fix:** Make the interval's endpoints exact at the boundaries inside confidenceInterval (src/stats.ts:229), so every caller benefits. After clamping passed, return `low: k === 0 ? 0 : Math.max(0, center - margin)` and `high: k === samples ? 1 : Math.min(1, center + margin)`, where k = Math.max(0, Math.min(samples, passed)).

An alternative is the cancellation-free form of the lower bound, (p + z²/2n − margin·d)/d, rewritten as a single quotient, but special-casing the boundaries is simpler and exactly matches the closed form.

Optionally, the two sorts (src/experience.ts:35, src/stats.ts:221) could compare low bounds with a small epsilon (e.g. Math.abs(diff) > 1e-12) as a defence against future residue. That is not needed once the boundaries are exact.

Separately, and optionally for copy: in ui/experience.tsx:28 the advice could say "0/3 runs verified by checks", or note how many had no check configured, so that unverified runs do not read as failures. Their denominator behaviour is documente …

**Suggested regression test:** test/stats.test.ts:
- For n in 1..50: assert.equal(confidenceInterval(0, n).low, 0) and assert.equal(confidenceInterval(n, n).high, 1).
- rankAgents over [3× run(["claude"], false), 4× run(["codex"], false)] should deepEqual order ["codex", "claude"] (tie at 0, more samples first).

test/experience.test.ts:
- workflowRecommendations over 3 solo and 4 fix-review runs, all status "done" with verdict undefined, should map patterns to ["fix-review", "solo"].

All three fail on the current code: ci(0 …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4669t246" on 127.0.0.1:4669 (new home, no prior runs). Created a scratch git repo /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4669-nochecks with only README.md and notes.txt, so no check could be detected. Used POST /api/runs to start 3 runs with pattern "solo" (Agent) and 4 with pattern "fix-review" (builder codex, reviewer claude), no intent. All 7 ended status=done with no verdict or verification, so their check label is "Not configured".

GET /api/experience?repo=... returned the list in this order:
- solo 0/3: low=5.551115123125783e-17, high=0.5615
- fix-review 0/4: low=0, high=0.4899

UI (headless Chrome, fresh profile): opened New run on the project, then expanded "Workflow advice from this repository". It listed:
1. "Agent :: 0/3 runs passed checks · 95% interval 0–56%"
2. "Fix & review :: 0/4 runs passed checks · 95% interval 0–49%"

No console or 5xx errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669t246/001-workflow-advice.png

Read-only script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669/rank.mts imports the real src through tsx and found two things:
- The same inversion happens in rankAgents. With claude at 0/3 and codex at 0/4 (sole writer, both failing), the order is ['claude','codex'].
- Sweeping n=1..40 with passed=0, low is non-zero for n=3, 6, 7, 12, 14, 24, 25, 28 and 35 (about 1e-17 to 6e-17) and exactly 0 for the other n. With passed=n, high is 0.9999999999999999 for several n (display only).

Refutation attempts failed:
- Not by design: the help text says "Ranked by the conservative lower bound". The Wilson lower bound for 0 passes is exactly 0 for every n, and the code's own tie-break (more completed first) is meant to decide this case but never runs.
- Not the tester's environment: it reproduced on a fresh home and a fresh browser, and directly against the module.

The secondary claim ("0/3 runs passed checks" shown for runs with no configured check) is by design. docs/application-improvements.md:213-216 says suggestions "retain failures in their denominator", and src/run-status.ts:5 says "Execution completion alone is never evidence of success". Clearer wording would be a copy improvement, not a defect.

Cleanup: deleted the 7 runs through the rail  …

</details>

### t24-8 · minor · ML 'Check computer' fails with a raw 500 ENOENT when running from source, because the training-worker bundle is never built by npm run dev

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-26.

**Repro**

> 1. From a source checkout where only the UI was built (npm run dev builds only the UI; dist/training-worker.json absent), start code-flow and enable model training. 2. Project > ML > Check computer.

**Expected:** The worker bundle is built by the dev/start path, or the UI explains how to build it (npm run build:training-worker).

**Actual:** HTTP 500. The UI shows the raw path error 'ENOENT: no such file or directory, open '.../src/dist/training-worker.json'' (the second fallback path), and server.log records the stack. The user's main checkout also lacks dist/training-worker.json.

**Root cause (verifier):** src/ml/transport.ts:14-18 `loadBundle()` reads `../../dist/training-worker.json` and on any failure falls back to `../dist/training-worker.json` (src/dist). If neither exists, the second readFile's raw ENOENT propagates. It is not converted to an `MlError`, so src/ml/api.ts:48 (`if (error instanceof MlError) throw new HttpError(...); throw error;`) rethrows it. The server's generic handler then turns it into a 500 with the raw message, and ui/ml/workspace.tsx:60 (`act()` sets `error` to `e.message`) shows it word for word.
The same unguarded call sits on the enroll path, src/ml/service.ts:86 (`probe`, which deployments.ts:79 and schedules.ts:53 also reach), and in `upgrade` at src/ml/service.ts:102.
The file is missing in source runs because the only producer is scripts/build-training-worker.mjs. It runs from scripts/build-host.mjs:12 (`npm run build` / `npm start`), from `npm run build:training-worker`, and from the test `before()` hook. scripts/dev.mjs:25 spawns only `scripts/build-ui.mjs --watch` and then `tsx src/server.ts` (line 27), so `npm run dev`/`dev:real` never build it.
The sibling SSH host bundle already has the right pattern: src/ssh-projects/manager.ts:55 catches the …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ml/transport.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/dev.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ml.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/README.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/model-training.md`

**Suggested fix:** 1) src/ml/transport.ts `loadBundle`: try the primary path, then the packaged fallback. If both fail with ENOENT, throw `new MlError("The training-worker package is missing. Run npm run build:training-worker (or npm run build), then check the computer again.", 503)`; rethrow other errors unchanged. MlError is already exported from ./model.js, and api.ts maps it to an HttpError with that status, so the UI shows the actionable sentence instead of a raw 500 path. Optionally skip the fallback when an explicit `path` argument is given, so errors name the right file.
2) scripts/dev.mjs: `import { buildTrainingWorker } from "./build-training-worker.mjs"` and `await buildTrainingWorker()` once before spawning the server. It is a single esbuild bundle and takes about a second. Building once per dev session, rather than on every watch change, avoids changing the bundle version under already enrolled targets.
3) Docs: add one line to README "Development" and docs/model-training.md saying that `npm …

**Suggested regression test:** In test/ml.test.ts, add a case that builds an `MlService` with `bundlePath: join(directory, "missing-bundle.json")` (the src/dist fallback does not exist in a test checkout, so both reads ENOENT) and calls `service.probe("local")` on the unenrolled local target. Assert `await assert.rejects(..., e => e instanceof MlError && e.status === 503 && /npm run build:training-worker/.test(e.message) && !/ENOENT/.test(e.message))`. Do the same for `upgrade()`.
At the API level, call `handleMlApi` for `POS …

<details><summary>Verifier's independent reproduction</summary>

1) Started a fake-mode QA server with a brand-new home: `qa-server.sh start v4673m 4673 fake`. It runs the dogfood-qa source through `node --import tsx src/server.ts`, which is the same as the `tsx` step of `npm run dev`. The source tree has no dist/training-worker.json (`ls dist` shows only `docs`, and dist/ is gitignored). The fresh home had ML disabled (`{"enabled":false,"revision":0}`).
2) Ran a Playwright script (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673m/ml-check.mjs) through the UI: Settings > General > "Enable model training" (the setting became enabled, revision 1), then Project MQTT-MCP > ML > "Check computer".
Result: `POST /api/ml/targets/local/probe` returned HTTP 500 `{"error":"ENOENT: no such file or directory, open '.../dogfood-qa/src/dist/training-worker.json'"}`. The ML card shows that raw text under the recipe selector (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4673m/002-ml-check-computer.png). homes/v4673m/server.log logs "POST /api/ml/targets/local/probe failed ... ENOENT ... training-worker.json". The path in the message is the second fallback (src/dist), not the primary dist/ path, which makes it more confusing.
3) Control: ran `qa-server.sh snapshot v4673m`, ran only `node scripts/build-training-worker.mjs` in the copy (this creates dist/training-worker.json), then started another fresh home, v4673c, on port 4675 from that copy and ran the same UI script. Probe returned HTTP 200 with workerId, platform and cpus, plus an actionable `issue: "Install the pinned Python 3.12 environment for this recipe..."`. No errors. So the missing bundle is the only cause; it is not the tester's environment, selector or profile.
Refutation attempts:
- Docs only say "Package changes require rebuilding the worker with npm run build:training-worker or npm run build". That line is under "Development checks" in docs/model-training.md:320, about changing the worker package. Nothing says the bundle is needed just to run from source.
- README "Development" says `npm run dev` rebuilds the UI and restarts the server, but does not mention this step.
- README "Run from source" uses `npm start` (which runs `npm run build`, and that builds the worker), so the documented end-user path works. The dev path and the plain `tsx src/server.ts` path do not.
- test/ml.test.ts:79 builds the bundle i …

</details>

### t24-9 · minor · Wrong Python version is not reported by Check computer; setup fails later with a raw assertion

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-26.

**Repro**

> 1. Project > ML > Python settings: set /usr/bin/python3 (macOS system 3.9.6), Save. 2. Check computer. 3. Install training environment.

**Expected:** Check computer reports that the configured executable is Python 3.9, not 3.12, before setup is attempted.

**Actual:** Check shows the generic 'Install the pinned Python 3.12 environment for this recipe, or choose a compatible existing Python environment.' Setup then fails as 'Command failed: /usr/bin/python3 -c import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12' Traceback ... AssertionError: Use Python 3.12'. The Python settings panel collapses after Save with no confirmation.

**Root cause (verifier):** There are three causes, one per symptom.

1. Check computer never looks at the interpreter version (src/training-worker/main.ts:38-46, `probe()`).
   - It runs `<python> recipe.py probe`, and `catch {}` at line 45 throws away the real failure. Every failure becomes the same fixed issue string.
   - training/recipes/tabular-autogluon/recipe.py:210 calls `importlib.metadata.version('autogluon.tabular')` first. With no packages installed that raises PackageNotFoundError, so the version check at recipe.py:220 is never reached on a fresh interpreter. Even when it is reached, line 45 discards its message.
   - Result: Python 3.9 and Python 3.12-without-packages give identical probe output.

2. Only the setup job checks the version, and its error is shown raw (main.ts:336).
   - Setup runs `exec(accepted.python, ["-c", "import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12'"])`.
   - Node's promisified execFile rejects with "Command failed: <cmd + args>\n<stderr traceback>".
   - main.ts:387 saves `(error as Error).message` as-is, and ui/ml/workspace.tsx:217 renders `job.status.error` verbatim.

3. Python settings gives no feedback on save (ui/ml/workspace.tsx:96 and 203-20 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/training-worker/main.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ml/model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ml/workspace.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/training/recipes/tabular-autogluon/recipe.py`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/training/recipes/llm-sft-lora/recipe.py`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ml.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/model-training.md`

**Suggested fix:** Worker side (src/training-worker/main.ts):

1. Add a helper, e.g. `pythonVersion(python, root)`. It runs `exec(python, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {timeout: 10000, env: environment(root)})` and returns the version string, or a clean error such as "Python executable /x could not be started (ENOENT)".

2. In `probe()`, call the helper for each recipe's interpreter before running `recipe.py probe`.
   - If the version is not 3.12.x, set `ready: false` and an issue such as "/usr/bin/python3 is Python 3.9.6; this recipe needs Python 3.12. Choose a Python 3.12 executable in Python settings."
   - Keep the generic "install the pinned environment" message only for a 3.12 interpreter that is missing packages.
   - Add an optional `pythonVersion` (and possibly a `reason: "python-version" | "packages"`) to the `Probe` recipe type in src/ml/model.ts.

3. In the setup branch (line 336), use the same helper and throw a plain `Error` with that sentence instead of t …

**Suggested regression test:** Worker/service test, in test/ml.test.ts (it already drives the worker with fixture recipes and `python: process.execPath`):

1. Write an executable fake-python shell script into the temp dir. For `-c` it prints "3.9.6" (or exits 1 with an AssertionError message if run with the old assert). For a `recipe.py probe` argument it exits 1.
2. Point the local target at it through the service's Python settings call.
3. Assert that `(await service.probe("local")).issue` matches /3\.9/ and /3\.12/, and th …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh server. My assigned ports 4675 and 4677 were already in use by other verifiers' servers (homes v4673c and v4677t2410), and the v4675 home already held earlier state. So I used a new name, v4675t249, on free port 4691, and touched nothing else.

Setup:
1. Ran `qa-server.sh snapshot v4675`.
2. In builds/v4675, ran `node scripts/build-training-worker.mjs`. The dogfood source has no dist/training-worker.json, and the reporter also ran from a build.
3. Ran `qa-server.sh start v4675t249 4691 fake builds/v4675`. Python is not faked in fake mode.

Steps in the UI (Playwright scripts are in qa/work/v4675t249/step1-3.mjs, logs are step*.log next to them):
1. Settings > General > "Enable model training".
2. Opened #/project/p-ef01794b/ml (MQTT-MCP). The repository and "This computer" were preselected.
3. Baseline: clicked "Check computer" with the default python3, which is /usr/local/bin/python3 = 3.12.8 with no packages. It showed: "Install the pinned Python 3.12 environment for this recipe, or choose a compatible existing Python environment."
4. Opened Python settings, entered /usr/bin/python3 (3.9.6) and clicked "Save Python settings".
   - The target revision went 2 to 3 and python became /usr/bin/python3.
   - The `<details>` element was open before the save and closed after it.
   - No role=status or role=alert text appeared, and the earlier Check result disappeared (shots/v4675t249/003-after-save.png).
5. Clicked "Check computer" again. The text was identical to the 3.12 baseline. The raw probe JSON was `{python:"/usr/bin/python3", ready:false, issue:"Install the pinned Python 3.12 environment…"}` for both recipes, with no version information (shots/v4675t249/004-check-python39.png).
6. Clicked "Install training environment". Job 013be8b4 failed within about 1 second with: "Command failed: /usr/bin/python3 -c import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12'\nTraceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nAssertionError: Use Python 3.12". The UI shows this verbatim in Experiment details (shots/v4675t249/001-setup-failed.png).

To pin the cause, I ran the bundled recipe.py probe directly under both interpreters. Both die on `PackageNotFoundError: autogluon.tabular` before the recipe's own Python version check.

I found no console or page errors and no 5xx responses. The setup failed at the assertion, so pip never ran and nothing was downloaded.

Is it by design? No. docs/model-train …

</details>

### t24-10 · minor · Claude experiment planner gives up on the final iteration, apparently misreading the unlabeled 'iteration' field as the limit already reached

Source: tester unit infra-platform-memory-ml-insights-2; observed with real-agents; features PLAT-28.

**Repro**

> 1. Tabular dataset prepared; Improve within limits with planner 'Claude CLI', model haiku, 2 iterations, 4 training minutes. 2. Start automatic experiments and wait for completion.

**Expected:** Both iterations can be used for trials (the per-trial cap is 2 minutes, so 2 trials fit the 4-minute budget).

**Actual:** Trial 1 ran. Iteration 2 was recorded as 'Not proposed / rejected' with Claude's rationale 'Iteration 2 of 2 is the iteration limit, so no further trials are allowed... Only 120 training seconds remain, which is too little'. A 3-iteration run also stopped at iteration 2 claiming 240s was too small. Iterations and elapsed budget are consumed without trials.

**Root cause (verifier):** 1. src/ml/cycles.ts:122-123 durably pushes {number, state:"planning"} into c.trials before calling the planner (cycles.ts:126). This is intended: the iteration is consumed first.
2. src/ml/planner.ts:10 (plannerInput) then sends `iteration: c.trials.length`. That value already includes the current turn, so on the last call it equals limits.iterations (2 of 2). It sits next to limits.iterations with no label saying it is the 1-based iteration this call should fill and that the call is already within limits. Claude reads it as "limit reached".
3. Also at planner.ts:10, `limits` carries only totals (trainSeconds = 240 total budget, remainingTrainSeconds = 120). The per-trial training allowance (template spec.trainSeconds = 120) is never sent: parameters() at planner.ts:7 returns only trees/depth (or the LLM hyperparameters), and the spec itself is withheld. So the model cannot tell whether 120 s or 240 s left is enough for another trial, and reports it as "too little".
4. The system prompt at src/ml/planner.ts:40 says only "Stop if further improvement is unlikely". It never says that Code Flow enforces the iteration, time and training-budget limits itself (cycles.ts:119, 135-138, 143) …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ml/planner.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ml.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/model-training.md`

**Suggested fix:** Make the planner input state its meaning explicitly, and tell the model that the limits are already enforced. In src/ml/planner.ts:
(a) Replace the bare `iteration: c.trials.length` with labelled fields, for example `currentIteration: c.trials.length` (1-based; this call proposes it), `maxIterations: c.limits.iterations`, `iterationsLeftIncludingThis: c.limits.iterations - c.trials.length + 1`.
(b) Add the per-trial cost and how many trials fit: `trialTrainSeconds: spec.trainSeconds` and `trialsThatFitRemainingBudget: Math.floor((limits.trainSeconds - reservedTrainSeconds) / spec.trainSeconds)`. Optionally rename the total to `totalTrainSeconds` so it is not mistaken for a per-trial value. These are plain numbers, so the plannerInput allowlist and its "no paths/labels" test still hold.
(c) Extend the --system-prompt: "Code Flow has already verified that this iteration fits the iteration, time and training-budget limits. Propose a configuration for currentIteration unless validation evi …

**Suggested regression test:** test/ml.test.ts:
(1) Add a plannerInput unit test. Build a cycle with limits {iterations:2, trainSeconds:240}, a template spec with trainSeconds 120, trials [{number:1, state:"done", jobId, spec}, {number:2, state:"planning"}] and reservedTrainSeconds 120. Assert that plannerInput(...) has currentIteration 2, maxIterations 2, iterationsLeftIncludingThis 1, trialTrainSeconds 120 and trialsThatFitRemainingBudget 1, and that there is no ambiguous bare `iteration` key.
(2) Extend the existing fake-c …

<details><summary>Verifier's independent reproduction</summary>

Fresh real-mode QA server v4677t2410 on 127.0.0.1:4677. It ran from my own snapshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4677 (dist/training-worker.json built there) with CODEFLOW_ML_ENABLED=true and a fresh home with no runs.
1. In the UI I created project "v4677-ml" (p-17a4d26a) on a new scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4677-ml.
2. On the ML tab I set Python to /usr/local/bin/python3.12, clicked Check computer, then Install training environment. The job succeeded.
3. I chose the Tabular recipe, prepared /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677t2410/data/sensors.csv (400 rows) with target "label", and filled Improve within limits: planner "Claude CLI", model haiku, 2 iterations, 4 training minutes, 30 elapsed minutes, patience 3, min improvement 0. Then I clicked Start automatic experiments. Scripts are search.mjs, install.mjs and setup.mjs in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677t2410; output is in search.log there.
4. To see exactly what Claude received, I put a pass-through tap in front of the real claude 2.1.310 on the server PATH. It is work/v4677t2410/bin/claude and only tees stdin/stdout to work/v4677t2410/calls/. The CLI, its arguments and the model were unchanged.

Result (reproduced on the first attempt, one real run, about $0.001 of haiku):
- Call 1 stdin: {"limits":{"iterations":2,"trainSeconds":240,...,"remainingTrainSeconds":240},"iteration":1,"trials":[]}. Claude proposed 128 trees, depth 8. Trial 1 finished at 0.9875 validation accuracy.
- Call 2 stdin: {"base":{"trees":64,"depth":16},"limits":{"iterations":2,"trainSeconds":240,"elapsedSeconds":1800,"patience":3,"minImprovement":0,"remainingTrainSeconds":120},"iteration":2,"trials":[{number:1,...,validation:{baseline:0.775,candidate:0.9875}}]}. Nothing in it says what one trial costs (120 s). Claude returned stop=true with: "Iteration 2 of 2 is the final allowed iteration, so no further trials can run. ... remaining headroom is under 1.25 points, so another bounded trial is unlikely to justify its cost."
- UI: "2 / 2 iterations · 2 / 4 training minutes reserved". Row 2 reads "Not proposed · rejected · Pending" with that …

</details>

### t24-11 · minor · Resume stays offered for a paused search with no iterations left and then reports 'no candidate beat the validation baseline' when no candidate was ever trained

Source: tester unit infra-platform-memory-ml-insights-2; observed with real-agents; features PLAT-28.

**Repro**

> 1. Start automatic experiments with planner Claude CLI and an invalid model (e.g. claude-nonexistent-qa), 2 iterations -> paused after the planning failure. 2. Resume with remaining budget -> fails again, paused at 2/2 iterations. 3. Resume is still enabled; click it.

**Expected:** Once the iteration budget is exhausted, Resume is hidden or disabled with an explanation, and the terminal reason says no trial ran (planner failures).

**Actual:** At 2/2 the button is enabled. Clicking it completes the search with 'Iteration limit reached; no candidate beat the validation baseline', although every iteration was a planner failure and nothing was trained.

**Root cause (verifier):** The misleading terminal reason is the real defect.
- src/ml/cycles.ts:158 (MlCycles.finish): with no c.bestJobId, it always appends "no candidate beat the validation baseline". It does not check whether any trial produced a validation evaluation. Trials rejected by the planner (cycles.ts:147, the catch block) and failed or cancelled trial jobs (around cycles.ts:111, "Trial ${state}; reservation retained") also leave bestJobId undefined. So "Iteration limit reached" (cycles.ts:119) or "Training budget exhausted" is reported as if candidates were compared and lost to the baseline.
- Contributing UX issue, ui/ml/workspace.tsx:179: the button is labelled "Resume with remaining budget" and enabled for every paused search, even when c.trials.length >= c.limits.iterations (or the budget, patience or time is already exhausted). There it does not resume anything; it only finalizes. The server's resume() at cycles.ts:57 allows this deliberately.
- The reporter's suggested fix (hide or disable Resume at trials >= iterations) would be wrong. When a validation winner exists and the last planner call failed, that click is the only way to trigger finish() → the single final test and export (shown …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ml/cycles.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ml/workspace.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ml.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/model-training.md`

**Suggested fix:** 1. src/ml/cycles.ts finish() (line 156-158): choose the no-winner suffix from the evidence. Check whether any trial job of this cycle succeeded with a validation evaluation, e.g. this.jobs(c.id).some(j => j.intent.search?.partition === "validation" && j.status.state === "succeeded" && j.status.evaluation).
   - If yes, keep "no candidate beat the validation baseline".
   - If no, use something like "no trial produced a validation result (planner rejections/failed trials); keep the baseline". If all trials are rejected planner turns, say "every iteration ended in planning; no model was trained".
2. ui/ml/workspace.tsx:179: when a paused search has no remaining iterations (c.trials.length >= c.limits.iterations), or when the training budget, patience or final-evaluation time is exhausted, keep the button but relabel it.
   - With c.bestJobId: "Finish: test selected model once".
   - Without one: "Finish search".
   - Add a one-line explanation that no iterations remain.
   - Do not disab …

**Suggested regression test:** Add to test/ml.test.ts:
- "planner-only failures that exhaust iterations do not claim a baseline comparison": context({ planner: async () => { throw new Error("Claude planning failed or timed out") } }), iterations 2. Create, settleCycle, resume, settleCycle, resume, settleCycle. Assert state === "completed", that no experiment has intent.search.cycleId === search.id, and assert.doesNotMatch(reason, /no candidate beat/) plus assert.match(reason, /no trial|no model was trained/).
- Companion test …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4679 on port 4679, from my own snapshot at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4679. In that snapshot I first ran scripts/build-training-worker.mjs, because the dogfood source has no dist/training-worker.json. CODEFLOW_ML_ENABLED=true; the home had no runs and empty ML state.
1. Created project v4679-ml through the UI on a scratch clone of MQTT-MCP.
2. Set Python to /usr/local/bin/python3.12, clicked Check computer, then Install training environment. The setup job succeeded.
3. In "Improve within limits" (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679/mlsearch.mjs):
   - prepared sensors.csv (400 rows) and named the search search-badmodel;
   - chose planner Claude CLI with model claude-nonexistent-qa, 2 iterations, 4 training minutes, 30 elapsed minutes, patience 3, minimum improvement 0;
   - clicked Start automatic experiments.
   Fake claude's --help lists only 6 of the 11 required planner controls, so every planner call throws "Update Claude CLI: the required text-only planner controls are unavailable". That is the same path as the reporter's invalid model: the planner throws in advance(), the trial is rejected and the search pauses. Result: "search-badmodel · paused", 1/2 iterations, trial 1 "Not proposed / rejected".
4. Clicked "Resume with remaining budget" (mlpeekc.mjs). Result: paused at 2/2, both trials rejected, 0/4 training minutes reserved.
5. The screenshot (shots/v4679/001-cycle-search-badmodel.png) shows "Resume with remaining budget" still enabled at 2/2. Clicked it again. Result: "search-badmodel · completed" with "Iteration limit reached; no candidate beat the validation baseline".
6. Persisted ml/state.json: both trials rejected, no bestJobId or finalJobId, reservedTrainSeconds 0. The only experiment is the setup job, so no trial was ever trained or evaluated. No console or 5xx errors.

I also ran a focused node:test file in my snapshot (deleted afterwards):
- Planner that always throws, 2 iterations: create → paused 1; resume → paused 2; resume → completed "Iteration limit reached; no candidate beat the validation baseline" with 0 trial jobs. An assertion that the reason does not claim a baseline comparison fails.
- Counter-check: planner proposes trial 1 (a validation winner), then throws on iteration 2 → paused at 2/2 w …

</details>

### t24-12 · minor · Interrupted copy-to-SSH dataset transfer is 'resumed' by re-sending every chunk from byte 0

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features INFR-GAP-02.

**Repro**

> 1. Add an SSH training server (isolated fake-ssh fixture used). 2. Dataset is on: Project computer - copy to training server; a ~5MB CSV (19 x 256KB chunks). 3. Make SSH fail after ~8 chunks (fixture DOWN file) -> 'SSH setup failed ... Connection refused'. 4. Restore SSH and Prepare dataset and transfer again; count SSH calls.

**Expected:** Per docs ('Repeating preparation of unchanged input can resume a partial transfer'), the retry continues from the worker's existing .part size and only sends the remaining chunks.

**Actual:** The retry made 21 SSH calls, the same as a fresh full transfer. All 19 chunks are re-sent and only compared byte-for-byte by the worker. On a slow link an interrupted 128MB transfer is fully repeated.

**Root cause (verifier):** src/ml/service.ts:162: the controller's copy-to-SSH loop always starts at `for (let offset = 0; offset < bytes;)`. It never asks the worker how much it already holds, and it ignores the `{ offset }` that every upload reply returns.

The worker does support resuming:
- src/training-worker/main.ts:166-179 keeps transfers/<hash>-<format>.part across calls.
- For offset < size it re-reads and byte-compares the stored range (line 177).
- It reports "Resume this transfer at byte N" if a chunk skips ahead (line 178).
- Every reply returns the current .part size (line 179).

The worker also does not short-circuit when datasets/<hash>.json already exists (finishSnapshot, main.ts:76-77, only checks this after every chunk has been sent again). So the retry is correct and does not corrupt data, but it saves no bandwidth.

docs/model-training.md:277 says "Repeating preparation of unchanged input can resume a partial transfer". The comment at service.ts:151 ("Retries use content hashes and verified byte offsets") describes checking integrity, not skipping bytes. The serving upload path (src/ml/deployments.ts:53-54) at least asks `serve-upload-status` before sending.

This is a gap between the do …

**Files:** `src/ml/service.ts`, `src/training-worker/main.ts`, `test/ml.test.ts`, `docs/model-training.md`

**Suggested fix:** 1. Worker: add an `upload-status` action, or allow `upload` with no data, keyed by {hash, format, bytes}.
   - If datasets/<hash>-<format>.json exists and the stored file still hashes to the fingerprint, return { present: true }.
   - Otherwise return { offset: size of transfers/<hash>-<format>.part }, or 0 when there is none.
   - If the .part is larger than `bytes`, discard it and return 0.
2. Controller (service.ts ~162):
   - Call the status action after freezing the source.
   - If the dataset is already present, go straight to finish-upload.
   - Otherwise start the loop at the returned offset, rounded down to a CHUNK_BYTES boundary. This keeps chunk alignment, and the existing byte-compare still covers any overlap.
   - Use each upload reply's `offset` as the next cursor instead of `offset += bytesRead`.
   - If a reply says "Resume this transfer at byte N", re-sync once from the status action rather than failing.
   - finish-upload's full SHA-256 check stays the integrity gate, …

**Suggested regression test:** test/ml.test.ts, next to "SSH fine-tuning transfers JSONL..." (uses sshFixture + TrainingTransport):
- Wrap the WorkerClient so it records each request's action/offset and throws on the 9th "upload".
- Snapshot a ~5 MB controller-side CSV with location "controller"; assert the call rejects and the worker's transfers/<hash>-csv.part is 8*CHUNK_BYTES.
- Remove the fault and snapshot again. Assert:
  - the first upload offset is 8*CHUNK_BYTES;
  - the number of upload calls is ceil(bytes/CHUNK_BYTE …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server "v4681t2412" on port 4681, built from my own snapshot at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4681t2412. The snapshot was needed to build dist/training-worker.json, which the dogfood tree does not contain. I diffed src/ml/service.ts and src/training-worker/main.ts against dogfood-qa and both are identical. CODEFLOW_ML_ENABLED=true was set.

I put a separate isolated SSH stand-in first on PATH: work/v4681t2412/fakessh/bin/ssh. It runs commands locally with HOME set to fakessh/remote and never touches the network. It writes each worker request's action, offset and chunk size to fakessh/audit.jsonl. When the file FAIL_AFTER_UPLOADS=8 exists, it starts answering "Connection refused" from the 9th upload on.

The recipe environment was faked with work/v4681t2412/fakepy. It only answers the AutoGluon readiness probe; "inspect" runs the real recipe.py on system Python 3.12 with pandas. This only gets past the env gate and does not touch the transfer path.

UI flow (Playwright, project MQTT-MCP, ML tab):
- Add SSH server: alias qa-fixture-v4681, absolute worker dir, Python set to fakepy, standalone ticked. Saved, then Check computer showed "Selected recipe's environment is ready".
- Dataset: "Project computer — copy to training server" with a 4,850,008-byte CSV, i.e. 19 chunks of 256 KiB.

Results:
- Attempt 1: probe, then uploads at offsets 0 to 1835008 (8 chunks). The 9th upload at 2097152 was refused. The UI alert read "SSH setup failed: ssh: connect to host fixture port 22: Connection refused..." (HTTP 500 on POST /api/ml/datasets). The worker kept transfers/<hash>-csv.part at exactly 2,097,152 bytes.
- Attempt 2, after removing the failure trigger: probe, then 19 uploads starting again at offset 0 (0, 262144, … 4718592), then finish-upload. That is 21 SSH calls, the same as a fresh transfer, and it ended in "Snapshot: a8f0609a623fc331".
- Attempt 3, re-preparing the same input that was now fully on the worker: again probe + 19 uploads + finish-upload. So an already completed dataset is also re-sent in full.

</details>

### t24-17 · minor · Model training docs say removing CODEFLOW_ML_ENABLED blocks deployments, but the saved Settings choice overrides the env

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-25.

**Repro**

> 1. Enable model training in Settings (saved rev 1). 2. Restart the server without CODEFLOW_ML_ENABLED -> still enabled. 3. Conversely, start a fresh home with CODEFLOW_ML_ENABLED=true -> enabled rev 0; disable in Settings; restart with the env still true -> disabled.

**Expected:** Docs describe the actual precedence: the env is only a default until Settings saves a choice.

**Actual:** docs/model-training.md (Deploy section) states 'Removing CODEFLOW_ML_ENABLED blocks deployment creation, switching, resume and inference', which does not hold once a Settings choice is saved.

**Root cause (verifier):** The code works as intended: a saved Settings choice wins over the env. The defect is a stale sentence in the docs.

- **Code:** src/ml/service.ts:44 is `enabled() { return this.options.enabled?.() ?? this.store.read().activation?.enabled ?? mlEnabled(); }`. The env (mlEnabled(), service.ts:22) is only used when no `activation` has been saved. Every deployment gate goes through that check: src/ml/deployments.ts:20 `private enabled()` calls service.enabled(), and it is used for create (:71), switch/rollback/resume (:113, which skips stop), warm (:122) and predict/stream (:172, :183, :213, :220).
- **Tests and docs agree with the code:** test/ml-settings.test.ts ("legacy environment activation is a fallback until Settings saves an explicit choice", and the restart test) checks this precedence. docs/model-training.md:9 and :308 describe it too (":308 — CODEFLOW_ML_ENABLED=true remains a startup fallback only until Settings saves a choice").
- **The stale sentence:** docs/model-training.md:107 (Deploy section) says "Removing `CODEFLOW_ML_ENABLED` blocks deployment creation, switching, resume and inference; stopping deployments remains available." It was added in commit a947d5a, before t …

**Files:** `docs/model-training.md`

**Suggested fix:** Rewrite the env sentence in docs/model-training.md:107 so it matches the real precedence and points to the Settings control. For example: "**Disable model training** in Settings → General blocks deployment creation, switching, resume and inference; stopping deployments remains available. `CODEFLOW_ML_ENABLED` is only a startup default until Settings saves a choice, so removing it later has no effect." Optionally, say the same thing once more in the opening section (:9) so both the env and the toggle are described together. No code change is needed.

**Suggested regression test:** Add a case to test/docs.test.ts, or a small docs assertion in test/ml-settings.test.ts. It reads docs/model-training.md, asserts it does not match /Removing `?CODEFLOW_ML_ENABLED`? blocks/, and asserts every mention of CODEFLOW_ML_ENABLED appears together with "until Settings saves a choice" (or similar wording). Precedence itself is already covered by test/ml-settings.test.ts. To pin step 4 from the reproduction, extend it: delete CODEFLOW_ML_ENABLED after setSettings({enabled:true}), restart,  …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh QA home v4691ml in fake mode on port 4691 (home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4691ml). The Settings toggle was driven through the UI (Settings -> General -> Model training card) with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691ml/toggle.mjs.

To test the gate I used /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691ml/probe.sh. It reads GET /api/ml/settings and /api/ml/capabilities, then sends POST /api/ml/deployments for MQTT-MCP with a model id that does not exist, so nothing is written. deployments.create() checks enabled() before it looks up the model. So a 409 "Enable the ML preview to deploy or run inference" means creation is blocked, and "Choose a registered version of this model" means the request got past the gate. I also checked the server process's real env each time with ps eww.

1. Fresh home started with CODEFLOW_ML_ENABLED=true: settings {enabled:true,revision:0}; probe got past the gate.
2. Control: restarted with the env unset and nothing saved: {enabled:false,revision:0}; probe returned 409 "Enable the ML preview...". The doc sentence is true while no choice is saved.
3. Restarted with env=true and clicked "Disable model training" then "Enable model training" in the UI: revision 1 disabled, then {enabled:true,revision:2}. ml/state.json activation = {enabled:true,revision:2}. No console or 5xx errors.
4. Restarted with CODEFLOW_ML_ENABLED unset (ps shows it unset): settings still {enabled:true,revision:2}, capabilities.enabled true, the UI card reads "Enabled", and the deployment-create probe still got past the gate. This contradicts docs/model-training.md:107.
5. Converse: restarted with env=true and disabled in the UI (revision 3), then restarted with env=true again: {enabled:false,revision:3}; probe returned 409 "Enable the ML preview...".

The behaviour in steps 4 and 5 is intended. The only defect is the stale doc sentence.

</details>


## Continuation outcomes · 2026-10-26

Implemented from integration `385a19e` in `/private/tmp/codeflow-qa-memory-ml-stats`. Only scratch repositories, homes and fixture agents were used. Every app, build and test command set an outer scratch `CODEFLOW_HOME`, `HOME`, `ZDOTDIR` and `TMPDIR`. The live checkout, ports 4317/4318, real provider accounts and real user state were not used.

| Issue | Outcome and verification |
| --- | --- |
| t23-12 | Both engine selection/replay paths use one manifest merge. Included keeps its provenance union; omitted excludes matching id/revision pairs. The UI resolves current entry titles, keys revisions separately, retains ID fallback and explains that run-wide inclusion means at least one turn received the revision, referring readers to member context for assignments. A real fake-agent auto-team run omitted path-scoped README knowledge during planning, then included it for the worker; the finished panel displayed one titled row. Replay-order/idempotence and historical revision controls pass. |
| t23-13 | Curated onboarding excludes both sources of a supported potential contradiction and retains the first eligible exact body in title/id order. An ineligible earlier duplicate cannot suppress an eligible source. Each omission names its reason/source; help text and empty-state review guidance match the filtering. Full UI creation of both guest policies and both duplicate entries, followed by publication, saved neither contradiction and only one duplicate. The semantic analyzer remains bounded/advisory for unsupported language. |
| t23-15 | Joined server/UI draft messages use complete sentences across memory, policy, code hosts, retention, coordination and shared-account edits. Memory conflicts remove the raw ID and suppress the redundant generic alert. Convention conflicts name save, restore or publication; failed restore clears the stale preview without falsely warning about an unsaved draft. Singular entry/attempt labels and non-empty exit evidence are fixed. UI conflict, all three policy path inputs, stale restore and real silent failed verification/export were replayed. |
| t24-6 | Wilson bounds use exact zero/one endpoints for all-failing/all-passing samples. Sweep 1–100, agent ranking and workflow ranking pass. Seven actual fake-provider runs (three Agent, four Fix & review, no checks) produce the expected sample-count ordering in the full composer. The documented unverified denominator is unchanged. |
| t24-8 | Source dev startup builds the worker before launching the server. Missing default/explicit bundles produce an actionable `MlError` 503 without raw ENOENT; explicit paths do not silently fall back. Probe and upgrade regressions pass. Full UI missing-bundle recovery passes. A separate real `scripts/dev.mjs --fake-agents --stable` launch on 4357 rebuilt an absent package before health became ready and was stopped with its owned process group. |
| t24-9 | Worker preflight checks the selected executable version before package imports. Wrong/missing Python produces actionable errors for both recipes; setup uses the same check without assertion traceback. Python settings saves show confirmation. A fixture interpreter reporting 3.9.6 was selected through the full UI, checked and rejected during setup without any package install. Worker tests also cover missing executables. |
| t24-10 | Planner input labels the current 1-based slot, maximum/remaining slots, per-trial allowance and number of affordable trials; the system prompt explains that this slot already fits the enforced limits. The final 2-of-2 / 120-seconds-remaining input regression passes, preserving the paths/labels/test-evidence allowlist. Existing bounded-search and text-only planner controls pass. No paid Claude call was made; the actual model's stochastic decision is not claimed verified. |
| t24-11 | Shared limit reasoning gives paused searches a truthful Finish action while preserving the winner's single final test/export path. No-validation searches no longer claim a baseline comparison. Full UI two planner failures → Finish search → completed/no model trained passes; worker tests cover both no-winner and existing-winner finalization. Independent review found and fixed an adjacent undefined-job-ID match that incorrectly forgave a rejected planning iteration under patience=1; its regression passes. |
| t24-12 | New workers advertise upload-resume support and report verified completed snapshots or aligned partial offsets. Oversized/incomplete tails are normalized. The controller uses acknowledged offsets and permits one status resync after an offset mismatch; old workers retain compatible full-copy behavior. Full SHA-256 validation remains mandatory. Unit and live API/UI mock-SSH replay of a 19-chunk input fails on chunk nine, retries from byte 2,097,152 with 11 chunks, then prepares the completed input with zero uploaded chunks. Independent worker probes cover empty/partial/oversized/checksum-corrupt/completed states. |
| t24-17 | Deployment docs identify Settings → General as the disabling control and describe the environment as a startup default until Settings saves a choice. Existing activation/browser restart tests pass in both precedence directions. |

### Evidence

All evidence is retained under `/private/tmp/codeflow-qa-continue/work/memory-ml-stats/` unless stated otherwise.

- `related.log`: **117/117** passing, including complete `test/ml.test.ts`, memory analysis, auto-team memory, memory replay, stats, experience, conventions, verification and ML Settings suites.
- `new-tests-final.log`: **13/13** new regressions. This adds the review's patience case after the related run, for **118 distinct passing unit/service cases** across those runs. `search-final.log`: **6/6** existing search/planner cases rerun after that adjustment.
- `ui-isolated-final.log`: **9/9** new full-app Chrome cases. `original-ui-final.log`: **6/6** original memory-conflict and ML-settings browser cases. **15 distinct browser cases** total.
- `tsc-isolated-final.log`: clean `tsc --noEmit`. `dev-smoke.log` and `dev-server.log`: real dev startup/package rebuild and orderly shutdown; 4357 has no listener afterward.
- `baseline-ui.log`: all five original full-app replays fail on unchanged `385a19e` at the expected defect assertions (singular label, contradictory/duplicate summary, double manifest, workflow rank, missing-bundle 500). `baseline-worker.log`: five defects reproduced; the winning final-evaluation control already passed. `baseline-memory.log`: contradiction, Wilson, stale restore and stale-doc failures reproduced; the message helper test cannot run against baseline because the helper did not yet exist.
- `ui-isolated-final/` contains screenshots, page text, console/HTTP/server logs and `transfer-audit.jsonl`; `verification-final/verification.md` is the actual downloaded silent-failure report. Screenshots of curated onboarding, completed search and verification evidence were visually inspected. Page-error lists are empty. Expected failures are deliberate revision conflicts, invalid policy paths, missing-package 503 and the injected SSH disconnect; no unexpected 5xx or JavaScript exceptions occurred.
- Independent read-only review: `/private/tmp/codeflow-qa-continue/ml51-review/upload-state-fixed.log` passes six transfer-state controls and the corrected patience case. It used a scratch worker and did not change production files.

Two existing fixture expectations required intentional compatibility updates: `test/ml.test.ts` now uses a Python-version stand-in that reports 3.12 and otherwise execs Node for its JavaScript recipes, because real interpreter preflight is enforced; `memory-conflict.e2e.ts` now expects one canonical duplicate source rather than both in onboarding provenance, preserving its stale-source and deletion-graph checks. New regression cases live only in `qa-memory-ml-stats*` files.

Initial replay failures in `ui.log`, `ui-2.log`, `ui-3.log` were test selectors (Markdown class, approval label, role ID, overview route, closed Team activity, policy confirmation and select accessible names). `verification-ui.log` exposed a missing evidence-directory mkdir after the product assertions passed. These were corrected in the harness and rerun; none justified a product workaround.

### Boundaries

ML recipes/interpreter readiness and SSH transport are explicit local fixtures. No model training packages, model downloads, real SSH machines or paid planner calls were used. The original final-iteration issue's input ambiguity is fixed and tested, but a real Claude completion was not sampled. Older installed workers require explicit update to gain efficient transfer resume. Full-branch integration and the unchanged 850,000-byte startup asset budget are checked by the parent on its newer lazy-loaded integration base.

Final parallel-suite isolation review moved the new Chrome fixture into a private scratch app copy: source, UI, build scripts, recipes, docs and assets are copied, dependencies linked, and both builds/server run there. Bundle injection never modifies the checkout’s dist. The exact shared `qa-port-block.ts` helper reserves both adjacent listener ports through setup. All nine cases were rerun after this adjustment. The first private-copy attempt (`ui-isolated.log`) caught a missing VS Code README required by the docs build; that file and tsconfig are now copied too. No application server started during that failed setup.

### Final independent review: literal content and applicability

The late production delta `9e24117` received a separate adversarial review because the earlier full security review predated it. This found an onboarding deduplication regression: whitespace normalization treated differently indented Python code and different quoted spaces as identical. The adjacent scope check also reproduced identical text losing its current-branch/repository or path-specific source distinction.

Onboarding now eliminates only matching original body text, applicability and path sets. Normalized duplicate-review suggestions remain unchanged. Each retained section includes path conditions alongside existing branch conditions, preserving the source's applicability in published guidance. Exact duplicate copies with the same conditions still collapse.

New `qa-final-memory-onboarding` tests cover indentation, quoted spaces, current-branch/repository guidance, distinct and reordered path sets, and positive duplicate controls. **9/9** new/related unit cases, TypeScript and **1/1** actual-server Chrome replay pass. Chrome verified eight source revisions in the preview and guarded publication payload, literal code/values and branch/path conditions in saved content, and the entry after reload. Browser errors and failed HTTP responses are empty. No additional production defect was confirmed in the remaining worker readiness, Python, transfer resume, search lifecycle, memory authority, statistics or presentation changes.

Review scope, risks and limits: `/private/tmp/codeflow-qa-continue/final-51-review.md`. Reproduction and validation logs: `/private/tmp/codeflow-qa-continue/final51-review/`. Browser screenshots, payloads and server/console evidence: `/private/tmp/codeflow-qa-final-memory-onboarding/output/playwright/qa-final-memory-onboarding/`. All execution used explicit scratch homes and fake provider CLIs; no additional real model calls or live repository/account changes occurred.

The final independent label review caught Markdown interpretation of quoted path punctuation (`[config](notes).txt`) and the existing branch label `_qa_`. Applicability labels now use fenced JSON, preserving literal paths, branch and commit values. JSON escapes embedded line breaks, preventing backtick-containing names from closing the fence. New QA regressions use actual tracked punctuation/backtick/newline filenames and a real `_qa_` branch; the browser verifies exact rendered JSON, no generated links/emphasis, and the saved publication. **18/18** focused and original memory-analysis cases, TypeScript and **1/1** extended Chrome replay pass (`path-branch-*.log`). No shared test files were edited.
