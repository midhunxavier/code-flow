# Cluster 28 · github-pr-watch

**PR watch & PR comments: pushing blocked fixes, restart state, merged-outside, duplicate posts**

Status: **fixed and verified** · 11 issue entries (8 distinct causes) · branch `codex/qa-github-pr-watch`

Planner notes: t19-1 (major): the push guard (src/engine.ts ~5810) inspects only the current follow-up's changes, but the push sends the whole branch tip. A commit that was blocked earlier for CI or test tampering is then pushed after 'Watch again'. Guard the full range from the PR head. t19-4: poll failures live in an in-memory Map (src/watch.ts:61), so a watch stays in 'Needs you' after a restart. t19-5/S08-6: the watch log and docs say inline comments aren't read, but they are. t19-14: a PR merged or closed outside code-flow isn't recorded (recordPrMerge is private). t19-15: 'Most fixes' silently turns 0 into 3 and anything above 10 into 10 (ui/run.tsx:1285). t19-6: visual evidence is re-posted on every push; dedupe by content, not by commit sha. t19-16/S04-6: wantsVisualEvidence matches the bare word 'video'. t19-7/S11-4: postReview has no idempotency guard. Notification keys for watches (S08-1) belong to the notifications cluster. Duplicate groups: [["t19-5","S08-6"],["t19-16","S04-6"],["t19-7","S11-4"]]

Likely files: `src/engine.ts`, `src/watch.ts`, `src/visual-evidence.ts`, `src/github.ts`, `ui/run.tsx`, `src/server.ts`

## Resolution and verification · 2026-10-26

All eight reported causes were confirmed against the source and fixed on an isolated branch from `e52f797`. The original issue descriptions below remain as the reproduction record.

| Issue | Resolution and evidence |
| --- | --- |
| t19-1 | `unpublishedWatchIssues` resolves the real origin PR branch and inspects its entire unpublished range before an unattended push. Missing/diverged remote heads fail closed. Recorded test counts also retain a prior reduction when no test-named file changed. Per-turn `followUp.integrity` still describes that turn alone. Unit replay makes a CI-tampering turn, then an honest documentation turn: neither is pushed, and the local bare origin is unchanged. A separate test removes a non-test-named count input, then makes an honest change; the reduced count remains blocked. Watch rearm checks this range before reporting green or launching another fix. Chrome replay with `FAKE_CI_TAMPER=workflow` verified Needs you, unchanged origin, no additional agent turn after Watch again/new comments, and the same result after server restart. Restoring CI removes the net workflow warning. |
| t19-4 | Consecutive `pollFailures` are persisted with the watch and rebuild bounded retry backoff after restart. Successful polling clears the streak; Stop and unrelated manual Needs you states do not retry. Legacy snapshots with the exact generated failure detail migrate their count. Chrome saw three offline polls, Needs you, a real server restart, and automatic recovery to green in the open browser. New-watch polling does not inherit a previous quiet timer, and stopping during a poll prevents dispatch. |
| t19-5, S08-6 | The one-time log, class description, GitHub docs and architecture docs now describe conversation comments, review summaries and inline comments accurately. Location/side/thread/outdated context remains fenced, author allow-list protection remains, and at least 1,000 inline comments hand back for complete human review. Tests cover allowed `bob` versus ignored `mallory`, outdated location, the bounded history, and the actual recorded fake-agent prompt. The docs explicitly say resolved-thread state is not checked by the REST comment watcher. |
| t19-14 | Observing MERGED through result delivery, PR status or polling records the existing idempotent merge entry and closes the watch. The UI hides the watch on a recorded merged result and the API refuses rearm with 409. A closed, unmerged watch retains Watch again so reopening on GitHub is recoverable; the next poll still checks the PR state before doing work. Chrome closed/reopened a fake PR, then marked it externally merged; one merge badge appeared and Watch again disappeared. Reload tests retain exactly one merge record. No merge or cleanup is performed by the observation path. |
| t19-15 | Most fixes keeps raw input, exposes an inline validation message and `aria-invalid`, and disables Watch for blank, 0, negative, fractional and over-10 input. The API preserves the submitted value; engine validation accepts only numeric integers 1–10, with 3 only when omitted. Chrome preserves each invalid value, and direct API checks return 400 for invalid numeric values, strings and null without replacing a watch. |
| t19-6 | Evidence dedupe uses a SHA-256 fingerprint of the included paths and Git blob IDs, including the notes file, rather than the branch commit. Old saved commit markers compare their actual included content for upgrade compatibility. New PR bodies, existing PR publishing and source-PR pushes share this behavior; failed comments remain retryable. Unit tests cover source pushes, unchanged images across source commits, changed notes, legacy markers and comment failure/retry. Chrome captured actual scratch-run screenshots, published them, made an unrelated commit without another comment, refreshed the capture/notes and observed exactly one new evidence comment. Links remain pinned to committed blobs. |
| t19-16, S04-6 | Capture guidance now requires a capture/evidence request. Negative cases include video-player controls, video-upload/support work, screenshot-button/export crashes and showing a flow diagram; positive cases include attaching a video to the PR, adding screenshots to the PR, capturing screenshots/recording and explicit visual evidence. Bare media vocabulary no longer requests capture. |
| t19-7, S11-4 | Council posting captures the review object and source before awaiting GitHub. Already posted reviews return their URL idempotently; concurrent requests for the same review share one operation. Failures clear the claim for retry. A replacement review is not marked posted by an older request, and its concurrent post is refused until the old one finishes. Chrome opened the confirmation in two tabs before either posted, confirmed both, then repeated the API request: exactly one comment existed. Unit cases cover simultaneous calls, sequential repeats, permission failure/retry and review replacement during the request. |

Validation on the final source:

- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/watch-final-units-home node --import tsx --test test/qa-github-pr-watch.test.ts test/visual-evidence.test.ts test/github.test.ts test/github-review.test.ts test/qa-review-diff-comments.test.ts`: **42/42 passed**, including 11 new focused regressions. Log: `/private/tmp/codeflow-qa-continue/watch-targeted-final.log`.
- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/watch-e2e-outer-home node --import tsx --test test/e2e/qa-github-pr-watch.e2e.ts`: **7/7 passed** in real headless Chrome against a built isolated server on 4359. Log: `/private/tmp/codeflow-qa-continue/watch-e2e-final.log`.
- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/watch-tsc-home npx tsc --noEmit` and `git diff --check`: **passed**.
- Browser/server evidence: `/private/tmp/codeflow-qa-github-pr-watch/output/playwright/qa-github-pr-watch/`. Screenshots include `invalid-watch-limit.png`, `external-merge.png`, `offline-needs-you.png`, `recovered-after-restart.png`, `blocked-after-rearm-restart.png`, `inline-follow-through.png`, `council-two-tabs.png`, and `evidence-published.png`. `browser.json` has zero unexpected errors; its separate expected list contains only connection failures during the two deliberate restart windows. `server.log` records startup/shutdown and the standard Node SQLite warning, with no unexpected application errors.

Server and GitHub activity used disposable homes/tokens, fake agents and fake `gh`; Git pushes went only to local scratch bare repositories. The browser fixture was removed and its server stopped. An earlier combined unit command omitted an outer `CODEFLOW_HOME`; although the new tests set isolated homes themselves, the existing `visual-evidence.test.ts` has static product imports and could initialize default process tracking. This invocation was reported to the parent; no live home was inspected or repaired. The final commands above all used explicit scratch outer homes.

No product issue from this cluster remains unresolved. Live GitHub behavior was represented by the local fixture; no real GitHub writes, user repositories or live CodeFlow servers were used.

## Issues

### t19-1 · major · PR watch pushes a previously blocked test/CI-tampering fix after 'Watch again', then reports CI green

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-14, GH-13.

**Repro**

> 1. Start a fake-mode QA server with CODEFLOW_WATCH_INTERVAL_MS=5000 and FAKE_CI_TAMPER=workflow exported; scratch clone of MQTT-MCP (has .github/workflows/ci.yml) with fake-gh PR #103 (failOn "all").
> 2. Use template 'Fix failing CI' on PR #103, check 'true', Start run; when done, Actions -> Push to PR #103.
> 3. Follow through -> Watch PR (Most fixes 3). Watch becomes 'Needs you · codex's fix changes tests (CI workflow changed); not pushed — review it'. origin branch unchanged; local run branch now has commit 'codex: fix failing CI (f1)' that comments out the CI test job.
> 4. Restart the server without FAKE_CI_TAMPER (a normal fixer). Click 'Watch again' (no other action).
> 5. Next poll: a normal fix commit is made and pushed. Inspect origin: git log/diff of the PR branch.

**Expected:** A fix that was blocked for touching tests/CI is never pushed without explicit review; Watch again should refuse or warn while the blocked commit is still on the branch (or reset it), and the push guard should cover everything being pushed, not only the latest follow-up.

**Actual:** The push includes the earlier blocked commit: origin PR branch shows c4c0c4a 'fix failing CI (f1)' with .github/workflows/ci.yml cut from ~239 lines to a stub (CI test job removed), plus later fixes; on PR #104 repro the watch then showed 'CI green · All checks pass'. Evidence: t19b runs 2610251706-348dcde3 (PR 103 head c2315b7 includes c4c0c4a) and 2610251708-16bb2ec9 (PR 104 a308d2f includes 890e3d9; diff a9a4e8f..feature/draft-work: ci.yml 239 +---).

**Root cause (verifier):** The push guard covers only the current follow-up's delta, but the push sends the whole local branch tip.
- src/engine.ts:5810 records `before` as the worktree HEAD at the start of this follow-up. When a blocked fix is already on the branch, `before` is that blocked commit.
- src/engine.ts:5888: `const issues = sha && f.kind !== "resolve-conflicts" ? await ctx.testChanges(wt, before) : []` checks only before..HEAD, so the earlier blocked commit's ci.yml change is outside the range.
- src/engine.ts:5899: `const blocked = !!f.watch && issues.length > 0` is therefore false for the honest follow-up.
- src/engine.ts:5903: `pushBranch(run.repo, wt.branch, f.push!)` (src/github.ts:456 does `git push origin refs/heads/<local>:refs/heads/<remote>`) pushes every unpushed commit, including the blocked one.
- src/engine.ts:4602-4631 (watchPr): "Watch again" creates a fresh watch (fixes 0, fixedHeads [] at :4622). It never checks whether the local branch is ahead of the PR head with commits that were blocked or that change tests. Nothing records that a blocked commit is pending review.
- src/watch.ts:191: `synced` only checks that the PR head is an ancestor of the local branch. A local branch th …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/watch.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/follow-through.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** 1. Guard the range that is actually pushed. In runFollowUpInWorktree, before an unattended push (f.watch set), resolve what the remote already has: `git ls-remote origin refs/heads/<f.push>` or the watch's last seen headRefOid. Run `ctx.testChanges(wt, remoteHead)` over remoteHead..HEAD and block when that range has issues, not only before..HEAD. Fall back to the current check, plus an "unverified" issue, if the remote head can't be resolved. Keep using f.integrity for this follow-up's own report, and put the full-range issues in the needs-you detail so the user sees that the blocked commit is still on the branch.
2. Record the block. When a watch fix is blocked, store the blocked commit on the watch (for example `watch.blockedCommit = sha`).
3. Re-arm safely. In watchPr (engine.ts ~4602), when the local branch is ahead of the PR head with test or CI changes (or a recorded blockedCommit is still an ancestor of the branch), refuse with a clear message such as "This branch has an unpushe …

**Suggested regression test:** In test/follow-through.test.ts, add "a CI fix blocked for changing CI isn't pushed later by the next, honest fix":
- Use newRepo() and a solo run with the existing CHECK.
- Send a ci-fix followUp with FAKE_CI_TAMPER=workflow, push:"feature", watch: wt.branch. Assert pushError matches /changes tests/ and that origin has no "feature" branch.
- Unset the env and send a second honest ci-fix followUp with the same push and watch. Assert `second.pushed === undefined`, that second.pushError (or the wat …

<details><summary>Verifier's independent reproduction</summary>

Reproduced on a fresh fake-mode QA server, v4633w on port 4633, with CODEFLOW_WATCH_INTERVAL_MS=5000 and FAKE_CI_TAMPER=workflow exported.
1. Made a scratch bare clone of MQTT-MCP and a working clone. Pushed branch feature/qa-watch (212be4f) and refs/pull/104/head to the scratch origin. Fake gh PR #104 had headRefName feature/qa-watch, author me/OWNER and failOn=[212be4f].
2. In the UI: Open another repository, then Create project. Applied the "Fix failing CI" template on #104, set check `true`, then Start run. Run 2610252251-2bc5efb0 finished (done/passed).
3. In the UI: Actions, then Push to PR #104, then confirmed. Origin went to 10cdfa6, which I added to failOn so CI fails on it. Clicked Watch PR with Most fixes 3. The watch went to "Needs you · codex's fix changes tests (CI workflow changed); not pushed — review it". Origin stayed at 10cdfa6. The local run branch gained 18f5cea "codex: fix failing CI (f1)", which cuts .github/workflows/ci.yml by 236 lines (239 +---) to a stub with the test job commented out.
4. Restarted the server without FAKE_CI_TAMPER and clicked "Watch again" with no other action. No toast and no warning appeared.
5. On the next poll the watch showed "Pushed a fix (45d401a8); waiting for CI", then "CI green · All checks pass · CI: 2 ✓ · 0 ✕". On origin, `git log feature/qa-watch` = 45d401a (f2), 18f5cea (f1, the blocked fix), 10cdfa6… and `git diff --stat 10cdfa6 feature/qa-watch` shows .github/workflows/ci.yml 239 +---. The run log shows the engine knew: right after the blocked fix it logged "Result: changes to tests to look at before merging: .github/workflows/ci.yml: CI workflow changed", then pushed anyway.
6. Engine-level check: I added a throwaway test in my snapshot (builds/v4633w) that sends a FAKE_CI_TAMPER=workflow ci-fix follow-up (blocked) and then an honest ci-fix follow-up with push:"feature". The second fix had integrity undefined and pushed=3ba79ed. Origin's ci.yml was the stub, so the test asserting nothing reached origin failed.

Why it isn't by design or an environment effect: docs/github.md (Follow-through) and docs/patterns.md say "a fix that touches the tests at all isn't pushed … It's handed back to you instead". No doc or UI copy says Watch again accepts a blocked fix. The Watch again button gives no warning. The fake tamper agent and the restart only stand in for a nondeterministic agent whose next fix is honest.

Cleanup: stopped the watch and deleted the run in the UI, stopped server v4633w (ports 4633/4 …

</details>

### t19-4 · minor · PR watch stuck in 'Needs you' forever after a server restart even when gh recovers

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-16.

**Repro**

> 1. Fake server with CODEFLOW_WATCH_INTERVAL_MS=5000; run with an opened PR; Follow through -> Watch PR; wait for 'CI green'.
> 2. Set fake-gh state failAll='HTTP 503: Service Unavailable'; wait ~20s -> 'Needs you · Couldn't check the PR 3 times in a row'.
> 3. qa-server.sh restart <name>; remove failAll.
> 4. Wait 90-100s on the run page.

**Expected:** Docs (github.md 'Can't check'): it keeps retrying and goes back to watching once gh answers again — also after a restart.

**Actual:** Watch never polls again; stays 'Needs you · Couldn't check the PR 3 times in a row: … 503' with the old 'checked' time (runs 2610251655-0f5c68ce, 2610251622-f6da8d1d). Without a restart recovery works (~7s).

**Root cause (verifier):** src/watch.ts:61 — `failing` is an in-memory Map (commented "forgotten on restart"), and nothing about poll failures is persisted on the PrWatch: the PrWatch interface at src/engine.ts:644-663 has no failure field. src/watch.ts:139-147 (pollFailed) persists only state "needs-you", detail and lastPolled. After a restart the watch loads from disk as state "needs-you" and `this.failing.get(key)` is undefined at src/watch.ts:96. As a result, `retrying = watch.state === "needs-you" && !!failing` (src/watch.ts:98) is false. Because "needs-you" is not in ACTIVE (src/watch.ts:6), the check at src/watch.ts:99 treats the watch as inactive, skips it with `continue` on every tick, and never polls it again. A poll-failure needs-you cannot be told apart from a terminal needs-you, such as "CI still fails after N fixes", once the process restarts.

**Files:** `src/watch.ts`, `src/engine.ts`, `test/github.test.ts`

**Suggested fix:** Persist the failure streak on the watch so the retry state survives a restart. This was verified in a snapshot copy.
1) In src/engine.ts, add `pollFailures?: number` to the PrWatch interface, documented as polls in a row that failed and kept so a restart keeps retrying.
2) In src/watch.ts pollFailed, include `pollFailures: count` in both updateWatch calls (the needs-you one and the plain detail one).
3) In src/watch.ts pollAll, when `this.failing` has no entry and `watch.state === "needs-you" && watch.pollFailures`, seed it with `{ count: watch.pollFailures, nextAt: 0, error: watch.detail }` before computing `retrying`. nextAt 0 means one retry on the first tick after startup, then the normal backoff from the restored count.
4) After a successful poll (next to `this.failing.delete(key)`), clear it with `updateWatch(..., { pollFailures: undefined })`. A later terminal needs-you from pollOne (fix limit reached, foreign commits, etc.) is then not retried.
watchPr ("Watch again") already c …

**Suggested regression test:** Add a test to test/github.test.ts next to "a PR watch whose polls keep failing says why, needs you after three, and recovers on its own":
- Start a pipeline run, open the PR and call watchPr.
- Set fake-gh state failAll="HTTP 503: Service Unavailable".
- Drive a dedicated `new PrWatcher(manager, hour)` with poll(), poll(now+hour) and poll(now+3h). Assert state is "needs-you" and the detail matches /3 times in a row: .*503/.
- Clear failAll and call `await first.stop()`.
- Construct a second `new …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4639 on 127.0.0.1:4639 with CODEFLOW_WATCH_INTERVAL_MS=5000 exported. I checked that the env var reached the server process with `ps eww`, and re-exported it for the restart. The old v4639 home was moved aside first.
1. Made a scratch clone of MQTT-MCP (bare and working copy under qa/clones/v4639-mqtt) and added it through the UI with "Open another repository" and "Create project".
2. Started a fake run from the composer with check `true`. Run 2610252250-0f4a29ec finished: done, passed.
3. Used "Push & open PR" in the UI, which opened fake PR #1. Clicked "Watch PR" in the UI. The panel showed "CI green · All checks pass".
4. Set fake-gh.json failAll="HTTP 503: Service Unavailable" and polled /api/runs/<id> every second. The failures came at +19s (1 time), +23s (2 times) and +33s, when the state became needs-you with "Couldn't check the PR 3 times in a row: gh pr view failed: HTTP 503". lastPolled was 22:51:46.
5. Ran `qa-server.sh restart v4639` (interval still 5000), removed failAll and monitored for 100s, about 20 watch ticks. The state stayed needs-you and lastPolled stayed at 22:51:46, so no poll ever happened. After another ~20s in the browser the watch panel still read "Needs you · Couldn't check the PR 3 times in a row … 503 · checked 11:51:46 PM", with a "Watch again" button. On the same page the PR card fetched fresh status ("PR #1 is ready to merge · GitHub checks: Passed"), so gh was answering again; only the watch was stuck.
6. Control without a restart: clicked "Watch again" (back to green), set failAll again (needs-you after 17s), then cleared it with no restart. The watch went back to "green · All checks pass" 20s later, which matches the 5s × 2² backoff. So recovery works only within one process.
7. Unit-level confirmation in my snapshot copy (qa/builds/v4639). I added a test to test/github.test.ts that drives one PrWatcher to needs-you with failAll 503, then builds a new PrWatcher on the same manager (empty in-memory maps, as after a restart), clears the failure and polls at +10h and +20h. Result: "not ok 2 … error: 'the restarted watcher polls the PR again'" (lastPolled unchanged). The existing test "a PR watch whose polls keep failing … recovers on its own" passes, because it uses a single watcher instance. With the candidate fix applied, both tests pass.
Why it is not by design: docs/github.md:107 ("It keeps retrying, and goes back to watching once gh answers again") and the class comment at src/watch.ts:45-46 …

</details>

### t19-5 · minor · Watch log and docs say inline review comments aren't read, but they are forwarded to the agent and fixed/pushed

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-15.

**Repro**

> 1. Watch PR on a result PR (fake gh). 2. Add an inline review comment by the gh user to the PR (fake state prs[N].inlineComments with path README.md, line 3). 3. Wait for the next poll; read the run log and the follow-up prompt.

**Expected:** Either inline comments are not acted on (as the log/docs say) or the log/docs say they are.

**Actual:** Log: 'Watching …: line comments on the diff (review threads) aren't read yet; only PR comments and review summaries reach the agent'. Yet the inline comment produced 'Addressing 1 new comment from @me' and the prompt contained 'File: README.md:3 (right side) / Thread: review-thread:9001 / INLINE: …', and the fix was pushed (run 2610251655-0f5c68ce).

**Root cause (verifier):** The reading code was updated but the text around it was not.

- src/github.ts:258-294 (`prStatus`) pages through `repos/{owner}/{repo}/pulls/N/comments` (up to 10×100). Each line comment becomes a PrComment with path, line, side, `threadId: review-thread:<root>`, replyTo and outdated.
- src/watch.ts:176-214 treats these like any other comment: they go through the same allow-list filter, and the follow-up message adds `File: path:line (side) [outdated diff]` and `Thread: …` inside the data fence (lines 199-202). src/watch.ts:161 also hands the watch back to you ("needs-you") at 1,000+ line comments.

These places still describe the old behaviour:
- src/watch.ts:173 logs once per watch: "line comments on the diff (review threads) aren't read yet; only PR comments and review summaries reach the agent".
- src/watch.ts:53-54, the PrWatcher class comment, says the same.
- docs/github.md:104: "Line comments on the diff aren't read yet; the run's log says so when watching starts."
- docs/architecture.md:150 lists "Read PR line comments (review threads)…" under "What's next".
- test/github-review.test.ts:149 asserts the stale log line ("said once per watch"), so the test suite locks the wro …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/watch.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/architecture.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/github-review.test.ts`

**Suggested fix:** Make the text match the code, and decide on purpose whether line comments should be acted on.

1. Remove or rewrite the one-time log at src/watch.ts:172-174. If kept, it could say: "Watching <pr>: PR comments, review summaries and line comments on the diff (with file and line) from you and allowed users go to the agent; a thread's resolved state isn't checked." The comment block at src/watch.ts:53-54 should say the same. Also mention the 1,000-comment hand-back.
2. docs/github.md:104: replace the sentence with one that says line comments on the diff are read too. They are passed with their file, line, side and thread, are marked when on an outdated diff, and a PR with 1,000+ line comments goes to Needs you. Note that resolving a thread on GitHub does not stop the watch acting on a new reply in it, because the watcher reads REST comments, not GraphQL resolution state.
3. docs/architecture.md:150: remove the "Read PR line comments" item from "What's next".
4. Optional: if the product doe …

**Suggested regression test:** In test/github-review.test.ts, replace the assertion at line 149. It should assert that no log entry matches /aren't read yet/, or that the start-of-watch log mentions line comments.

Then add a watcher test that sets the fake gh state `s.prs[1].inlineComments = [{ id: 9001, user: { login: "me" }, author_association: "OWNER", body: "fix this", created_at: <after startedAt>, path: "README.md", line: 3, side: "RIGHT" }]` and calls `watcher.poll()` with a stub manager that records `followUp` calls. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (home homes/v4641t195, port 4641, exported CODEFLOW_WATCH_INTERVAL_MS=5000) and checked that the server process had that env var. I made a bare clone and a working clone of MQTT-MCP at clones/v4641t195-mqtt(.git) and added the working clone as a project through the UI ("Open another repository", then "Create project").

1. In the UI I started a solo run, 2610252251-a737eb5b ("Add a one-line note to README.md…", check `test -f README.md`). It is a chat run, so it left an uncommitted file. As a setup step only, I committed it with git on the run's branch inside the scratch clone. The UI says "Ask the agent in chat to commit…", so this is expected.
2. I opened the PR in the UI (More options > Review local changes > Publish changes > Open PR… > Push & open PR). Fake gh created PR #1 with base main.
3. I clicked "Watch PR" in the same panel. The first poll went green with seenComments=[]. The run log, seq 19 of runs/2610252251-a737eb5b.jsonl, says: "Watching https://github.com/o/r/pull/1: line comments on the diff (review threads) aren't read yet; only PR comments and review summaries reach the agent".
4. To stand in for a reviewer on GitHub, I added this to fake-gh.json: prs["1"].inlineComments=[{id:9001,user:{login:"me"},author_association:"OWNER",body:"INLINE: please rename…",created_at:now,path:"claude-7338c9ec.txt",line:1,side:"RIGHT",pull_request_review_id:77}].
5. Within about 1s the next poll set the watch to "fixing | Addressing 1 new comment from @me". followUps[0] was kind "comments" with message "@me:\n```text\nFile: claude-7338c9ec.txt:1 (right side)\n\nThread: review-thread:9001\n\nINLINE: please rename this note to mqtt-note.txt\n```". The log then has "Committed 06db6eed … address review comments (f1)" and "Pushed 06db6eed to codeflow/2610252251-a737eb5b/solo", and the bare origin had 06db6ee. The watch panel showed "Watching | Pushed a fix (06db6eed); waiting for CI | 1/3 fixes". There were no console or API errors.

So the code does what the reporter described: the log and the docs say line comments aren't read, yet a line comment was read, sent to the agent, fixed and pushed. It is not by design. Commit daf3108 deliberately added inline-comment reading to prStatus, the location/thread formatting in watch.ts, and the "needs-you" state when there are 1,000+ comments. The older text from 7a593cc (the log line and the doc sentence) was never updated. It is not caused by the environment either: fake gh only plays …

</details>

### S08-6 · minor · The watch log says 'line comments on the diff (review threads) aren't read yet' (docs/github.md:104 agrees), but prStatus now fetches inline review comments and pollOne forwards their path/line/thread to the agent, so the message is stale and misleading.

Source: code-level suspect at `src/watch.ts:173` (confirmed hands-on).

**Repro**

> Focused test test/qa-s08-watch.test.ts in snapshot builds/s08: fake gh PR #1 with an inline comment from 'me' {path:'src/app.ts', line:12, side:'RIGHT'} made after the watch started. One PrWatcher.poll logged "Watching …: line comments on the diff (review threads) aren't read yet; only PR comments and review summaries reach the agent". In the same poll it sent a follow-up whose message contained 'File: src/app.ts:12 (right side)', 'Thread: review-thread:501' and 'Rename this variable'. End-to-end on the s08 server, starting Watch PR through the UI wrote the same stale line to runs/<id>.jsonl.

**Expected:** The log and docs say that inline review comments from the user and allowed people are read and forwarded with file/line/thread context, the same as PR comments.

**Actual:** Users are told that line comments are ignored. In fact they trigger unattended fixes that are committed and pushed to the PR, which matters because users may leave line comments thinking they are inert.

**Root cause (verifier):** prStatus (src/github.ts:273-292) now pages through `repos/{owner}/{repo}/pulls/<n>/comments` and returns inline comments with path/line/side/threadId. pollOne treats them like other comments, and the follow-up message includes 'File: <path>:<line>' and 'Thread: …'. The one-time log line in pollOne, the class doc comment (watch.ts:53-54), docs/github.md:104 and the assertion in test/github-review.test.ts:149 were not updated.

**Suggested fix:** Remove or rewrite the one-time log line, for example 'Watching <pr>: PR comments, review summaries and line comments from you … reach the agent'. Update the PrWatcher doc comment and docs/github.md:104. Update the stale assertion in test/github-review.test.ts:149.

**Suggested regression test:** In test/github-review.test.ts, add an inline comment to fake gh state and assert the follow-up message includes the File/Thread location. Also assert no logged line matches /aren't read yet/.

### t19-14 · minor · PR merged/closed outside code-flow leaves inconsistent state: merge not recorded, watch still offered, closed watch can't be restarted after reopen

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-08, GH-13.

**Repro**

> 1. Open a PR from a result (PR #111); mark it MERGED in fake gh. 2. Merge PR… panel says 'PR #111 is merged into main' but no merge button; GET run -> merges []. 3. Follow through still offers Watch PR; it goes 'PR closed · The pull request was merged'. 4. Separately: watch PR #122, set CLOSED -> 'PR closed'; set OPEN again -> no Watch again button.

**Expected:** Externally merged PR recorded as merged (docs: 'one already merged on GitHub is recorded as merged'); watch hidden for merged PRs; a closed watch can be restarted if the PR is reopened.

**Actual:** run.merges stays [] (run 2610251642-3fdeb262), watch panel offered on merged PR, and on 2610251655-0f5c68ce the panel shows only 'PR closed' with no way to watch again.

**Root cause (verifier):** The merge is recorded in only one place, src/engine.ts:4499 recordPrMerge, which is private. It is called only from mergePr (src/engine.ts:4468-4472 for the "already merged" case, and 4492) and mergeResultPr (4443), and both run only when the user clicks a merge button.
- In the UI, PrMergePanel renders the merge button only when the PR is open (ui/run.tsx:1429 `const open = info?.state === "OPEN"`, button inside `{open ? …}`). Once GitHub reports MERGED, mergePr's already-merged branch can't be reached from the UI. So the docs line "one already merged on GitHub is recorded as merged" only holds in the race where the PR merges between loading the panel and clicking.
- Three code paths see MERGED and record nothing: resultDelivery (src/engine.ts:4389-4408, prDelivery returns "PR #N merged / Archive run"), prMergeInfo(id, branch) (src/engine.ts:4448, used by GET /pr-merge at src/server.ts:2685), and the PR watcher. At src/watch.ts:158-160 the watcher sees status.state === "MERGED" and only calls updateWatch({state: "closed", detail: "The pull request was merged"}), not recordPrMerge.
- Because run.merges stays empty, the guard at ui/run.tsx:1091 (`!merged.some((m) => m.pr === pr)`) k …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/watch.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/github.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** 1. Record merges whenever code-flow sees one. In src/engine.ts add a public, idempotent `notePrState(run, branch, pr: PrMergeInfo)` that calls recordPrMerge when `pr.state === "MERGED"` and `pr.url === run.prs[branch]`. recordPrMerge is already deduplicated by PR url, and it already closes an open watch with "The pull request was merged". Call it from resultDelivery after prMergeInfo, and from prMergeInfo(id, branch); use require(id) for the change and skip remote or read-only projections. In src/watch.ts:158, when status.state === "MERGED", get prMergeInfo for baseRefName and mergeCommit and call the new method instead of only closing the watch. This also makes the docs sentence true.
2. Once merges are recorded, ui/run.tsx:1091 hides WatchPanel for merged PRs on its own. Also make watchPr refuse a PR GitHub reports as MERGED ("PR #N is already merged; nothing to follow through") or CLOSED ("Reopen it on GitHub first"); this means watchPr has to become async around prMergeInfo.
3. Reo …

**Suggested regression test:** In test/github.test.ts, extend "a watch stops when the PR is merged or closed": after setState PR MERGED and watcher.poll(), assert `live.merges.length === 1`, `live.merges[0].pr === url` and `live.merges[0].into === "main"`, and that a second poll doesn't add a duplicate.
Add "an externally merged PR is recorded when its status is read": open a PR with manager.pullRequest, setState MERGED with mergeCommit, call manager.resultDelivery(run.id, branch) and manager.prMergeInfo(run.id, branch), then …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4659t1914 on 127.0.0.1:4659 (CODEFLOW_WATCH_INTERVAL_MS=5000, fake gh state in homes/v4659t1914/fake-gh.json). Scratch clone of MQTT-MCP (bare origin + working clone) added through the UI ("Open another repository" -> Create project). I ran two "Upgrade a dependency" (Plan -> Build -> Review) runs from the UI, 2610252303-8ef91c0a and 2610252305-9e06714a; that pattern commits its result. Two earlier Agent-mode runs left their changes uncommitted, so publishing was blocked with "Ask the agent in chat to commit these changes before publishing". For each run I used Review changes -> Publish changes -> Open PR… -> Push & open PR, which opened PR #1 and PR #2.
(1) External merge: I made a merge commit of PR #1's head into main in the scratch bare origin (15fd885b) and set the fake-gh PR #1 to state MERGED with that mergeCommit. On the run page the primary card says "PR #1 merged · The changes are in main · Archive run". Details and publishing -> Merge PR… shows "PR #1 is merged into main." with no "Merge PR #1" button (count 0). GET /api/runs/<id> gives merges: []. The project list row for that run shows "PR open".
(2) The Follow through panel is still offered ("Watch PR"). Clicking it gives "PR closed | The pull request was merged | 0/3 fixes", and merges is still [] afterwards.
(3) PR #2: clicked Watch PR, which showed "CI green | All checks pass". I set PR #2 to CLOSED; about 15s later the watch was "closed | The pull request was closed". I then set PR #2 back to OPEN and waited 20s or more and reloaded. The Merge PR panel shows "Merge PR #2" and /delivery says "PR #2 is ready to merge", but the watch panel still says only "PR closed | The pull request was closed …" with no "Watch again" button and no agent picker (screenshot shots/v4659t1914/003-pr2-reopened.png).
Diagnostic: POST /api/runs/<id>/watch with {branch, agent: "codex"} restarts the watch (state watching, then green), so the backend allows it and only the UI hides it. No console errors or 5xx during any step.

</details>

### t19-15 · minor · 'Most fixes' silently coerces 0 to 3 and >10 to 10

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-13.

**Repro**

> 1. Follow through row: type 0 in Most fixes, Watch PR -> watch shows '0/3 fixes'. 2. Stop, type 25, Watch again -> '0/10 fixes'.

**Expected:** Validation feedback (min 1, max 10) instead of silent substitution.

**Actual:** 0 becomes 3, 25 becomes 10 without any message.

**Root cause (verifier):** ui/run.tsx:1285 - onInput={(e) => setMaxFixes(Number(e.currentTarget.value) || 3)} turns 0 and empty into 3. Because the stored value was already 3, the component doesn't redraw and the field keeps showing '0' while 3 is what gets sent. The Watch PR onClick (ui/run.tsx:1288-1299) sends maxFixes without checking it; min/max only set the browser's invalid state, which is never shown because there is no form submit or reportValidity(). src/server.ts:2729 - maxFixes: Number(body.maxFixes) || undefined also treats 0 as missing (defaults to 3). src/engine.ts:4618 - maxFixes: Math.min(10, Math.max(1, Math.round(input.maxFixes ?? 3))) silently changes out-of-range values (25 -> 10, -1 -> 1, 2.5 -> 3) instead of rejecting them, and no response tells the UI the value was changed.

**Files:** `ui/run.tsx`, `src/server.ts`, `src/engine.ts`, `test/github.test.ts`, `test/e2e/result-delivery.e2e.ts`

**Suggested fix:** UI (ui/run.tsx WatchPanel ~1253/1285/1288): keep the typed text as-is (useState(String(watch?.maxFixes ?? 3)), onInput={e => setMaxFixes(e.currentTarget.value)}). Compute n = Number(raw) and fixesValid = Number.isInteger(n) && n >= 1 && n <= 10. Set aria-invalid={!fixesValid} on the input, show <p class="msg err" role="alert">Choose 1–10 fixes.</p> when invalid (same pattern as the follow-up budget at ui/run.tsx:1945), disable the Watch PR / Watch again button while invalid, and send maxFixes: n. Server: in src/server.ts:2729 pass undefined only when body.maxFixes is absent, otherwise pass Number(body.maxFixes). In src/engine.ts:4618 replace the silent clamp with validation: if maxFixes is given and is not a whole number from 1 to 10, throw Error('Most fixes must be a whole number from 1 to 10') (attempt() turns it into a 4xx the UI shows as a toast); keep the default of 3 when it is missing. Optionally mention the 1–10 range in docs/github.md Follow-through ('Stops: after the number o …

**Suggested regression test:** test/github.test.ts: next to the existing watchPr test at ~line 265, assert.throws(() => manager.watchPr(run.id, { branch, agent: 'claude', maxFixes: 0 }), /1 to 10/), and the same for 25, -1 and 2.5; assert that watchPr with maxFixes omitted gives watch.maxFixes === 3 and that maxFixes: 10 is kept as 10. Browser test in test/e2e/result-delivery.e2e.ts (or code-hosts.e2e.ts), on a fake-gh PR: fill the 'Most fixes' spinbutton with '0' and expect an alert with 'Choose 1–10', the field marked aria- …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server 'v4661t1915' on 127.0.0.1:4661 (CODEFLOW_WATCH_INTERVAL_MS=5000), fresh home. Created a throwaway scratch repo (local bare origin, since removed) and added it through the UI ('Open another repository' -> 'Open this repository' -> 'Create project'). Started a solo fake run 2610252259-6913624d ('Add a line to README.md saying hello', check 'test -f README.md'). The fake agent leaves its file uncommitted, so I committed it in the run's scratch worktree as a precondition. Then Review changes -> Publish changes -> Actions -> Open PR... -> 'Push & open PR' created fake-gh PR #1 and the Follow through row appeared. A Playwright script (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4661/t1915-watch.mjs) filled the 'Most fixes' spinbutton, clicked Watch PR / Watch again, and recorded the POST /api/runs/:id/watch body, toasts, the panel text and the server's watch state. Results: typed 0 -> input validity=false ('Value must be greater than or equal to 1.') but nothing shown on screen; POST sent maxFixes:3 while the field still displayed '0'; panel '0/3 fixes'; server maxFixes=3; no toast. Stop, then typed 25 -> validity=false ('<= 10'); POST sent maxFixes:25; panel '0/10 fixes'; server maxFixes=10; no toast. Extra cases: -1 -> sent -1 -> server 1 ('0/1 fixes'), so it is inconsistent with 0 -> 3; 2.5 -> sent 2.5 -> server 3; empty -> field resets to 3 -> 3. Screenshots 001-typed-0.png and 004-watching-25.png show no invalid styling or message, only the normal focus ring. No console errors or 5xx responses. Not by design: the input's own min=1/max=10 declares the range; docs/github.md (Follow-through) only says the watch stops 'after the number of fixes you allow'; no code comment or test documents clamping, and no e2e covers Watch PR. The follow-up budget inputs (ui/run.tsx:1834/1945) already validate inline and block Send, so this panel is the odd one out. Cleanup: stopped the watch and deleted the run through the UI (0 runs left), stopped the server (ports 4661/4662 free), removed the scratch clone, its bare origin and the seed folder.

</details>

### t19-6 · minor · Each push to a source PR re-posts the same unchanged visual-evidence comment

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-10, GH-12.

**Repro**

> 1. Run from PR #104; commit .codeflow/evidence/x.png + README.md on the result branch; Actions -> Push to PR #104 -> evidence comment posted. 2. Add an unrelated commit (no evidence change); Push to PR again. 3. Repeat once more.

**Expected:** No new evidence comment when the evidence files did not change (docs: no duplicate on re-push).

**Actual:** A new '## Visual evidence' comment with identical images (only the pinned SHA differs) is added on every push; PR #104 had 3 evidence comments.

**Root cause (verifier):** src/engine.ts:4574-4575 (pushToPr): the dedupe key is the pushed commit, `run.visualEvidencePosted?.[input.branch] !== sha`, and that same `sha` is what gets stored. Meanwhile src/visual-evidence.ts:11-29 (visualEvidenceFiles) always diffs `run.baseRef..head` (the run's start), not the last published state. So after any new commit the evidence set is still non-empty (the files differ from the run's base) and the head SHA has changed. The guard passes and an identical comment is posted, with only the pinned SHA in the links different.

The same flaw is in pullRequest() for an already-open PR: src/engine.ts:4541 compares `run.visualEvidencePosted?.[branch] !== visual.head` and :4546 stores `visual.head`. Re-publishing an existing code-flow PR after an unrelated commit would also re-post.

The blob ids needed for a content-based key are already read and then thrown away: the ls-tree regex at src/visual-evidence.ts:21 matches `blob [a-f0-9]+` without capturing it, and VisualEvidenceFile (line 8) has no oid field.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/visual-evidence.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/github.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/visual-evidence.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** Key the deduplication on what the evidence contains, not on the commit:
1. In visualEvidenceFiles, capture the blob oid in the ls-tree regex (`blob ([a-f0-9]+)`), add `oid` to VisualEvidenceFile, and return a `fingerprint`: a stable hash or join of the sorted `path:oid` pairs of the files actually included (media, capped at 8, plus notes).
2. In pushToPr (engine.ts:4574-4575), post only when `visualBody && sha === visual.head && run.visualEvidencePosted?.[branch] !== visual.fingerprint`, and store `visual.fingerprint` after a successful comment. Keep the current failure behaviour: nothing is recorded if the comment fails, so the next push retries.
3. In pullRequest (engine.ts:4541/4546), use the same fingerprint check for existing PRs. Recording the fingerprint after a new PR's body embed then also stops a later push with unchanged evidence from commenting.
4. Backward compatibility: a stored value that is a 40/64-hex commit comes from the old SHA keying. Either accept one extra commen …

**Suggested regression test:** Extend test/github.test.ts, "requested screenshots and recordings are included in new PRs and existing PR evidence comments" (around lines 586-605). After the first pushToPr (comments.length === 1), commit an unrelated file (e.g. `writeFileSync(join(tree.path, "NOTES.md"), "x")` and commit), call `localManager.pushToPr(newRun.id, { branch: tree.branch })`, and `assert.equal(state().prs[number].comments.length, 1, "a push that leaves the evidence files unchanged does not repeat the evidence comme …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4643ev" on port 4643 (new home, fake gh). I made a scratch bare clone of MQTT-MCP and a working clone of it, and added a branch feature/evidence-work plus refs/pull/104/head. fake-gh.json had one open, non-draft PR #104 (head feature/evidence-work, base main). I added the clone as a project through the UI ("Open another repository"), then used composer -> GitHub -> Pull requests -> #104, wrote a task, set check "true" and pressed Send. Run 2610252251-139ed40a finished in fake mode (baseRef 8ab4f59, branch codeflow/2610252251-139ed40a/solo).

In the run worktree I committed .codeflow/evidence/x.png (a 1x1 PNG) and .codeflow/evidence/README.md, plus the fake agent's leftover file, so the card no longer said "uncommitted changes".

Push 1 (UI: Review changes -> Publish changes -> Actions -> Push to PR #104 -> Push changes): toast "Pushed to PR #104". PR #104 had 1 '## Visual evidence' comment pinned to 4ed696a. visualEvidencePosted = 4ed696a. This one is expected.

I then committed an unrelated change to PR_NOTES.md (no evidence change) and pushed the same way. PR #104 had 2 comments, the new one identical except that it pins b0c6f0e.

I did it again with another unrelated commit: 3 comments, the third pinning 7929c78. git ls-tree shows the evidence blobs are the same at all three heads (README.md b0d3f46..., x.png ff9895b...).

Control: retrying POST /api/runs/:id/push-pr with no new commit (same head) added no comment (still 3). Only a new commit with unchanged evidence causes the duplicate.

No console or 5xx errors. Cleanup: I deleted the run through the UI (bulk Delete) and stopped the server with qa-server.sh stop; ports 4643/4644 are free. I removed the scratch clones clones/v4643ev-mqtt(.git), which also removed the run's kept worktree and branches. Leftover: the home dir homes/v4643ev (logs, fake-gh.json, project entry) and screenshots in shots/v4643ev.

Not by design: docs/github.md:75-81 says "A push to an existing source PR adds an evidence comment. Links reference the published commit." That does not say every push must re-post the same evidence. The same section says only "new or changed" screenshots are published and tells users to "refresh captures after changing the tested flow". The existing test (test/github.test.ts:593, "retrying the same push does not duplicate the evidence comment") shows deduplication was intended, but it only covers a retry at the same SHA. One correction to the report: the docs do not liter …

</details>

### t19-16 · minor · Any task mentioning 'video' gets visual-evidence capture guidance in agent prompts

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-12.

**Repro**

> 1. Fix & review task 'Fix the video player controls so that pause works on the dashboard.' 2. Inspect recorded builder/proof prompts; compare with 'Add a short hello note file.'

**Expected:** Evidence guidance only when screenshots/recordings are requested (docs: ordinary repairs don't add visual tests).

**Actual:** Builder, proof and later follow-up prompts contain '## Visual evidence when requested … .codeflow/evidence/…' (rec codex-1792947325815, codex-1792947326476); control task had none.

**Root cause (verifier):** src/visual-evidence.ts:6 `wantsVisualEvidence = (text) => /\b(screenshots?|screen[ -]?record(?:ing)?|visual (?:test|evidence)|record(?:ing)? (?:the |this |a )?(?:flow|demo|browser)|video)\b/i.test(text)` matches the bare nouns "video" and "screenshot(s)" anywhere in the text, with no request verb around them, so a task about a video player or a screenshot feature counts as a request for evidence. src/engine.ts:2445 joins run.task, every note text and every follow-up message, and appends "## Visual evidence when requested\n" + VISUAL_EVIDENCE_GUIDANCE to the prompt of every write-mode, non-receipt ask: builder, proof turn and later follow-ups. So once the task contains the word, the guidance stays in every later write turn of the run. The guidance text (src/visual-evidence.ts:4) is itself conditional ("If the user asks for..."), which limits the damage. Effects: wasted prompt tokens, and a risk that agents capture or commit unrequested .codeflow/evidence/ files or run browser tests. That contradicts docs/github.md:77. The existing unit test (test/visual-evidence.test.ts:35-38) has only one negative case, so the false positive went unnoticed.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/visual-evidence.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/visual-evidence.test.ts`

**Suggested fix:** Only match "video" and "screenshot" when they appear as a request for evidence, not as a word for something in the product. Remove bare `video` from the alternation. Match media nouns only after a capture or attach verb, or before an evidence context word. For example: `\b(?:attach|add|include|capture|take|record|provide|share|post|show)\b[^.\n]{0,40}\b(?:screenshots?|screen ?recordings?|videos?|recordings?)\b`, or `\b(?:screenshots?|videos?|recordings?)\b[^.\n]{0,30}\b(?:of (?:the|this) (?:flow|change|fix|ui)|to the (?:pr|pull request)|as (?:evidence|proof))\b`. Keep the explicit phrases already there: "visual test", "visual evidence", "screen recording", "record the flow/demo/browser". Optionally narrow engine.ts:2445 to check only user-authored text (task and follow-up messages), so agent- or system-generated note text cannot trigger it.

**Suggested regression test:** Extend test/visual-evidence.test.ts ("visual capture guidance is only added for relevant chat requests").
- Expect false for "Fix the video player controls so that pause works on the dashboard.", "Add video upload support to the API" and "Fix the screenshot export endpoint crash".
- Expect true for "Attach a short video of the flow to the PR", "Add screenshots of the new dialog to the PR", "Test this flow and attach screenshots and a short screen recording to the PR" and "Add visual evidence".
- …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4663 on port 4663, started with FAKE_RECORD_DIR=/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/rec so the fake CLIs record each prompt. The runs directory was empty at the start. I made a scratch clone of MQTT-MCP and added it as project p-fe02d617 through the UI (Open another repository, then Create project). Both runs were started through the composer (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/v3-start.mjs). Each used Run options, then Advanced, then workflow "fix-review" (Fix & review), with "Done when this passes" set to `true`.
(1) Task "Fix the video player controls so that pause works on the dashboard." became run 2610252300-8cecff0b and finished done. Recorded prompts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/rec-video:
- codex-1792969257635-41ad05.json (builder) contains "## Visual evidence when requested\nIf the user asks for screenshots, a screen recording or visual test evidence ... .codeflow/evidence/ ...".
- codex-1792969258328-ace7f9.json (fail-to-pass proof turn) contains the same section.
- claude-1792969258939-24d529.json (reviewer, read-only) does not.
(2) Control task "Add a short hello note file." became run 2610252301-d93e055d with the same workflow and settings. None of its 3 recorded prompts (rec-control/) contain the section.
I also tested the regex in node. It returns true for "Add video upload support to the API" and "Fix the screenshot export endpoint crash", false for "Fix videos list pagination", and true for real requests such as "attach screenshots and a short screen recording".
Not by design: docs/github.md:75-77 ("Visual evidence, on request ... ordinary backend repairs do not add visual tests automatically") says the guidance is for explicit requests, and test/visual-evidence.test.ts:35 is named "visual capture guidance is only added for relevant chat requests". This is not caused by the environment either: injection is deterministic string matching in the engine and does not depend on the agent or the browser profile.
Cleanup: both runs deleted through the UI (More run actions, then Delete…), server v4663 stopped, scratch clones v4663-mqtt and v4663-mqtt.git removed. Deleting the runs did NOT remove their worktrees or branches in th …

</details>

### S04-6 · minor · wantsVisualEvidence matches the bare word 'video', so any write task mentioning video (for example 'fix the video player') gets screenshot and recording instructions added to its prompt.

Source: code-level suspect at `src/visual-evidence.ts:6` (confirmed hands-on).

**Repro**

> Fake server s04 started with FAKE_RECORD_DIR=work/s04/rec. Through the UI I started a Claude Code Agent chat with the task 'Fix the video player so it resumes from the last position'. The recorded rec/claude-*.json prompt had the section at index 771 (work/s04/video.mjs). Separate probe: a scratch tsx test calling wantsVisualEvidence in builds/s04.

**Expected:** Tasks that only mention videos or screenshots as product features, such as 'Fix the video player', 'Add a video upload endpoint' or 'The screenshot button crashes', do not get the 'Visual evidence when requested' section.

**Actual:** The recorded fake Claude prompt for the Agent chat 'Fix the video player so it resumes from the last position' contained '## Visual evidence when requested' followed by VISUAL_EVIDENCE_GUIDANCE. A probe returned true for 'Add a video upload endpoint' and 'The screenshot button crashes' as well, and false for 'Fix the dependency update and run unit tests'.

**Root cause (verifier):** The regex alternation contains bare `video` and `screenshots?` with no request verb, and engine.ts:2445 applies it to the task plus all notes and follow-up messages for every write-mode ask. docs/github.md:75-77 says visual evidence is added 'on request' and 'ordinary backend repairs do not add visual tests automatically'. Impact is limited because the appended guidance is itself conditional ('If the user asks for screenshots…'), but it adds about 1.1 KB to every write prompt and may push agents to capture evidence nobody asked for.

**Suggested fix:** Require an explicit request: for example a capture/attach/record/take/include/add/provide/with verb near (screenshots?|screen recording|recording|video), or the phrases 'visual (test|evidence)' and 'record (the|a) (flow|demo|browser)'. Drop the bare `video` and noun-only `screenshot` matches.

**Suggested regression test:** Extend test/visual-evidence.test.ts with negatives ('Fix the video player so it resumes', 'Add a video upload endpoint', 'The screenshot button crashes'), keeping the existing positives ('attach screenshots and a short screen recording', 'Add visual evidence', 'record a video of the flow').

### t19-7 · minor · Council review can be posted to the PR repeatedly (no idempotency guard)

Source: tester unit github-codehosts-imports-1; observed with api; features GH-11.

**Repro**

> 1. Review a PR as a council on PR #104; Post to PR #104 in the UI. 2. POST /api/runs/<id>/post-review twice (or click Post in two tabs opened before posting).

**Expected:** Second post is refused or a no-op once review.postedTo is set.

**Actual:** Each call returns 200 and adds another identical '**Review council: Changes requested**' comment (4 on PR #104).

**Root cause (verifier):** src/engine.ts:4586-4596 RunManager.postReview checks only that run.review exists (4588) and that source.kind is "pr" (4589). It then calls commentOnPr at 4590, sets run.review.postedTo and postedAt afterwards (4591-4592), and never reads postedTo beforehand. There is also no in-flight guard, so two concurrent calls both pass the checks before either await finishes.

src/github.ts:331-333 commentOnPr always runs `gh pr comment` and appends CODEFLOW_MARKER. It never looks for an existing code-flow comment or updates one.

src/server.ts:2717-2718 passes POST /runs/:id/post-review straight through to postReview.

The UI guard is only cosmetic. The onClick closure at ui/run.tsx:964-975 posts after confirmAction resolves even if the run has since been posted, because it never re-checks the latest run.review.postedTo.

Secondary issue: postedTo is written to run.review after the await. If setReview replaced the review during the await, the new, unposted review would be marked as posted.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/github.test.ts`

**Suggested fix:** Make postReview in src/engine.ts idempotent per review.

1. Capture `const review = run.review` before any await.
2. If review.postedTo is already set, refuse with `throw new RunConflictError(`This review is already posted to ${review.postedTo}`)`. attempt() in src/server.ts maps RunConflictError to 409. Alternatively, return review.postedTo without posting again.
3. Add an in-flight map such as `private reviewPosts = new Map<string, Promise<string>>()` keyed by run id. Check it and set it synchronously before `await commentOnPr`. A concurrent second call then awaits or returns the same promise, or gets a 409, instead of posting again. Delete the entry in `finally`.
4. After the await, set postedTo and postedAt on the captured `review` object, not on run.review. If the review was replaced meanwhile, the new review is then not marked as posted.

UI change in ui/run.tsx: the existing catch already shows the server error as a toast, so tab B would show "already posted". Optionally, after  …

**Suggested regression test:** Extend the test "start from a PR: a review council reviews its changes; posting is your call" in test/github.test.ts. After the existing `await manager.postReview(run.id)`:
1. Add `await assert.rejects(manager.postReview(run.id), /already posted/)`. If the fix chooses idempotent return, assert that the call returns the same URL instead.
2. Assert that state().prs[1].comments.length is still 2: the existing discussion comment plus one review.

Add a concurrency case on a fresh council run, or aft …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4645 on port 4645. I moved the old v4645 home aside to homes/v4645-prev-* so the server ran with an empty home. I made a scratch bare origin and clone, clones/v4645-pr(.git), with main and feature-104, and pushed feature-104 to refs/pull/104/head. I seeded homes/v4645/fake-gh.json with an open PR #104 that had no comments. As a precondition, I used POST /api/runs to start pattern "council" with source {kind:"pr",number:104}, reviewers claude+codex and chair claude. Run 2610252252-e8c9cae1 finished with verdict changes_requested and review.postedTo unset.

UI path (Playwright script work/v4645/post-ui.mjs): I opened two tabs on #/run/<id> and expanded "Details and publishing" in both. Both tabs showed "Post to PR #104". In tab B I clicked Post, which opened the "Post review to GitHub?" dialog, and left it unconfirmed. In tab A I clicked Post and confirmed. That gave 1 comment, and both tabs updated live to the green "Posted to PR #104" badge. Screenshot shots/v4645/B-dialog-open-after-A-posted.png shows the badge behind tab B's still-open dialog. I then confirmed in tab B. That gave 2 comments. Tab B gave no warning and still showed only the badge.

API path: two more POST /api/runs/<id>/post-review calls both returned 200 {"url":"https://github.com/o/r/pull/104"}.

Final state: fake-gh PR #104 had 4 identical comments, each starting "**Review council: Changes requested** — 2 reviewers (claude, codex)". The browser collected no console or 5xx errors.

Refutation checks:
- Docs say otherwise. docs/github.md:96 says "**Post to PR #N** posts the review as a comment, and only when you click it", and the UI (ui/run.tsx:955-981) swaps the button for a one-shot "Posted to PR #N" badge. So a repeat post is not by design.
- The only intended repost is after the review changes. setReview (src/engine.ts:1511-1514) clears postedTo when the markdown differs.
- The cause is not the tester's environment. The fake gh simply appends whatever `gh pr comment` sends, and the real gh does the same.
- An idle stale tab does not trigger it, because a live update replaces the button. The UI paths are a confirm dialog opened before another tab or device posts, concurrent clicks, or a tab that lost its live connection. The direct API path always duplicates.

</details>

### S11-4 · minor · postReview has no idempotency guard; calling POST /api/runs/:id/post-review twice posts duplicate PR comments because only the UI hides the button once review.postedTo is set.

Source: code-level suspect at `src/engine.ts:4586` (confirmed hands-on).

**Repro**

> Fake mode: a council run started from PR #1 on scratch repo s11-alpha (fake gh). I opened the run in two browser tabs and expanded 'Details and publishing'. Clicking 'Post to PR #1' in both tabs opened a confirm dialog in each. Confirming tab 1 gave 1 comment on PR #1 (tab 1 shows the 'Posted to PR #1' badge). Tab 2's dialog was still open; confirming it gave 2 comments. A further POST /api/runs/<id>/post-review, sent after review.postedTo was already set, returned 200 {url} and produced 3 identical comments in the fake gh state. Screenshot: shots/s11/002-council-after-post.png.

**Expected:** The review is posted once. Later requests are refused (409 'already posted to …') unless an explicit re-post is requested, and concurrent requests do not both post.

**Actual:** Each request posts another identical comment on the PR.

**Root cause (verifier):** RunManager.postReview checks only that a review exists and that the source is a PR. It never checks run.review.postedTo or an in-flight flag before calling commentOnPr, so every request posts again. The UI guard (hide the button once postedTo is set, disable it while its own request is busy) is per-tab and does not cover requests that are already confirmed.

**Suggested fix:** In postReview: if run.review.postedTo === run.source.url, throw RunConflictError('This review was already posted to …'), with an optional explicit `repost` flag. Set a per-run in-flight marker (or a pending postedTo) before awaiting commentOnPr and clear it on failure, so concurrent calls are serialized and rejected. The route already maps RunConflictError to 409.

**Suggested regression test:** Server/engine test with fake gh: post-review twice gives a 200 then a 409, and prs['1'].comments.length === 1. Two posts via Promise.all give exactly one comment.
