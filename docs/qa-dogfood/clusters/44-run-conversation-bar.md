# Cluster 44 · run-conversation-bar

**Run page conversation bar & message rendering: markdown, notes, drafts, toasts, provider names**

Status: **fixed and independently replayed** · 10 issues · branch `codex/qa-run-conversation-bar`

Planner notes: inline() in ui/bits.tsx: file:// links are not matched (t04-17), and bold spans are not tokenized again, so inline code inside bold shows ** (t06-14). The user's task text is rendered as markdown, so __init__.py turns bold (t26-11, BrowserMessage in ui/browser-context-cards.tsx); render user text literally or with code-safe rules. ConversationBar (ui/run.tsx ~1765-2005): notes that were never delivered vanish after the run finishes (t06-10); reply drafts live only in a module Map and sessionStorage, so persist them per run in localStorage (t05-14); there is no pre-check for a signed-out provider, and the failed turn leaves the run 'Finished' with no recovery bar (t05-15); the same error is shown three times (t05-16; also finalText on is_error in src/adapters/claude.ts); 'Request a fix' appends the paragraph again on every click (t07-14, ui/run.tsx:225). Toasts use raw provider ids and fixed plurals (t04-15/t06-15); use the display-name map (SHORT in ui/lib.ts) and a plural helper. Duplicate groups: [["t04-15","t06-15"]]

Likely files: `ui/run.tsx`, `ui/bits.tsx`, `ui/browser-context-cards.tsx`, `ui/lib.ts`, `ui/state.ts`, `ui/composer.tsx`, `ui/projects.tsx`, `src/engine.ts`, `src/adapters/claude.ts`, `ui/styles.css`

## Repair outcome (2026-10-26)

All ten entries were replayed on the continuation code. This branch starts at integrated `0f5dea2` and includes cluster 43's shared draft commits `526318f` and `7316351` as `2887910` and `fbb4d50`. The latter fixes a migration omission found during this independent review. All test/build/app commands used an explicit scratch `CODEFLOW_HOME`; only fresh temporary repositories, private browser profiles, fake providers, and OS-allocated loopback ports were used. No live home, live build, live port 4317/4318, or real remote was used.

| Entry | Root repair and observed outcome |
| --- | --- |
| t04-17 | The Markdown tokenizer recognizes local file/path targets, renders their inline labels, and preserves the decoded target on hover. It grants navigation only to HTTP(S); unsafe schemes remain raw text. A fake provider's file links render cleanly in the actual conversation. |
| t06-14 | Already repaired in the integrated baseline. New unit cases and an original Fix & review run verify nested code, including `broken-*.txt`, inside bold. No headline-specific workaround was added. |
| t26-11 | `BrowserMessage` renders user text literally with preserved whitespace, so both the task and later replies copy exactly, including dunders and typed Markdown symbols. Agent Markdown also preserves dunder identifiers and avoids emphasis inside words. |
| t06-10 | Undelivered notes remain visible above the reply box with their text and a restore action that preserves existing draft text. Repeat restoration adds no second copy. Terminal workflows without an available reply box still show the note and explain that resuming enables sending. The original final-reviewer scenario and reload were verified. |
| t05-14 | Shared message draft storage from cluster 43 persists text and screenshots together, scopes them to this computer/run, migrates legacy session text before editing, and durably records successful-send clearing. New-tab, browser restart, legacy migration, cross-tab warning/reload, and no-resurrection-after-send cases pass. Reply entry, queued pins, and provider handoff wait for hydration; read failures preserve unread stored data. |
| t04-15, t06-15 | Note toasts/chips and usage tooltips use provider display names. Composer, resume, recovery, and follow-up allowances use singular calls/steps where applicable; the engine's one-step stop reason is singular. Real Codex steering and a queued Claude Code note exercise both paths. |
| t05-15 | Local reply diagnostics show a sign-in warning, provider settings link, and Recheck action. A soft warning preserves the documented retry path when diagnostics are stale. Worker/container credentials are not inferred from local health. Failed follow-ups now say to send another reply; the reply box makes the latest failure visible while the earlier conversation remains completed. A real fake-provider failure followed by a successful retry passes. The original expectation that any failed reply must change the whole conversation status was already refuted by the verifier and remains intentionally unchanged. |
| t05-16 | The Claude adapter omits only final text equal to the failed result's error, preserving genuine partial answers. The UI also suppresses echoed error answers in older stored turns and avoids repeating the same error in the recovery bar. The real auth-failure page shows the raw CLI error once, with recovery controls; Show work retains the diagnostic transcript. |
| t07-14 | Prepared feedback is appended only if it is not already in the current draft. Repeated Request a fix clicks focus the existing request, preserve user notes, survive reload, and dispatch nothing until Send. |

### Validation and independent comparison

- Final `npx tsc --noEmit` and `git diff --check` passed.
- 47 focused unit/adapter/UI tests passed, including new `test/qa-run-conversation-bar.test.ts` and cluster 43's draft tests. Security controls cover unsafe link schemes, raw HTML, quoted errors, retained partial answers, local-vs-worker diagnostics, and missing screenshot references.
- All 10 real Chrome/server cases in new `test/e2e/qa-run-conversation-bar.e2e.ts` passed. Provider binaries and all repository mutations are isolated fixtures. Screenshots were visually checked for literal messages, readable undelivered notes, and a single error with separate recovery controls.
- 7 original browser cases passed: the repository/run/review/merge setup and live Codex steering cases in `ui.e2e.ts`; workflow setup and failed-check recovery in `ux-flows.e2e.ts`; and all three `agent-mode.e2e.ts` provider-tab/side-chat/archive cases. Existing test updates only reflect intended behavior: the Codex display name, local link labels rather than raw source, and waiting for durable draft hydration before reading its value, and disabling Node’s process-owning BroadcastChannel in the unit browser stand-in (real cross-tab messaging is covered in Chrome).
- Independent replay on detached pre-repair `0f5dea2` confirmed file-link presentation, missing undelivered notes, raw provider labels, absent reply auth guidance, echoed auth answers, singular-count errors, and new-tab draft loss. The strengthened repeat-click repro independently failed with two copies instead of one after waiting for the draft consumer to refocus the box. The existing bold/code repair passed on the baseline, as expected.
- Initial fixture-only failures were corrected rather than treated as product defects: the fake Claude answer wrapper needed the actual `-p` CLI flag; the usage tooltip lives inside Details and publishing; follow-up failure is published before the enclosing execution settles; and original UX cases need their setup case. The original agent-mode draft read initially raced the newly asynchronous, visibly disabled hydration state; waiting for enabled confirmed all stored content survives.
- Final browser host logs contain no unexpected exceptions; page error capture is empty. Screenshot and log evidence is under `/private/tmp/codeflow-qa-continue/conversation44-final-browser/`, with test logs `/private/tmp/codeflow-qa-continue/conversation44-{final-unit,final-browser,baseline,baseline-repeat,original-ui,original-ux-pair,original-agent-final,migration}.log`. The independent baseline checkout was removed after replay.

No unresolved cluster 44 issue remains. Broader provider diagnostics and process shutdown reasons remain in cluster 45; preview snapshot capture and lifecycle remain in cluster 43.

## Issues

### t04-17 · cosmetic · Antigravity answers with file:// Markdown links render as raw '[`file`](file:///…)' text

Source: tester unit solo-runs-providers-1; observed with real-agents; features SOL-02.

**Repro**

> Real Agent run with Antigravity creating a file; agy replies with [`t04-agy.txt`](file:///…/t04-agy.txt).

**Expected:** Link text shown (link disabled or opened in Files) instead of raw Markdown.

**Actual:** Thread shows '[ t04-agy.txt ](file:///private/tmp/…/t04-agy.txt)' literally (shots/t04/002-r5-agy-done.png, run 2610251427-c65bce0a both turns).

**Root cause (verifier):** The cause is ui/bits.tsx:170, the tokenizer regex in inline(). Its only link alternative is `\[[^\]]+\]\(https?:\/\/[^\s)]+\)`, and ui/bits.tsx:173 matches the same pattern. A `[label](file:///…)` link, or any path target, never becomes a token. The split then finds only the `` `label` `` code span inside it, so the output is "[" + <code>label</code> + "](file:///…)", with the whole absolute worktree path shown inline. Markdown is applied at ui/run.tsx:772 (TurnBody), and also to task and follow-up bubbles and side chats.

Why this is not by-design: the http(s)-only rule comes from security hardening commit 7a593cc (#19). Its comment at ui/bits.tsx:43-44 and its test at test/ui-review.test.ts:98-113 are about keeping javascript:/data:/vbscript: from becoming clickable. That test does pin "[rel](/etc/passwd)" as "left as text" (line 110), so raw text for non-http targets is a deliberate safe fallback. But no doc or comment considers that agents habitually write file links to their own output files. Antigravity does it every time, and the result is an unreadable answer. That is a UX gap, not an intended presentation.

Severity stays cosmetic: nothing is lost (file name and path are v …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`

**Suggested fix:** In ui/bits.tsx inline(), tokenize any `[label](target)` where the target has no whitespace or ')', then branch on the target:

(a) http(s): keep the current <a target=_blank rel=noreferrer>, but render the label through inline() so code labels become <code>.

(b) file:// URLs and plain paths (absolute, relative, or with a :line suffix): show only the label, inline-parsed, as text, with title={decoded path} so the target can still be seen on hover. Never create an href.

(c) Any other scheme (javascript:, data:, vbscript:, …): keep today's raw-text fallback, so the security test still holds for those.

Optional enhancement: Markdown takes an optional `root` prop (the run's worktree). TurnBody at ui/run.tsx:772 and the follow-up and side-chat bubbles pass it. A file target that resolves inside that root becomes a <button class="md-file"> calling openFile(root, relativePath) from ui/state.ts:147, which opens the Files tab. Anything outside the root stays plain label text.

Also update the …

**Suggested regression test:** Add a test to test/ui-review.test.ts next to "Markdown: only http(s) links become links", using its rendered() helper. Name: "Markdown: file links show their label, not their source".

- rendered("Created [`t04-agy.txt`](file:///private/tmp/x/.worktrees/r/solo/t04-agy.txt) and [b.txt](file:///tmp/b.txt) and [c.ts](src/c.ts:12)").
- Assert there is no <a> element.
- Assert out.text does not contain "](" or "file://".
- Assert out.text contains "t04-agy.txt", "b.txt" and "c.ts".
- Assert a <code>  …

<details><summary>Verifier's independent reproduction</summary>

I used QA identity v4603, the scratch clone /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4603-mqtt (from MQTT-MCP), and a fresh browser profile each time.

(1) Unit check against my snapshot (builds/v4603/v4603-md-probe.mjs). I bundled ui/bits.tsx and called markdownNodes:
- "[`t04-agy.txt`](file:///…/t04-agy.txt)" gives <p>"I have created the file [" <code>t04-agy.txt</code> "](file:///…/t04-agy.txt) at …"</p>. There is no <a>, and the brackets and target stay as text.
- A plain label, "[t04-agy.txt](file:///…)", also stays fully raw.
- Relative and absolute path links, `[src/a.ts](src/a.ts)` and `[a.ts](/Users/x/a.ts:12)`, stay raw too.
- Side finding: "[`a.ts`](https://…)" becomes a link whose text is "`a.ts`" with the backticks shown, because link labels are not inline-parsed.

(2) Fake-mode server on 4603 (work/v4603/k1-fake.mjs). I added the repo through "Open another repository" and picked the project in the Choose project dialog. Fake agy refused to start because isolated Antigravity needs a native Keychain login, so I used the default Claude Code provider; the task bubble renders through the same Markdown component either way. The task text contained "[`v4603-agy.txt`](file:///private/tmp/v4603/…/v4603-agy.txt) and [plain](file:///private/tmp/v4603/x.txt)". In run 2610251839-ed3dbe51 the bubble's .md innerHTML was "… see [<code>v4603-agy.txt</code>](file:///…) and [plain](file:///…)." with 0 links. Screenshot: shots/v4603/003-k1-fake-thread.png.

(3) Real-mode server on 4603, one real agy run (work/v4603/k2-real.mjs). Settings: Antigravity CLI, Gemini 3.8 Flash (Low), Approve for me, Antigravity execution native. I used the reporter's prompt: "Create a file named v4603-agy.txt at the repository root containing the single line `agy native`. Do not run tests and do not commit." Run 2610251840-a062e8a5 finished in 12s. Its answer, in .turn-body .md, rendered literally as "Created [v4603-agy.txt](file:///private/tmp/claude-501/…/clones/v4603-mqtt/.worktrees/2610251840-a062e8a5/solo/v4603-agy.txt) at the repository root …", with 0 <a> elements and no console or 5xx errors. Screenshot: shots/v4603/001-k2-real-agy-done.png. This matches the reporter's shots/t04/002-r5-agy-done.png.

So agy writes file:// Markdown links on its own, with or without a code label, and they always show as raw source. Nothing in the tester's environment or selectors causes this.

</details>

### t06-14 · cosmetic · Bold text containing inline code renders with literal ** or backticks in run summaries

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-09.

**Repro**

> 1. Run Fix & review with check 'true' (or 'sleep 3; ! ls broken-*.txt'). 2. Read the Team answer line.

**Expected:** 'Approved, and <code>true</code> passes' in bold.

**Actual:** Shows 'Approved, and `true` passes' (literal backticks) or '**Approved, and sleep 3; … passes**' (literal asterisks when the command contains '*'); also 'Check `echo …; false` still fails…'.

**Root cause (verifier):** Two parts of inline() in ui/bits.tsx combine to cause this:
- **Line 172:** a matched bold span is rendered as `<b>{part.slice(2, -2)}</b>`, which is a plain string. It is never passed through inline() again, so a code span inside bold stays as literal backticks.
- **Line 170:** the bold alternative of the split regex is `\*\*[^*]+\*\*`. When the inner code span contains `*` (a glob like `broken-*.txt`), `[^*]+` cannot reach the closing `**`, so bold fails to match at all. The code alternative then matches further along, leaving the `**` markers as literal text.

The text that triggers it comes from:
- src/patterns/pipeline.ts:173-176, which builds the headline with \`${check.command}\`. Line 179 wraps that headline in `**…**`. This is shared by Fix & review (fix-review.ts uses runPipeline) and the pipeline pattern.
- src/patterns/solo.ts:53, `**Changes on \`${wt.branch}\`**`, which hits every Agent run that makes changes.
- Agent-written Markdown such as `**\`file.ts\`**` in thread messages.

src/patterns/loop.ts:215 is not involved.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`

**Suggested fix:** Fix the renderer, not the headline strings, because agent-written Markdown nests code in bold too. Two changes in ui/bits.tsx inline():
1. Let the bold alternative contain whole code spans, using only non-capturing groups so split() does not emit extra pieces: `\*\*(?:\`[^\`]+\`|[^*\`])+\*\*`. The `__` form can get the same treatment if wanted.
2. Render the inner text recursively: `<b key={i}>{inline(part.slice(2, -2))}</b>`. Italics can do the same.

I tested this regex in a JS copy of the split. It gives `<b>Approved, and <code>sleep 1; ! ls broken-*.txt</code> passes</b>` and `<b>Changes on <code>codeflow/x/claude</code></b>`. Plain cases are unchanged: `**high** \`src/a.ts\``, `\`**not bold**\`` (stays code) and `\`a*b\``.

Raw HTML stays text: inline() only ever builds b, code, a and i elements, so the existing HTML-safety test still holds.

The other option, moving the command outside the bold in pipeline.ts and solo.ts, would only fix those two headlines.

**Suggested regression test:** In test/ui-review.test.ts, add a test next to the existing Markdown tests that uses the rendered() helper, called something like "Markdown: inline code inside bold". Render three inputs:
- "**Approved, and `sleep 1; ! ls broken-*.txt` passes** — branch `codeflow/x/build`"
- "**Check `echo hi; false` still fails after 2 fix attempts**"
- "**Changes on `codeflow/x/claude`**"

For each, assert:
- there is a `b` element whose children include a `code` element with text "sleep 1; ! ls broken-*.txt" ( …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4663, port 4663) and opened it in my own headless Chrome profile. Through the UI I used "Open another repository" to add a scratch clone of MQTT-MCP as project "v4663 MQTT". For each run I opened Run options > Advanced, chose "Fix & review" in #workflow-select, typed the check into "Done when this passes" (#checkCmd), entered a task and clicked Start run. I waited for each run to finish, then read the innerHTML of the rendered ".md p" result line in the run's Team section and looked at the screenshots.
- Run A, check `true` (done, verdict passed). Raw result `**Approved, and \`true\` passes** — branch \`codeflow/…/build\``. Rendered `<b>Approved, and \`true\` passes</b> — branch <code>…</code>`: bold text with literal backticks (screenshot qa/shots/v4663/002-A-final.png).
- Run D, check `sleep 1; ! ls broken-*.txt` (done, passed). Rendered `**Approved, and <code>sleep 1; ! ls broken-*.txt</code> passes** — branch <code>…</code>`: literal `**` on both sides and no bold (screenshot qa/shots/v4663/002-D-final.png).
- Run F, check `echo still-broken; false` (done, failing). Rendered `<b>Check \`echo still-broken; false\` still fails after 2 fix attempts</b>`: literal backticks.
There were no console or API errors. I also ran a plain JS copy of the inline() split regex on the other headline templates. The Agent (solo) headline `**Changes on \`codeflow/x/claude\`**` also renders with literal backticks, so the bug is wider than Fix & review. The loop headline the reporter cited (`**Check passes** after …`) has no code inside the bold and is NOT affected.
It is not by design: the bits.tsx doc comment promises "inline bold, italics, code", and the pattern authors deliberately put code spans inside bold. Nothing depends on the tester's environment. I deleted all three runs through the run menu ("More run actions" > Delete… > Delete run), stopped server v4663 and removed my scratch clones (the bare repo and the working clone, which held the run worktrees and branches). Nothing is left over.

</details>

### t26-11 · minor · User task text is rendered as markdown, so code identifiers are altered (__init__.py shows as bold 'init.py')

Source: tester unit usability-failure-cases-2; observed with real-agents; features UX-21.

**Repro**

> 1. Send a task 'Update __init__.py so that __all__ lists snake_case names'.
> 2. Look at the task bubble on the run page.

**Expected:** The task appears exactly as typed (stored text is correct), or underscores inside identifiers are kept.

**Actual:** The bubble shows 'Update <b>init</b>.py so that <b>all</b> lists …'. Copying gives 'init.py'. A real run also displayed '__pycache__' as bold 'pycache'.

**Root cause (verifier):** Two causes combine:

1. ui/browser-context-cards.tsx:23-25: BrowserMessage, which renders the task bubble (ui/run.tsx:282, <BrowserMessage text={run.task} />), correction and follow-up notes (ui/run.tsx:821, 868, 908 via RunMessage) and side-chat messages (ui/side-chat.tsx:255, 451), passes the user's plain-text message to <Markdown text={message.text} />. Users type Python dunders such as __init__, __all__ and __pycache__ all the time, and Markdown turns them into emphasis.

2. ui/bits.tsx:170-172: inline() splits on `__[^_]+__` with no guards and renders any match as <b>{part.slice(2,-2)}</b>, which drops the underscores. Its own italic rule on the same line has (?<![\w_]) and (?![\w_]) guards, but the bold rule does not. So it even bolds inside words ("foo__bar__baz" becomes foo<b>bar</b>baz, unlike CommonMark), and it bolds a bare identifier like __init__ before ".py".

The stored task (run.task) and the agent prompt are unaffected; this is display only. But what the user sees, and copies, is a different file name.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser-context-cards.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Primary fix: show user-authored text verbatim. In ui/browser-context-cards.tsx BrowserMessage, render message.text as plain text with `white-space: pre-wrap` (for example <div class="user-text">{message.text}</div>, with a CSS rule on .run-task / .msg-you .bubble) instead of <Markdown>. Claude-style threads already show user messages this way. The one system-composed message that needs Markdown, PREVIEW_REQUEST, is already special-cased in RunMessage at ui/run.tsx:906-908 and can keep <Markdown>. If formatting typed tasks matters, a middle ground is to keep only fenced code blocks (``` sections become <pre>) and leave inline emphasis off for user text.

Defence in depth for agent output: in ui/bits.tsx inline(), give the strong-underscore rule the same word-boundary guards as the italic rule, e.g. `(?<![\w_])__(?=\S)[^_]+?(?<=\S)__(?![\w_])`. Also do not treat `__word__` as bold when the inner text is a single identifier (/^[A-Za-z0-9_]+$/): leave it as text, or render it as <code>. `* …

**Suggested regression test:** 1. In test/ui-review.test.ts, using the existing `rendered()` helper over m.markdownNodes, add a test such as "Markdown: dunder identifiers keep their underscores". Feed it "Update __init__.py so that __all__ lists snake_case names, remove __pycache__, call foo__bar__baz()" and assert:
   - out.text includes "__init__.py", "__all__", "__pycache__" and "foo__bar__baz";
   - no element has type "b";
   - rendered("__real bold__ and **bold**") still contains two "b" elements, so normal emphasis kee …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4657 on http://127.0.0.1:4657 (source dogfood-qa at f14f404), driven by a fresh, profile-less headless Chrome. I added a scratch bare and working clone of MQTT-MCP as a new project through the UI ("Open another repository", then "Create project"). In the composer I typed "Update __init__.py so that __all__ lists snake_case names" and clicked Send. The fake Claude run finished as 'done' (run 2610252330-4caf4561).
- GET /api/runs/<id> .task is exactly "Update __init__.py so that __all__ lists snake_case names", so the stored text and the text sent to the agent are both correct.
- The DOM of the bubble is <div class="md"><p>Update <b>init</b>.py so that <b>all</b> lists snake_case names</p></div>.
- The bubble's innerText, and a real Range selection over it (what a copy gets), are both "Update init.py so that all lists snake_case names".
- On the same screen (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4657/004-run.png), the page title, breadcrumb and sidebar show "__init__.py" correctly. The bubble just below them shows bold "init".py, so the page contradicts itself. Crop: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4657/bubble.png.
- A follow-up typed in the run composer, "Also delete the __pycache__ folders", renders as "Also delete the <b>pycache</b> folders", so every user-authored message is affected, not only the first task.
- No console, page or 5xx errors.

Ways I tried to refute it:
- Tester environment: not the cause. It reproduces with a fresh profile and in fake mode, so neither the real agent nor the tester's selector is involved.
- By design: I found no doc saying the user's own messages are Markdown. docs/runs.md:15 says only that the agent's messages are rendered as Markdown. The reference design is a "Claude-style run thread" (commit a87a47e), and that style shows user messages verbatim.
- "It's just correct Markdown": marked (CommonMark/GFM, in node_modules) also renders "__init__.py" as <strong>init</strong>.py. So this is not a parser bug in the strict sense. The problem is that plain-text user input goes through Markdown at all.
- CodeFlow's parser is also looser than CommonMark: I ran its exact regex in Node, and "call foo__bar__baz()" splits off "__bar__" as bold, while marked leaves it unchanged. That affects agent output too.

Cleanup: I d …

</details>

### t06-10 · minor · A note that was never delivered disappears from the run view after it finishes

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-16.

**Repro**

> 1. Fix & review run; while the final 'Review (round 1)' step runs, send a message To 'Next agent'. 2. Wait for the run to finish.

**Expected:** The run view marks the note as not delivered (with its text) so you can resend it.

**Actual:** Toast 'Queued for the next agent's turn'; after finishing the note chip is gone and the thread shows nothing; only a warning inside Details and publishing → Activity log (collapsed) says 'Your message didn't reach an agent…'. API: notes[2].status 'undelivered'.

**Root cause (verifier):** 1. ui/run.tsx:1922-1924 (ConversationBar). shownNotes, pendingNotes and sentNotes are computed, but they are only rendered under `running &&`: at :1947 (`running && sentNotes.length`) and :1951 (`running && pendingNotes.length`). When the run finishes (`running` becomes false), every note, including status "undelivered", disappears from the bar.

2. ui/run.tsx:1925-1938 (noteChip) has no branch for status "undelivered". If one were rendered it would wrongly read "Queued for next agent". ui/styles.css:1489-1492 styles only `.note-chip.delivered`.

3. The thread shows notes only under the step they reached (ui/run.tsx:854, `n.deliveredTo?.stepId === s.id`). An undelivered note has no `deliveredTo`, so it is shown nowhere in the thread, and ResultCard never looks at run.notes.

4. src/engine.ts:5567-5577 (endUndelivered) sets status "undelivered" and emits only a `log` warn event. That warning is shown only in the Activity log (ui/run.tsx:2241-2246), inside the collapsed "Details and publishing" section (ui/run.tsx:390), where it is counted together with unrelated warnings.

History: since #19 / eb4ae42, note chips have been gated on `running`, and finished-state rendering for undeliv …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Changes in ConversationBar (ui/run.tsx), for a finished run that is not a chat:

1. Compute `undelivered = run.notes.filter(n => n.status === "undelivered" && !answeredLater(n))`. One way to define `answeredLater`: a follow-up or child run was sent after `n.at`, so stale notes don't stay forever.
2. Render `undelivered` above the chatbox, not gated on `running`. Show a visible `.notes` row of chips labelled "Not delivered — the run finished first: “<text>”".
3. Give each chip a "Put in reply box" button that calls `setText(n.text)`, so the user can pick To and resend. A "Dismiss" button is optional.
4. Add an "undelivered" branch to noteChip so its label never says "Queued for…".
5. Add a `.note-chip.undelivered` style (warning tone) in ui/styles.css.

Optional: also mention the undelivered note in ResultCard, or count it separately in the Activity log summary. Update docs/runs.md:50 to say the run view shows the note as not delivered, with its text and a way to put it back in the repl …

**Suggested regression test:** Add a test in test/e2e/ui.e2e.ts (Playwright with fake agents), next to the existing "steer" test around line 255:
1. Start a fix-review or pipeline run with the final Claude review turn held open. Use FAKE_SLEEP_MS/FAKE_SLEEP_VENDOR=claude in the e2e server env, or a hold keyword.
2. While "Review (round 1)" is running, select To "Next agent" and send "Late note".
3. Wait for `.result-compact`.
4. Assert that `.convo .note-chip.undelivered` is visible, is not inside a closed `<details>`, and co …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4655t10" on 127.0.0.1:4655. It had a new home and was started with FAKE_SLEEP_MS=9000 and FAKE_SLEEP_VENDOR=claude, so the Claude reviewer turn stays open long enough to send a message. I made a scratch clone of MQTT-MCP (bare clone, then a working clone) and added it through the UI ("Open another repository", project "v4655 MQTT"). In the composer I chose the Fix & review workflow, check `true` and the "Approve for me" permission, then started the run (2610251922-01df1e9b).

1. While "Review (round 1)" was running, I chose To "Next agent", typed "Late note v4655: please also mention the license" and pressed Enter. The toast said "Queued for the next agent's turn" and the chip "Queued for next agent: Late note v4655…" showed above the reply box (screenshot shots/v4655t10/002-running-with-note.png).
2. About 9 s later the run finished with status done. The API returned notes=[{id:"n1", status:"undelivered", text:"Late note v4655…"}].
3. On the finished run view (shots/v4655t10/003-finished.png) the chip is gone. The thread, the result card and the reply box show nothing about the message, and the reply box defaults to "To Codex · build". `main.innerText` does not contain the note text, and `.note-chip` count is 0. Reloading in a fresh browser profile gives the same result (shots/v4655t10/001-fresh-reload.png).
4. Searching the DOM finds the text only inside closed `<details>`. The only place it can be seen is Details and publishing → Activity log (8) · 3 warnings, which shows "Your message didn't reach an agent: the run finished before another turn could take it. Reply to send it: “Late note v4655…”" (shots/v4655t10/004-activity-log.png). The summary line counts it as one of 3 generic warnings; the other two are "Not proven" lines.

No console errors or 5xx responses. The tester's environment did not cause this: I reproduced it on my own fresh server, with my own browser profile and a different project, on the first try.

Is it by design? Only in part. docs/runs.md:50 says that when the run finishes the note is "marked as not delivered and the log says so, with its text: reply to send it", and src/engine.ts:5562-5566 documents the log line as the channel. So the data status and the log line work as documented. But docs/runs.md:49 says "The run view shows each note as queued or delivered", and the UI has no rendering at all for status "undelivered". The run view shows the message as queued and then drops it without a trace. A warn …

</details>

### t05-14 · minor · Chat reply drafts are kept per browser tab only; a new tab or closing the tab loses them

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-21.

**Repro**

> 1. Open a finished chat run, type a draft in 'Message agent'.
> 2. Reload: the draft is kept.
> 3. Open the same run in a new tab (or close the tab and reopen it): the reply box is empty.

**Expected:** Reply drafts persist like composer drafts, which are kept per project across reloads and sessions, or the UI says drafts are per tab.

**Actual:** Drafts live in sessionStorage, plus an in-memory Map for images, so they vanish outside the original tab.

**Root cause (verifier):** The reply box (ConversationBar) keeps its draft in two places that only live in one browser tab:
- ui/run.tsx:1765 `const agentDrafts = new Map<string, { text; images }>()` is a module-level in-memory Map, gone on reload, in new tabs and on restart.
- ui/run.tsx:1766-1769 `savedAgentDraft(id)` falls back to `sessionStorage.getItem(\`agent-draft:${id}\`)` for the text only and always returns `images: []`.
- ui/run.tsx:1783 the effect writes only `text` to sessionStorage (`agent-draft:<runId>`); images go only into the Map.
sessionStorage is scoped to one top-level browsing context. It is copied only into tabs opened by window.open and lost when you type the URL in a new tab, when the browser or Electron desktop app restarts, or when a tab is opened from a bookmark or link. So the draft is empty in those cases. Browser-pin snapshots come through `chatDrafts`, an in-memory signal (ui/state.ts:135-142, taken by ui/run.tsx:1790-1793), so they are lost even on a same-tab reload. Introduced in 29628ea (2026-10-22, "Add desktop Agent and Team workspace with shared tools and durable recovery"). By contrast, composer drafts use the versioned IndexedDB/localStorage project store (ui/project-c …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/agent-mode.e2e.ts`

**Suggested fix:** Move reply-draft text out of sessionStorage into the workspace-scoped `store` (ui/lib.ts:101-118, localStorage under workspaceKey, which keeps the per-computer namespaces), keyed `agent-draft:<runId>`, following the review.tsx comment-draft pattern:
- Read with store.get in savedAgentDraft.
- Write or remove in the effect at run.tsx:1783.
- Add a `storage` listener so another window's edit refreshes the cached entry instead of being silently overwritten (last writer wins, as the composer documents).
- Migrate once: if sessionStorage has agent-draft:<id> and store does not, copy it over.
- Keep the existing behaviour of clearing the draft on send (text "" removes the key). Also remove it when the run is deleted, or prune entries older than a TTL as ui/file-drafts.ts does, so localStorage doesn't fill up with stale keys.
For images (Browser pin snapshots), either persist them alongside the text in the IndexedDB-backed project draft store (ProjectDraftStore in ui/project-context.ts, size- …

**Suggested regression test:** In test/e2e/agent-mode.e2e.ts, extend the existing "Keep this draft" scenario (around lines 53-62/101-102):
- After the reload assertion, open `const p2 = await context.newPage(); await p2.goto(<same run URL>)` and assert `await p2.getByRole("textbox", { name: "Message agent", exact: true }).inputValue() === "Keep this draft"`.
- In a second case, launch with `chromium.launchPersistentContext(tmpDir)`, fill the draft, close the context, relaunch on the same tmpDir and assert the same value.
- As …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4627 on 127.0.0.1:4627, with a new home and a persistent Playwright Chrome profile named "v4627". Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4627/ (a3-start.mjs, a4-drafts.mjs) and the output is in a4.log in the same folder.
1. In the composer, chose project MQTT-MCP, typed a task and pressed Send. A fake Claude Code single-agent run (2610251807-6763cef1) started and finished.
2. On #/run/<id>, typed "Reply draft XYZ" into the textbox "Message agent". sessionStorage now held agent-draft:<id>="Reply draft XYZ". No localStorage key held it.
3. Reloaded the same tab: the draft was kept. Navigated to the project composer and back in the same tab: kept.
4. Opened a new tab in the same browser context and typed the run URL: the box was "" and sessionStorage agent-draft:<id> was null. This reproduces the reporter's result.
5. Opened a tab with window.open from the original tab (an opener-linked tab): the draft was present, because Chrome copies sessionStorage to opener-linked tabs. Sidebar run entries are buttons, not links, so Cmd-click opens no new tab inside the app.
6. Comparison: typed "Composer draft ABC" in the project composer, then opened a new tab on the same project. The composer showed the draft.
7. Closed the browser and relaunched the same profile (a browser or desktop-app restart). The reply box for the run was "", while the composer still showed "Composer draft ABC".
No console errors and no 5xx responses. Steps 4 and 7 are the reported data loss: reply drafts only survive in the original tab and its opener-linked tabs, while composer drafts survive new tabs and restarts.
Not reproduced, only read in the code: reply-box images (Browser pins) are lost even on a same-tab reload.
Ways to refute that I checked and ruled out: the tester's selector and fresh profile are not the cause, since I saw the same result with a persistent profile. No user-facing doc says reply drafts are per tab. docs/help.md documents per-tab session storage only for the Ask code-flow help chat. docs/runs.md "The reply box" says nothing about persistence. The design notes (docs/plans/agent-mode-validation.md:12, "Drafts survive tab navigation and reload", and agent-mode-parity-plan.md:85, "scoped to their tab") refer to in-app Agent/provider tabs. Those cases are met and covered by test/e2e/agent-mode.e2e.ts:53-174, which never opens a second browser tab or res …

</details>

### t04-15 · cosmetic · Steer toast uses the raw provider id ('Sent into codex's running turn')

Source: tester unit solo-runs-providers-1; observed with real-agents; features SOL-02.

**Repro**

> Send a message while a Codex Agent turn is running.

**Expected:** 'Sent into Codex's running turn' (display name).

**Actual:** Toast 'Sent into codex's running turn' (fake and real).

**Root cause (verifier):** ui/run.tsx:1848 builds the toast from the raw AgentId: `else if (note.deliveredTo?.midTurn) showToast(`Sent into ${note.deliveredTo.agent}'s running turn`);`. deliveredTo.agent is set by src/engine.ts:5026 (`note.deliveredTo = { stepId, agent, midTurn: true }`) to the provider id, e.g. "codex". Only the Codex app-server adapter can steer (src/adapters/codex-app-server.ts:408), so the toast always says "codex". The same component already maps ids to display names elsewhere: `SHORT[agentId] ?? agentId` at run.tsx:1902/1904. SHORT is defined at ui/lib.ts:202 (codex -> "Codex") and filled from each agent's displayName at ui/main.tsx:81. The toast is the one place in that path that skips it.
Two sibling strings have the same defect:
- run.tsx:1931, the note chip, uses `n.deliveredTo?.agent` and renders "✓ Delivered to codex mid-turn (...)". The QA run shows it under "Sent messages", and test/e2e/ui.e2e.ts:269 asserts it.
- run.tsx:1934 ("Queued for ${... ?? n.agent ...}") and run.tsx:1849 ("Queued for ${member?.name ?? chosen}'s next turn") can also show raw ids such as "codex" or "acp:opencode" when a provider target is chosen.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/run.tsx, pass agent ids through the existing display-name map before putting them in user-facing text.
- Line 1848: `showToast(`Sent into ${SHORT[note.deliveredTo.agent] ?? note.deliveredTo.agent}'s running turn`)`. When the note targets a team member, prefer the member's name, as the chip already does.
- Line 1931: change the fallback to `SHORT[n.deliveredTo.agent] ?? n.deliveredTo.agent`.
- Line 1934: change the queued fallback to `n.agent ? SHORT[n.agent] ?? n.agent : "next agent"`.
- Line 1849: when `chosen` is a provider id, show `SHORT[chosen] ?? chosen`.
A small helper such as `agentLabel(id) => SHORT[id] ?? id` in ui/lib.ts would keep this consistent. No server change is needed: deliveredTo.agent should stay the id.

**Suggested regression test:** Update test/e2e/ui.e2e.ts, test "a message sent while Codex is working reaches its running turn" (around line 266).
- After `textarea.press("Enter")`, add `await page.locator(".toast", { hasText: "Sent into Codex's running turn" }).waitFor({ timeout: 10_000 })`.
- Change the chip expectation at line 269 to "✓ Delivered to Codex mid-turn (Implement plan): Prefer tabs over spaces".
- Optionally assert that no `.toast` contains the lowercase "codex's".
The server-side assertion at line 278 (deliver …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4695 on 127.0.0.1:4695 (qa-server.sh start v4695 4695 fake). Used a Playwright script (scratchpad/qa/work/v4695/steer.mjs and steer2.mjs) to drive the UI.
1. In New run I chose project MQTT-MCP and switched the provider menu from "Claude Code" to Codex, with AI team off (solo). The task was "Say hi briefly. WAIT-FOR-STEER". The fake codex app-server keeps a fresh turn open until a turn/steer arrives (test/fake-codex-app-server.mjs:139). I clicked Send.
2. Once step s1 (agent codex) was running, I typed "Please also mention the README" in the run composer and pressed Enter. The placeholder read "Message Codex…".
3. The div.toast read exactly "Sent into codex's running turn". The API showed note.deliveredTo = {stepId:"s1", agent:"codex", midTurn:true}.
4. A second run ("Second check. WAIT-FOR-STEER", message "Keep it to one line") gave the same toast. The screenshot shot at scratchpad/qa/shots/v4695/001-toast-visible.png shows the lowercase "codex" toast right above the composer's "Codex" provider chip and the "Message Codex…" placeholder.
Reproduced 2/2. A real agent is not needed: the text comes from the AgentId string, not from agent output.
Attempts to refute it:
- docs/runs.md:47,62 describe mid-turn steering but say nothing about raw ids in the UI.
- Every other user-facing string around this spot goes through SHORT: the hint at run.tsx:1906/1914, the placeholder at 1920 and the provider chip.
- The only test that touches this path, test/e2e/ui.e2e.ts:269, asserts the note-chip text "✓ Delivered to codex mid-turn (Implement plan)…". That records current behaviour, not a design choice, and it never checks the toast.
So this is not by design, not caused by the environment, and not a selector problem.
Cleanup:
- Archived both runs with cleanup and deleteBranches through POST /api/runs/:id/archive. This is the same endpoint the Archive dialog uses; the dialog itself is hidden for chat runs and the sidebar archive keeps worktrees. Their MQTT-MCP worktrees and codeflow/<runId>/solo branches were removed.
- Deleted both runs through the sidebar (Select runs, Select loaded, Delete… "Delete 2 runs").
- Stopped server v4695.
- No leftovers: 0 worktrees, 0 branches, /api/runs was [].

</details>

### t06-15 · cosmetic · Toasts and counts use raw provider ids and wrong plurals

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-16, RUN-14.

**Repro**

> 1. While a run is going, send a note To 'Claude Code' and to Next agent (Codex mid-turn). 2. Look at usage tooltips / resume budget on a 1-call run.

**Expected:** 'Sent into Codex's running turn', 'Queued for Claude Code's next turn', '1 call', '1 step'.

**Actual:** 'Sent into codex's running turn', 'Queued for claude's next turn', 'New allowance: 1 calls', 'claude: 1 steps'.

**Root cause (verifier):** Raw provider ids are rendered where the UI elsewhere uses SHORT (ui/lib.ts:202, overwritten with the inventory displayName in ui/main.tsx:81 and ui/state.ts:37). Counts are interpolated with a fixed plural.

Raw ids:
- ui/run.tsx:1848 `showToast(\`Sent into ${note.deliveredTo.agent}'s running turn\`)` uses the raw AgentId.
- ui/run.tsx:1849 `Queued for ${member?.name ?? chosen}'s next turn`: in a non-team running run, `chosen` is a raw AgentId from `teamAgents` (ui/run.tsx:1819/1824/1825). Team runs are fine because they use member.name.
- ui/run.tsx:1931 and 1934: the note chips "✓ Delivered to ${… n.deliveredTo?.agent}" and "Queued for ${… n.agent}" are also raw ids.
- ui/run.tsx:583-585 `agentUsageTitle`: `${agent}: ${u!.steps} steps` uses a raw key and is never singular.

Fixed plurals:
- ui/run.tsx:301 "New allowance: {allocation.maxSteps} calls" (resume budget).
- ui/run.tsx:2341 "New allowance: {…} calls" (fix-check recovery dialog).
- ui/run.tsx:1946 follow-up budget summary "· {followupSteps} calls".
- ui/composer.tsx:341 "Limit {N} calls".
- ui/composer.tsx:1150 "stops after … or {N} steps".
- src/engine.ts:2557 the server-side stop reason `step limit (${maxSteps} agent s …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. Add `export const plural = (n: number, word: string, many = word + "s") => \`${n} ${n === 1 ? word : many}\`` to ui/lib.ts. Make ui/projects.tsx import it instead of its local copy.
2. In ui/run.tsx, add a small `agentName = (id?: string) => id ? SHORT[id as AgentId] ?? id : undefined` and use it:
   - line 1848: `Sent into ${agentName(note.deliveredTo.agent)}'s running turn`
   - line 1849: `member?.name ?? agentName(chosen)`
   - lines 1931/1934: the delivered and queued note chips
   - line 584 in agentUsageTitle: `${agentName(agent)}: ${plural(u.steps, "step")}`
3. Replace the fixed "N calls" / "N steps" with plural():
   - ui/run.tsx:301, 2341 and 1946
   - ui/composer.tsx:341 and 1150
   - src/engine.ts:2557, e.g. `step limit (${n} agent step${n === 1 ? "" : "s"})`
4. Update the docs/runs.md:49 example and the e2e chip assertion at test/e2e/ui.e2e.ts:268 to "Delivered to Codex mid-turn (Implement plan)".

**Suggested regression test:** In test/e2e/ui.e2e.ts, extend "a message sent while Codex is working reaches its running turn":
- after pressing Enter, assert `page.locator('.toast', { hasText: "Sent into Codex's running turn" })` appears;
- change the chip assertion to "✓ Delivered to Codex mid-turn (Implement plan): Prefer tabs over spaces";
- select "claude" and send a second note, then assert the toast "Queued for Claude…'s next turn" (or the SHORT name the fake inventory reports) and that no toast or chip contains a lower …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4665 on 127.0.0.1:4665. Before starting, I moved the previous v4665 home aside so no state was shared. I made a scratch clone of MQTT-MCP and added it through the UI ("Open another repository" -> project "v4665 MQTT"). Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/ (a2.log, a3.log, a4.log).

(1) From the composer I started a Fix & review run: builder codex, reviewer claude, check `true`, "Approve for me", task containing WAIT-FOR-STEER. The To dropdown options were ["=Next agent","codex=Codex","claude=Claude Code"].
- With To = Next agent, I sent a note while Codex was mid-turn. Toast: "Sent into codex's running turn". The run's notes show deliveredTo {agent:"codex", midTurn:true}.
- With To = Claude Code, I sent a second note. Toast: "Queued for claude's next turn", and the chip above the composer read "Queued for claude: Note B to Claude Code". Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/001-toast-B.png shows "To Claude Code", step rows labelled "Codex", and the toast "claude's" all on one screen.
- After the run finished, the usage tooltip read "codex: 2 steps, 204 tokens, 1s\nclaude: 1 steps, 160 tokens, ≈$0.25, 0s".

(2) In the composer I set "Branches and limits -> Agent steps" to 1. The composer then showed "Limit 1 calls · 240 minutes" and "stops after 240 min or 1 steps". The run stopped with "Stopped at the step limit (1 agent steps)". The next-action card read "New allowance: 1 calls · 240 minutes. Earlier usage is retained." (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/002-resume-budget.png). Its usage tooltip was "codex: 1 steps, 102 tokens, 0s".

I saw no console or 5xx errors. Every string matched the report, and the run also exposed three more unpluralised strings the report doesn't list.

Refutation attempts:
- Not caused by the environment or the script: the strings come straight from the code paths below, and the reporter's selectors match mine.
- Not by design for the toasts: the same component's hint already uses SHORT, e.g. "Steered into Claude Code's running turn…", so display names are the intent. docs/runs.md:49 ("✓ delivered to codex mid-turn (Implement plan)") and test/e2e/ui.e2e.ts:268 do pin the lowercase id, bu …

</details>

### t05-15 · minor · Chat follow-up to a signed-out provider is not pre-checked; the failed turn leaves the run 'Finished' with no recovery bar

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-20.

**Repro**

> 1. Restart a fake server with FAKE_SIGNED_OUT=claude and FAKE_CLAUDE_FAIL=auth. The composer now correctly blocks new Claude runs: "Claude Code isn't signed in — open Settings → Agents & models".
> 2. Open an existing finished Claude chat run and send a follow-up.
> 3. The turn fails with "Claude Code isn't signed in…", but the header stays 'Finished'. 'Ready to review' still shows, and there is no recovery bar or Health link.

**Expected:** The reply box warns, or blocks, as the composer does, and a failed latest turn is clearly marked with a path to Health.

**Actual:** The message is sent to a provider known to be signed out. After the failure the run looks successful except for the red line under the turn.

**Root cause (verifier):** (1) ui/run.tsx:1837 ConversationBar.send() and the Send button and hint around ui/run.tsx:1904-2005 never read the `health` signal (ui/state.ts:693). The composer does read it: ui/composer.tsx:570-571 computes `signedOut = health.value?.find(h => used.has(h.id) && h.installed && h.signedIn === false)` and blocks with "<name> isn't signed in — open Settings → Agents & models". The reply path has no equivalent for replyAgent. The server does not guard either: src/server.ts:2598 → src/engine.ts:3762 followUp() never checks `exhausted(agent, manager.quota)`, even after /api/doctor recorded claude as signed_out (src/server.ts:1947). The Improve endpoint does run that check (src/server.ts:718). (2) The auth message is built in src/engine.ts:2638 as "...isn't signed in. Sign in to it in a terminal, then resume the run." for every non-remote step, including a solo reply turn. For a solo reply, src/engine.ts:5867 only sets f.status = "failed" and the run stays done, which is intended (src/engine.ts:5714, docs/runs.md:63,118). The recovery bar at ui/run.tsx:339 renders only for failed/stopped/interrupted/cancelled runs, so the text points at a Resume action that does not exist. (3) Working a …

**Files:** `ui/run.tsx`, `ui/composer.tsx`, `src/engine.ts`, `test/e2e/agent-mode.e2e.ts`, `test/engine-reliability.test.ts`

**Suggested fix:** 1. In ConversationBar (ui/run.tsx), add a pre-send warning when the run is not running and has no remote worker or agent container (health.value describes this machine only): `const signedOut = health.value?.find(h => h.id === replyAgent && h.installed && h.signedIn === false)`. Render `<p class="msg warn" role="alert">{name} isn't signed in — <a href="#/settings/agents">open Settings → Agents & models</a></p>`, reusing the composer's wording. Ideally extract a shared helper from ui/composer.tsx:570 so both places use the same text. A soft warning, or a block that re-runs loadHealth() before refusing, is better than a hard block on a possibly stale signal, because replying is the documented retry path. 2. Optionally, have the server refuse a follow-up whose agent has quota.status === "signed_out" inside the 15-minute window (`exhausted()` from src/routing.ts), with a 400 message, matching the Improve endpoint at src/server.ts:718. 3. In src/engine.ts:2638, choose the recovery verb by c …

**Suggested regression test:** test/e2e/agent-mode.e2e.ts: start the fake server with FAKE_SIGNED_OUT=claude. Seed a finished Claude solo chat, either by starting the server without the env first or by stubbing health. Open the run and assert that the reply box shows "Claude Code isn't signed in" with a link to #/settings/agents before sending (or that the Send button is disabled, if the fix blocks). test/engine-reliability.test.ts: add a case next to the existing "errorKind decides: signed out…" test (line ~277). Stub claude …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server v4629 on port 4629 with a new home and a fresh browser profile. (1) Started with no FAKE_* env. In the UI: Choose project → MQTT-MCP, Provider = Claude Code, Permissions = Approve for me. Sent "v4629 baseline solo: add a note file." Run 2610251808-a37d1b34 finished with status done and steps [Your task: done]. (2) Stopped the server, exported FAKE_SIGNED_OUT=claude and FAKE_CLAUDE_FAIL=auth, and started it again. /api/doctor reported claude signedIn=false. On the home composer, Send was disabled with the title "Claude Code isn't signed in — open Settings → Agents & models", so the composer blocks correctly. (3) Opened #/run/2610251808-a37d1b34. Before sending, the reply box showed only "Claude Code / Default model / Default effort / Approve for me / AI team Off". No line on the page mentioned signing in, and Send was enabled once text was typed. I pressed Enter on "v4629 follow-up while signed out". There was no warning or alert. The toast "Sent — the agent is on it" appeared, followed by the toast "Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)". (4) Afterwards: run.status = done with no run.error. Steps were [Your task: done, Your reply: failed], and followUps f1 was reply/failed. The header pill still read "Finished". .chat-recovery was absent and "Ready to review" was still visible. The page had no Health, Settings or Agents & models link. The turn showed a "✕ Didn't finish" badge and a red error line telling me to "resume the run", but a Finished chat has no Resume control. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/001-composer-signedout.png, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/002-reply-before-send.png, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/003-after-failed-followup.png. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/ (a2-start.mjs, a3-followup.mjs, a3.log). No console errors or 5xx responses. Partly refuted: the run staying "Finished" with no recovery bar after a failed reply is documented behaviour. docs/runs.md:63 says "A turn that fails ends that turn, not the conversation: repl …

</details>

### t05-16 · cosmetic · A failed chat turn shows the same error three times

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-19.

**Repro**

> 1. With FAKE_CLAUDE_FAIL=auth, start a solo Claude run.
> 2. The thread shows 'Invalid API key · Please run /login', then the red alert "Claude Code isn't signed in… (Invalid API key · Please run /login)", then the recovery bar repeating the same sentence above 'Resume'.

**Expected:** One clear error with the Resume action.

**Actual:** Three near-identical blocks.

**Root cause (verifier):** Three layers each show the same error:
1. src/adapters/claude.ts:257 sets `finalText = msg.result` for every `result` event, including `is_error` ones. In the same event, :260 and :326 make that same string the turn's error. On failure, :310 returns `finalText: finalText || stream.lastText || lastAssistantText`. So a failed turn's "answer" is the CLI's error text, which here is also the assistant text the CLI sent.
2. src/engine.ts:2638 wraps the auth error as "Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (<first line of the error>)". Lines :2644-2645 store both `step.finalText` (the raw text) and `step.error` (the wrapped text), and the run's error is set to that same message when the run fails.
3. ui/run.tsx TurnBody, lines 776-777, renders `<Markdown text={step.finalText}>` (block 1) and then `<div class="ev error">{step.error}</div>` (block 2). ui/run.tsx:339 then renders `.chat-recovery` with `<p>{run.error ?? run.stopReason ?? "Work is saved…"}</p>` (block 3), which repeats the error the last turn's alert already shows.
The recovery-bar repeat (2 vs 3) happens for every failed solo chat turn, whatever the vendor. The extra raw-text copy (1) a …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/claude.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-views.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/adapters-reliability.test.ts`

**Suggested fix:** Two changes:
(a) Recovery bar, ui/run.tsx:339. If run.error equals the error of the last main-thread agent turn (which TurnBody already shows as `.ev.error`), drop the repeated text. Show only the Resume / Retry reply button, or a short line such as "Work is saved. Resume when you're ready." Show run.error only when no turn already displays it, for example a run-level failure or a stop reason.
(b) Echoed error text. In src/adapters/claude.ts, when the result is `is_error`, do not return the CLI's error text as finalText. Return "" when finalText or lastAssistantText, trimmed, equals resultError. The agent-says-500 case must keep its finalText: there the result carries no text, so the agent's own last message stays.
A UI-only alternative for (b): in TurnBody (run.tsx:776), skip `<Markdown text>` when `step.status === "failed"` and `step.error` contains `text.trim()`. That also fixes old runs already saved with the echoed finalText. Doing both is safest, because the adapter fix also stop …

**Suggested regression test:** 1. test/chat-views.test.ts: render `m.ChatThread` for a failed solo run with one step, `{status:"failed", finalText:"Invalid API key · Please run /login", error:"Claude Code isn't signed in. … (Invalid API key · Please run /login)"}`. Walk the element tree and assert "Invalid API key" appears exactly once, inside the `.ev.error` element.
2. test/adapters-reliability.test.ts, next to line 191 (the FAKE_CLAUDE_FAIL=auth turn): add `assert.equal(auth.result.finalText, "")`, or at least `assert.notE …

<details><summary>Verifier's independent reproduction</summary>

I ran `export FAKE_CLAUDE_FAIL=auth` and then `qa-server.sh start v4631 4631 fake`, which gave a fresh home with no runs. I drove the UI with headless Chrome (script at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631/run.mjs): New run, then Choose project → MQTT-MCP, Provider → Claude Code, Permissions → Approve for me. I typed "Add a short comment line to README.md explaining the project purpose." and pressed Send. Run 2610251807-0b90a511 ended in status "failed" with run.error = "Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)". The screenshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631/004-auth-failed.png) shows three blocks under the "Claude Code ✕ Didn't finish" header:
(1) the plain text "Invalid API key · Please run /login";
(2) the red .ev.error alert "Claude Code isn't signed in… (Invalid API key · Please run /login)";
(3) the .chat-recovery bar repeating that same sentence above "Resume".
In the main text, "Invalid API key · Please run /login" appeared 3 times. The persisted run log has step.finalText = "Invalid API key · Please run /login", step.error equal to the wrapped sentence, and run.error equal to step.error. There were no console or 5xx errors. Nothing points to the tester's setup: I used a different project (MQTT-MCP rather than the reporter's t05-mqtt), a fresh server and my own profile, and got the same result. A comment in test/fake-agent.mjs:183 says this fake output copies how Claude Code ends a turn that failed. I found no doc or code comment saying the repetition is intended. docs/plans/agent-mode-validation.md:211 actually says failed attempts are disclosed under Show work "rather than rendered as competing answers". I did not run a real signed-out agent, because the adapter path below does not depend on the vendor.
Cleanup: I deleted the run through the UI (Run actions → Delete… → Delete run; the API now returns 404) and stopped server v4631. The delete dialog says branches and worktrees are kept, so I removed my run's leftovers in MQTT-MCP myself: the worktree .worktrees/2610251807-0b90a511/solo, the branch codeflow/2610251807-0b90a511/solo and the leftover .context folder. Nothing of mine is left. A different run, 2610251807-6763cef1, is still in MQTT-MCP; it is not mine and I did not touch it.
 …

</details>

### t07-14 · minor · 'Request a fix' appends the same paragraph again on every click

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-23.

**Repro**

> 1. Open a finished run with failing checks (S4/S5).
> 2. Type 'MY OWN NOTE 42' in the reply box.
> 3. Click 'Request a fix' twice.

**Expected:** The prepared request is added once; a repeat click focuses the existing draft.

**Actual:** The reply box holds 'MY OWN NOTE 42' followed by two identical 'Investigate and fix the failing checks (…)' paragraphs; the duplicate persists across reload. (The user's text is correctly kept, and nothing is sent until Send.)

**Root cause (verifier):** ui/run.tsx:225-226. In `act()`, the `next.kind === "revise"` branch does `chatDrafts.value = [...chatDrafts.value, { to: `main:${run.id}`, text: "Investigate and fix the failing checks (…)…", images: [] }]` on every click, with no check for whether that text is already queued or already in the box.

ConversationBar (ui/run.tsx:1787-1795) then calls `takeDrafts("main:<id>")` (ui/state.ts:140-144). It unconditionally joins each taken draft onto the current text: `setText(t => [t.trim(), ...drafts.map(d => d.text)].filter(Boolean).join("\n\n"))`, so every click adds one more copy.

After a click, `nextRunAction` (ui/run-experience.ts:63) still returns `kind: "revise"` because the run's verdict has not changed. The card and its primary button therefore stay live and nothing stops a second click.

The duplicate survives a reload because ConversationBar saves the box text to `sessionStorage["agent-draft:<id>"]` (ui/run.tsx:1784). The persistence works as designed; it just keeps the doubled text.

**Files:** `ui/run.tsx`, `ui/state.ts`, `test/e2e/ux-flows.e2e.ts`

**Suggested fix:** Make "Request a fix" idempotent.

1. In ui/run.tsx `act()` (revise branch), build the fix text once, e.g. `const fixText = …`. Before queueing, check two things:
   - Whether `chatDrafts.value` already has an entry with `to === "main:<id>"` and the same text.
   - Whether the current composer text already contains `fixText`. Read it from `agentDrafts.get(run.id)?.text` or from `sessionStorage["agent-draft:<id>"]`.
   If either is true, do not queue it again. Just focus the reply box, e.g. `focusSection` on the convo, or `document.querySelector("main .convo textarea")?.focus()`.

2. Optionally harden the consumer too. In the ConversationBar effect (ui/run.tsx:1790), skip any draft text that already occurs in the current text: `drafts.filter(d => !t.includes(d.text.trim()))`. Browser pins sent twice would then be deduped as well. This costs nothing for pins, which are normally unique.

3. Optional UX touch: once the fix text is in the box, change the card button label to "Edit fix reques …

**Suggested regression test:** Extend the existing e2e test "failed checks prepare a follow-up and blocked checks continue from saved work" in test/e2e/ux-flows.e2e.ts (around line 120):
- After the first `Request a fix` click and the `until(...)` wait, fill the box with "MY NOTE" plus the current value (or type a note first). Click `Request a fix` a second time.
- Assert that `(await page.locator("main .convo textarea").inputValue()).match(/Investigate and fix the failing checks/g).length === 1`.
- Assert that the box still  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4613 on port 4613, with an empty QA home. I made a scratch clone of MQTT-MCP at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4613-mqtt. Through the API I created the precondition run 2610252015-c40d5a81: pattern solo, checkpointOnFinish:true, check "false". This is the same fixture the shipped e2e test uses. It finished with status done and verdict failing.

I drove the UI in a fresh browser with no profile, using the e2e test's own selectors (region "Next action" > button "Request a fix", and `main .convo textarea`). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/reqfix.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/reqfix.log.

Results:
- I typed "MY OWN NOTE 42" in the reply box.
- After the first click the box held the note plus one "Investigate and fix the failing checks (false)…" paragraph. The button stayed visible and enabled.
- After the second click the box held the note plus two identical paragraphs (count 1, then 2).
- After a page reload there were still 2 copies, and the user's note was kept.
- With an empty box, two clicks also gave 2 copies.
- Nothing was sent: the run stayed done with 0 followUps. There were no console errors or 5xx responses.

The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4613/002-after-two-clicks.png shows the doubled paragraph under the still-active "Request a fix" button.

Attempts to refute it:
- Not by design. docs/runs.md:31 says only that "Request a fix prepares an editable follow-up without sending it". No doc or code comment covers repeated clicks.
- Not caused by the environment. It reproduces in a fresh profile with the stock selectors.
- Not caused by the tester's script. The code appends unconditionally.

Cleanup:
- I deleted the run through the UI (More run actions > Delete… > Delete run), and GET on the run now returns 404.
- The run's worktree and branch were left behind. The delete dialog says this is intended ("Git branches, worktrees and repository files are kept"). They existed only in my scratch clone, which I then removed.
- Server v4613 is stopped, and ports 4613/4615 are free.
- Leftover: only the QA home /private/t …

</details>
