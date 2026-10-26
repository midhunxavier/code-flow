# Cluster 06 · review-diff-comments

**Review diffs and comment sending: quoted paths, blank diffs, recipient fallback, provider lock**

Status: **independently verified after repair; path-policy limitation recorded** · 9 issues · branch `qa-fix/review-diff-comments`

Planner notes: t17-3/S10-5: diffFiles in src/ship.ts splits plain 'git diff' output and keys each patch with / b\/(.+)$/, while the file names come from -z name-status. Git C-quotes non-ASCII paths, and a path containing ' b/' breaks the regex. Generate the patch per file, or with -z / core.quotePath=false, and key it by the name-status path. t17-14: FileDiff in ui/review.tsx needs a message for files renamed without changes and for empty files. t17-9: draft line comments need a head-commit anchor. Recipient: ui/changes.tsx falls back to 'claude' and allows Send before /api/runs/:id loads (S04-2, major). The AgentPicker in ui/review.tsx shows 'claude' as if it were chosen while Send stays disabled (t17-10/S04-4). Both should show 'Choose an agent' until the writer is known. t17-11/S04-3: src/engine.ts:3790 enforces the solo provider lock only for kind 'reply'; extend it to comments, ci-fix and resolve-conflicts follow-ups. Duplicate groups: [["t17-3","S10-5"],["t17-10","S04-4"],["t17-11","S04-3"]]

Likely files: `src/ship.ts`, `ui/review.tsx`, `ui/changes.tsx`, `src/engine.ts`, `src/integrity.ts`, `src/diff.ts`, `ui/run.tsx`

## Independent verification · 2026-10-26

Verified in `codex/qa-verify-lifecycle-review-permissions` from integrated `c70d95f`. Audited patch-header mapping, comment relocation, fallback recipients and provider locks. Used fresh isolated fake-agent servers and Chrome; no live server or user state. Ran the original scenarios and added an adversarial provenance probe after cluster05 integration.

| Issue | Independent outcome |
|---|---|
| t17-3, S10-5 | Pass for policy-allowed names. HTTP and browser rendered actual added lines for Unicode, spaces, ` b/` and quotes. Direct Git parser tests also preserve tabs, newlines and backslashes. HTTP/UI exclusion for these latter names remains as explained below. |
| t17-14 | Pass. Browser showed explicit empty-file, rename-without-content-change and binary messages, with no blank code table. Unit tests also check mode-only and file-type changes. |
| t17-9 | Pass. Browser created two line drafts, then an external commit inserted lines and changed one anchor. The retained code carried its draft to the new line; the missing code appeared separately and the sent follow-up described the old location without misattaching it. Duplicate/removed-line anchor cases pass in targeted tests. |
| t17-10, S04-4 | Pass. Unknown writer showed “Choose an agent…”, Send remained disabled, and keyboard-picking the first agent enabled it. |
| S04-2 | Pass. With detail responses held or failed, the Changes pane used the solo provider from the summary; team runs waited for a writer or required an explicit choice. An independent 503 detail probe still displayed Codex, with no Claude fallback. |
| t17-11, S04-3 | Pass. Wrong-provider HTTP comments returned 400 with the provider-tab explanation. Manager tests additionally refuse wrong-provider conflict resolution and CI watch while same-provider comments and explicit side chats succeed. |

New adjacent regression: `changedFiles` and `workingChangedFiles` used quoted newline-delimited output and `.trim()`. Imported Unicode/quoted paths missed “merged in” labels and leading whitespace changed identity; edited imported files could retain the wrong provenance. Both now parse raw `git diff --name-only -z` output without trimming. New `test/qa-review-diff-comments-provenance.test.ts` failed before the fix and passes exact names, working edits and review coverage for leading whitespace, Unicode, quotes, tabs, newlines (including a trailing newline), backslashes and ` b/` paths. Independent HTTP/Chrome showed four correct badges for allowed names (` imported.txt`, `café.md`, `quote".txt`, `a b/c.txt`), then zero badges after editing those working files.

**Explicit remaining product limitation:** `filterPolicyDiff` calls `allowsFilePolicy`, whose `normalizePolicyPath` deliberately rejects tabs, newlines, backslashes and other unsupported policy characters. Such files are omitted from HTTP review results even under default policy, although direct diff/provenance helpers parse them correctly. This existing security boundary is preserved; the result is not a claim that every legal Git filename is supported in the UI. Broadening it requires a separate filesystem-policy design and security review.

Validation: `npx tsc --noEmit`; 46/46 targeted cluster04/05/06/08 tests; 14/14 Chrome cluster04/06/08 e2e tests. Original parser, comment and recipient tests were rerun, not accepted from prior reports. Fake CLIs only.

Evidence:
- `/private/tmp/codeflow-qa-continue/verify04608-1793007353046/evidence.json` — allowed path rendering, policy omissions, empty/rename messages, provider rejection and failed detail load.
- `/private/tmp/codeflow-qa-continue/verify046-provenance-1793007640029/evidence.json` — corrected provenance via actual HTTP/Chrome; `shots/verify046-provenance/001-exact-imported-provenance.png` and `002-working-edits-own-change.png` under `/private/tmp/codeflow-qa-continue/`.
- The lazy team-task module was opened both at a missing-task route (rendered “Task not found”) and an actual task route; this is a loading smoke check, not full collaboration verification. Evidence: `/private/tmp/codeflow-qa-continue/verify046-provenance-1793007640029/lazy-evidence.json`, task `t-e9e96407ba992746`.

## Fix result

Commits:
- `f7abeba` Give every reviewed file its own patch, whatever its name
- `8853c04` Keep an Agent chat's provider for review comments, fixes and merges
- `7589c12` Load the Review page when it opens
- `294246d` Show a comment recipient as unchosen until it is known
- `95cd186` Say why a file's diff has no lines
- `003f160` Keep draft line comments on their code when the branch moves
- `6bd658d` Cover the review diff and comment QA regressions

Fixer notes for the integrator: 1. Startup budget: base main.tsx startup JS was 847,934 bytes against the 850,000 budget in test/assets.test.ts. These fixes pushed it to 850,674, so commit 7589c12 makes ui/app.tsx load Review lazily through the existing lazyView, as SettingsView and ChangesTab already are. Startup is now 834,122. Other clusters that add UI bytes may have hit the same budget; check assets.test.ts after merging.
2. Intentional change to an existing test: test/e2e/daily-workflow.e2e.ts 'review waits for the actual writer…' now uses a pipeline run (codex builder) instead of a solo Codex chat. An Agent chat's recipient is now its provider from the run summary, so nothing waits for the run any more. The test asserts that the select shows the 'Loading recipient…' placeholder with value ''. The old '.review-to' label text 'Loading recipient…' / 'Choose an agent' is gone: the label always reads 'Send to' and the placeholder is in the select.
3. Behaviour change: for solo (Agent chat) runs the server now refuses comments, resolve-conflicts and ci-fix follow-ups, and watchPr, from any agent other than the chat's provider (same 400 message as replies). A PR watch created earlier with another agent will end in 'needs-you' with that message at its next fix.
4. Possible conflict areas: ui/review.tsx (FileDiff, parsePatch and commentsMessage are now exported with new signatures, and the Row interface is exported), ui/run.tsx AgentPicker (value may be undefined; new placeholder and fixed props), ui/changes. …

## Issues

### t17-3 · major · Review shows a blank, uncommentable diff for non-ASCII file names and for paths containing ' b/'

**Fix outcome: fixed.** src/ship.ts diffFiles: the patch is generated with -c core.quotePath=false and explicit --src-prefix=a/ --dst-prefix=b/ (new PATCH_PATHS in src/git.ts), and each 'diff --git' chunk is matched by an exact lookup of its header line, built from the -z name-status paths with git's own C-quoting (new quoteGitPath in src/git.ts). This replaces the / b\/(.+)$/ regex. The numstat parser keeps a path's own tabs. A file that changes type (deletion + creation under one header) keeps both chunks, and ui/review.tsx parsePatch resets at an inner 'diff --git' line so header lines never render as code. src/integrity.ts inspectChanges reads its +++ lines the same way (exact map, trailing tab stripped).

Fixer's check: QA server f06 (port 4371, fake agents, fresh home) running from the worktree. Scratch repo, solo run. In the run worktree I committed 'café notes.md', 'a b/c.txt', plain-control.md, a git mv rename, empty.txt and blob.bin, and left 'notas-café.md' uncommitted. GET /api/runs/<id>/diff gave non-empty patches for every file: café notes.md 107 chars, a b/c.txt 104, notas-café.md 106 (all were 0 in the bug report). In #/review/<id>/<branch> each of those three files showed 2 rows with 1 commentable line, and I added a line comment on café notes.md. browser errors [] and no errors in server.out. test/qa-review-diff-comments.test.ts fails on the base commit and passes now. It covers café, 'a b/', ' …

Tests: `test/qa-review-diff-comments.test.ts`, `test/qa-review-diff-comments-ui.test.ts`, `test/e2e/qa-review-diff-comments.e2e.ts`

Source: tester unit git-review-merge-1; observed with real-agents; features GIT-10, GIT-11.

**Repro**

> 1. On a run branch, commit a new file named 'café notes.md' (or 'a b/c.txt'). The real agy chat created 'notas-café.md' itself. 2. Open Review changes (#/review/<run>/<branch>). 3. Select the file.

**Expected:** The file's added lines are shown and can be commented on, like any other file.

**Actual:** The file list shows +1, but the diff pane has a header and no rows or message. /api/runs/<id>/diff returns patch "" for these files. Reproduced with a fake fixture commit (café notes.md, a b/c.txt) and with real agy working changes (notas-café.md). The real file was then merged into qa-real without ever being visible in Review.

**Root cause (verifier):** src/ship.ts:99-104 (diffFiles) builds the per-file patch map by splitting the plain `git diff --no-color -M` output (src/ship.ts:68) on `^diff --git ` and keying each chunk with `header.match(/ b\/(.+)$/)?.[1]`. The keys of the result come from `--name-status -z` (src/ship.ts:71-82), which never quotes paths. `patches.get(path) ?? ""` (src/ship.ts:107) therefore returns "" whenever the header key differs from the name-status path. This happens in two cases:
1. Without -z, git applies core.quotePath (default true). Any path with bytes >= 0x80, control characters, `"` or `\` is C-quoted and octal-escaped, as in `"a/caf\303\251 notes.md" "b/caf\303\251 notes.md"`. The regex either captures `caf\303\251 notes.md"`, quotes and escapes included, or fails to match.
2. A path containing " b/" (for example `a/a b/c.txt b/a b/c.txt`) matches at the first " b/", giving the key `c.txt b/a b/c.txt`.
In both cases the file still appears in the list with the right numstat counts, but its patch is empty. ui/review.tsx:235 parsePatch("") yields no rows, and FileDiff shows a "Binary file" message only when binary is true, so the pane has a header and nothing else, with no explanation. branchDiff (sr …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/integrity.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/diff.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filesystem-git.test.ts`

**Suggested fix:** In src/ship.ts diffFiles, stop splitting the header at " b/". The paths are already known from --name-status, so match the header against them exactly:
(1) Add `-c core.quotePath=false` to safeDiff. This is harmless for the -z calls, and afterwards git quotes only control characters, `"` and `\`.
(2) For each name-status entry, build the expected header `${quoteGitPath("a/" + (oldPath ?? path))} ${quoteGitPath("b/" + path)}`. quoteGitPath copies git's quote_c_style: when the UTF-8 bytes contain any byte < 0x20, `"`, `\` or 0x7f, wrap the path in quotes and escape it with \a \b \t \n \v \f \r \" \\ or \ooo.
(3) Key each `diff --git` chunk by an exact lookup of its header line in that map.
I prototyped this in my private snapshot; the diff is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/fix.diff. It correctly maps renames inside "a b/", deletions, binaries, mode-only changes, and names with tab, newline …

**Suggested regression test:** New test file test/review-diff-paths.test.ts (I wrote and ran it in my snapshot). It creates a temp repo, commits 'café notes.md', 'a b/c.txt', '日本 b/ü.txt', 'ta\tb.txt', 'qu"ote.txt' and 'back\slash.txt', and leaves 'x b/notas-café.md' uncommitted. For every committed path, branchDiff(repo, base, "main") must return a file whose patch matches /^@@ -0,0 \+1 @@$/m and contains `+line of <path>`. workspaceDiff(repo, base) must return a patch containing "+working line" for 'x b/notas-café.md'. Agai …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server named v4665b on port 4667 with a new home, because port 4665 was already taken by another verifier's server (v4663). I made a scratch clone of MQTT-MCP (clones/v4665-mqtt.git plus a working clone) and added it through the UI with "Open another repository" > New project "v4665-mqtt". From the composer I started a solo run with the task "Add a short note file describing the project." and check "true". The run finished (2610252145-66655391, branch codeflow/2610252145-66655391/solo), and the fake agent left claude-7125b621.txt uncommitted. In the run worktree I committed 'café notes.md', 'a b/c.txt' and a control file 'plain-control.md'. I also left an uncommitted 'notas-café.md'. Running `git diff --no-color` printed these headers: `diff --git a/a b/c.txt b/a b/c.txt` and `diff --git "a/caf\303\251 notes.md" "b/caf\303\251 notes.md"`.
Results:
(a) GET /api/runs/<id>/diff (the solo run uses workspaceDiff) listed all 5 files at +1/-0. The patch length was 0 for 'a b/c.txt', 'café notes.md' and 'notas-café.md', and 109–113 for the two ASCII files.
(b) In the Review UI (#/review/<id>/<branch>, Playwright, work/v4665/s3-review.mjs), clicking each of the three affected files showed the .diff-file-head with the name and then nothing: 0 tr.dl rows, 0 commentable lines and no .tree-empty message. The ASCII files showed a hunk and 1 commentable line each. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665b/003-review-file-1.png (blank pane for café notes.md); the control is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665b/006-review-file-4.png.
(c) The branchDiff path, called directly from my snapshot copy on the committed range, also returned patchLen 0 for 'a b/c.txt' and 'café notes.md'. So both review paths fail (committed branch and working changes).
(d) Fix check: I patched only my snapshot (builds/v4665b), restarted my server from it and re-ran the same UI script. All 5 files then rendered 2 rows with 1 commentable line ( /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665b/003-fixed-review-file-1.png ).
Refutation checks: nothing in docs/*.md or the code comments says these paths are left out on purpose. The tester's selectors and environment were not the cause, because the API itself r …

</details>

### S10-5 · major · diffFiles matches per-file patches with / b\/(.+)$/ on the diff header but takes names from -z name-status output; paths git quotes (non-ASCII, quotes, tabs, backslashes) never match, so the Review screen shows an empty patch; a path containing ' b/' can also map to the wrong file.

**Fix outcome: duplicate.** Same root cause as t17-3 (the header regex in src/ship.ts diffFiles), fixed there. The tab-in-path numstat mis-parse it also reported is fixed in the same commit (f7abeba).

Fixer's check: See t17-3. The unit test includes tab, quote, backslash and 'x b/' names and checks both counts and patches for branchDiff and workspaceDiff.

Tests: `test/qa-review-diff-comments.test.ts`

Source: code-level suspect at `src/ship.ts:102` (confirmed hands-on).

**Repro**

> (1) Focused test in my snapshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/s10/scratch-qa/diff-quoted-paths.test.ts (npx tsx --test). It makes a repo with plain.txt, 'space name.txt', café.txt, with"quote.txt, tab<TAB>name.txt, back\\slash.txt and 'x b/y.txt', then changes all of them on a branch. branchDiff and workspaceDiff returned patchChars 0 for café.txt, with"quote.txt, tab\tname.txt, back\\slash.txt and x b/y.txt. plain.txt and 'space name.txt' had patches. tab\tname.txt also got additions 0 (its numstat was mis-parsed). (2) UI: in run D's worktree in the scratch repo I added résumé.md and opened Review changes. The file list showed 'A résumé.md +2 −0', but the diff pane was empty (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s10/002-review-D-resume.png). The diff API returned patch '' for résumé.md. The user has no global core.quotepath override, and the git wrapper sets none.

**Expected:** Every changed file shows its patch on the Review screen, whatever characters the path contains.

**Actual:** Files with non-ASCII, quote, tab or backslash characters, or containing ' b/', show counts but an empty diff, so their content cannot be reviewed or line-commented. Tab-containing paths also get wrong +/- counts.

**Root cause (verifier):** The full patch is produced without -z, so git C-quotes such paths in the 'diff --git "a/…" "b/…"' header (core.quotePath defaults to true). The regex / b\/(.+)$/ needs an unquoted ' b/' and takes the leftmost match, so for 'a/x b/y.txt b/x b/y.txt' it captures 'y.txt b/x b/y.txt'. Keys come from -z name-status (raw paths), so the lookup misses. Separately, the numstat parser splits a -z token on every tab, which truncates paths that contain tabs.

**Suggested fix:** Run the patch diff with -c core.quotePath=false. Do not regex-parse paths: match each chunk header exactly against the known (old,new) pairs from name-status, comparing `a/${old} b/${new}` and also git's C-quoted form for paths with ", \\, tab or newline. Alternatively, generate patches per file (git diff … -- <path> with GIT_LITERAL_PATHSPECS=1) or use unambiguous --src-prefix/--dst-prefix. For numstat, split only the first two tabs: const [add, del, ...rest] = token.split('\t'); path = rest.join('\t').

**Suggested regression test:** Add the scratch test above to the suite: branchDiff and workspaceDiff must return a non-empty patch containing the added line, and correct additions, for non-ASCII, quote, tab, backslash, 'x b/y.txt' and renamed versions of these paths.

### t17-14 · cosmetic · Renamed files with no content change and empty files show a blank diff pane

**Fix outcome: fixed.** ui/review.tsx: a new exported diffNote(file, rows) helper. A file with no hunks now shows 'Renamed from X with no content changes.', 'Empty file added.', 'Empty file deleted.', a mode-change note, 'No content changes.', or 'No text diff available for this file.' (counts but no patch), and binary files keep their message. FileDiff always draws .diff-file-head, including the 'old → new' line for renames and binaries, and shows the note in place of the empty table. The Changes tab reuses FileDiff, so it gets the same notes.

Fixer's check: On QA server f06 I committed a git mv with no edit, an empty empty.txt and a binary blob.bin. In Review, the renamed file shows the head 'CODE_OF_CONDUCT.md → CODE_OF_CONDUCT-renamed.md' with 'Renamed from CODE_OF_CONDUCT.md with no content changes.', empty.txt shows 'Empty file added.', and blob.bin shows 'Binary file — no text diff.' under its header. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/f06/001-review-0.png. axe found 0 violations in light and dark. Browser errors were [], and the unit and e2e assertions pass.

Tests: `test/qa-review-diff-comments-ui.test.ts`, `test/e2e/qa-review-diff-comments.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-10.

**Repro**

> Commit a git mv rename with no edit, plus an empty new file, on a run branch. Open Review and select them.

**Expected:** A short message such as 'Renamed without changes' or 'Empty file'.

**Actual:** Header only ('CODE_OF_CONDUCT.md → CODE_OF_CONDUCT-renamed.md'), 0 rows, no message. A binary file does get a message.

**Root cause (verifier):** The problem is in ui/review.tsx, in `FileDiff` and `parsePatch`. Line 247, `if (file.binary) return <div class="tree-empty">Binary file — no text diff.</div>;`, is the only case that gets a message. Otherwise lines 266-273 always draw `.diff-file-head` plus `<table class="diff">` from `rows = parsePatch(file.patch)` (line 235).

`parsePatch` (lines 370-391) skips every line until the first `@@` hunk: line 384 is `if (!inHunk) continue; // file header lines`. Git's extended-header-only patches therefore give `rows = []`, and the table is drawn empty. That covers:
- a pure rename: "similarity index 100% / rename from / rename to"
- an empty new file: "new file mode / index 0000000..e69de29"
- by the same path, a mode-only change ("old mode / new mode") and deleting an empty file

The server side is correct. src/ship.ts `diffFiles` (lines 64-115) returns the right status, oldPath, +0/-0 and the header-only patch; nothing tells the UI to explain an empty diff. The same `FileDiff` is used by the run page's Changes panel (ui/changes.tsx:134), so that panel shows the same blank pane. The list row shows `R`/`A` and `+0 −0`, so the information is there, but the pane gives no explanation. Th …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`

**Suggested fix:** In ui/review.tsx, add a small pure helper, for example `export function diffNote(file: DiffFile, rows: Row[]): string | undefined`, that reads `file.status` and the patch's extended headers:
- binary → "Binary file — no text diff."
- no hunks and status renamed → "Renamed without content changes" (it could append the similarity percentage from the "similarity index N%" line)
- no hunks and status added → "Empty file added"
- no hunks and status deleted → "Empty file deleted"
- no hunks and "old mode X / new mode Y" present → "File mode changed (X → Y)"
- any other case with no hunks → "No content changes"

In `FileDiff`, always draw the `.diff-file-head` (including the `old → new` rename line, which the binary case drops today). Then draw the note as `<div class="tree-empty">` in place of the empty `<table>` whenever `rows` has no line rows. Optionally, also show the mode-change note above the table when a patch has both mode lines and hunks.

This also fixes the Changes panel (ui/chan …

**Suggested regression test:** Unit test: in test/ui-review.test.ts, which already bundles ui/*.tsx with esbuild and a stand-in window, add `diffNote` (and `parsePatch`, if it is exported) to the bundled exports. Assert:
- the renamed patch "similarity index 100%\nrename from a.md\nrename to b.md\n" with status renamed → /Renamed without/
- "new file mode 100644\nindex 0000000..e69de29\n" with status added → /Empty file/
- "old mode 100644\nnew mode 100755\n" with status modified → /mode changed.*100644.*100755/
- a normal hu …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4687r on port 4687 with an empty home. I made a scratch clone of MQTT-MCP (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4687-mqtt) and added it through the UI ("Open another repository", then a new project "v4687r MQTT"). From the composer I started a solo fake run, 2610252154-2c001259, with checks off. It finished as done. In the run's worktree I committed `git mv CODE_OF_CONDUCT.md CODE_OF_CONDUCT-renamed.md`, an empty `empty.txt`, and a 3-byte `blob.bin` that contains a NUL byte, for comparison.

What the API returned (GET /api/runs/<id>/diff):
- The renamed file had status renamed, +0/-0, and the patch "similarity index 100%\nrename from CODE_OF_CONDUCT.md\nrename to CODE_OF_CONDUCT-renamed.md\n".
- empty.txt had status added, +0/-0, and the patch "new file mode 100644\nindex 0000000..e69de29\n".
- blob.bin came back with binary: true.

In a fresh browser profile I went from the run page's "Review changes" button to Review and clicked each file:
- UI[0], the renamed file: the pane showed only the header "CODE_OF_CONDUCT.md → CODE_OF_CONDUCT-renamed.md", with 0 rows and no message.
- UI[3], empty.txt: the pane showed only the header "empty.txt", with 0 rows and no message.
- UI[1], blob.bin: the pane showed "Binary file — no text diff." (and no file header).
- The normal file showed its hunk as expected.
- No console errors and no 5xx responses.

Screenshots of the blank panes:
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4687r/002-review-CODE_OF_CONDUCT-renamed.md.png
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4687r/004-review-empty.txt.png

These match the reporter's UI[0] and UI[9]. Nothing in docs/*.md, in the code comments or in the tests says the blank pane is intended. The only special case is binary files. The tester's environment did not cause this: I reproduced it on a fresh home, a fresh profile, my own clone and my own fixture commit.

Cleanup: I deleted the run through the rail "Run actions" menu (Delete…, DELETE returned 200, and the run list is now empty) and stopped the v4687r server; ports 4687 and 4688 are free. I removed the scratch clone and its bare repo, which also removed the leftover worktree and the codeflow/2610252154-2c001259/solo branch. For  …

</details>

### t17-9 · minor · Draft line comments stay on the same line numbers after the branch moves

**Fix outcome: fixed.** I anchored drafts by content instead of adding a head-commit field. ui/review.tsx placeComments/placeOf put a draft on its own line while that line still has its code, otherwise on the nearest line on the same side with that code. A draft whose code is gone is never put on the line that took its number: FileDiff lists it in a .comments-elsewhere block above the diff ('Line 3: Usage …', with Remove). commentsMessage(comments, general, files) sends the current line, or 'README.md (was line 2; that code has changed or is no longer in the diff)'. Review warns about drafts on files the branch no longer changes and offers 'Discard'. The Changes tab resolves lines against the whole branch diff plus the Last-step diff. docs/github.md describes this.

Fixer's check: QA server f06, script s2-drift.mjs, done like the tester: on README.md I commented on context line 2 ('> from npm …') and line 3 ('Usage'). I then committed three lines inserted at the top plus 'Usage' → 'Usage guide' in the run worktree and clicked Refresh changes. The first draft now sits under '2 5 > from npm …', not under '+inserted B'. The 'Usage' draft is listed as code no longer in the diff. Send 2 comments posted '1. README.md:5 — `> from npm …`' and '2. README.md (was line 3; that code has changed or is no longer in the diff) — `Usage`', with no 'README.md:2'. The follow-up finished done, browser errors were [], and axe found 0 violations. Screenshot /private/tmp/claude-501/-Users-m …

Tests: `test/qa-review-diff-comments-ui.test.ts`, `test/e2e/qa-review-diff-comments.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-10, GIT-11, GIT-12.

**Repro**

> 1. In Review, add a draft comment on README.md context line 2 ('> from npm ...'). 2. Add a commit to the branch that inserts 3 lines at the top of README.md (for example a side chat or external update). 3. Click Refresh changes and open README.md.

**Expected:** The draft stays anchored to its code, or is flagged as outdated.

**Actual:** The comment now appears under '+inserted B'. When sent, it still says README.md:2 with the old code text, which no longer matches that line.

**Root cause (verifier):** ui/review.tsx:14-20: the Comment draft records only {file, side, line, code, text}. It stores no branch head commit and no hunk anchor. Drafts persist per run and branch under "comments:<run>:<branch>" (review.tsx:30-52), with nothing tied to the commit they were written against.
FileDiff places a draft purely by line number. review.tsx:248 is `const at = (side, line) => comments.filter((c) => c.side === side && c.line === line)`, and it is used at line 277 (`const here = commentable ? at(side, line) : []`). After the branch moves, the new diff (re-fetched at review.tsx:80-96 on Refresh or on run status change) puts different code at that line, and the draft attaches to that code. Nothing compares c.code with row.text.
commentsMessage (review.tsx:205-208) then sends `${c.file}:${c.line}` together with the stale c.code. The agent gets a line number that no longer matches the quoted code.
Aggravating case: if the old line number lands outside every hunk in the new diff, the draft is not rendered at all. It still counts in the file badge and in "Send N comments" and is still sent.
By contrast, review coverage is commit-scoped (src/engine.ts:4284-4290 returns head and stale; ui/review- …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/changes.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-views.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** Anchor each draft to the code and the commit it was written against, then re-anchor or flag it when the diff changes.
1) Add `head?: string` to Comment (review.tsx:14). Fill it when a draft is added, from the review-coverage response, which already returns `head` (Review already calls /review-coverage at review.tsx:84). Changes.tsx can call the same endpoint, or the diff endpoint could return head too.
2) Replace the line-only match in FileDiff (review.tsx:248) with a resolver that runs once per parsed `rows`:
   - If the row at (side, line) has text === c.code, keep it.
   - Otherwise search the file's rows on the same side for a unique row whose text === c.code, preferring the one nearest the old line, and attach the draft there with a small "line moved" note.
   - If no unique match exists, render the draft as "Outdated: was README.md:2 `<code>`" in a block at the top of the file. Do not attach it to an unrelated line. Never drop it silently.
3) In commentsMessage, send the resolved …

**Suggested regression test:** Unit test: in test/chat-views.test.ts, which already bundles ui/review.tsx with esbuild, export the new draft resolver. Given the parsed rows of a patch where the commented line ("> from npm ...", new line 2) moves to new line 5 after three lines are inserted above it, assert the resolver returns line 5 rather than the "+inserted B" row. Given a patch where that text is gone, assert it returns outdated and is not attached to any row. Also assert commentsMessage for a resolved draft emits "README …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4677t179 on 127.0.0.1:4677 with a fresh home. Made a scratch clone of MQTT-MCP (clones/v4677t179-mqtt) and seeded one solo fake run through the API (run 2610252150-e0a23b62, branch codeflow/2610252150-e0a23b62/solo). In the run worktree I committed an edit to README.md line 5, so README appears in the diff with context lines 2-4. Then in the browser (script work/v4677t179/repro.mjs, log repro.log):
1) Opened #/review/<id>/<branch>, selected README.md, clicked the context row "2 2 > from npm (requires uv) or PyPI; ..." (the editor reads "Comment on line 2"), typed "Please mention pip install here" and pressed Cmd+Enter. localStorage key comments:<id>:<branch> = [{file:"README.md",side:"new",line:2,code:"> from npm (requires uv) ...",text:...}]. The comment showed under the 'from npm' line.
2) External branch update: prepended "inserted A/B/C" to README.md in the worktree and committed (71fe918).
3) Clicked "Refresh changes" and reopened README.md. The hunk is now @@ -1,8 +1,11 @@, and the draft comment row sits directly under " 2 +inserted B". The 'from npm' line is now new line 5 with no comment. There is no outdated or stale marker. The file list still shows a count of 1 and the button reads "Send 1 comment". Screenshot: shots/v4677t179/002-2-after-refresh.png.
4) Clicked Send 1 comment. The captured POST /followups body was: "1. README.md:2 — `> from npm (requires uv) or PyPI; the command remains `mqtt-mcp`.`\n   Please mention pip install here". README.md line 2 is now "inserted B".
No console errors or 5xx responses.
Attempts to refute it failed:
- Not by design. docs/github.md:7 says "Refresh changes reloads the diff and coverage after an external branch update; coverage is reset when the commit changes". ui/review-coverage.tsx:29 says coverage "resets when the branch moves". So the app already treats branch movement as invalidating review state, but drafts get no equivalent handling and no doc mentions it.
- Not caused by the tester's script. I clicked the row by its text, not by position, and saw the same drift.
- Not environmental. The logic is pure client-side keying.
The reporter's external commit is a documented scenario. The branch can also move through side chats or chat follow-ups while drafts persist in localStorage. The Review effect also re-fetches the diff automatically whenever run status or lastCheck changes (review.tsx:96), so the comment can move without any click.
Cleanup: deleted the run through the UI (ra …

</details>

### t17-10 · minor · Review 'Send to' shows Claude Code with Send disabled when the writer is unknown

**Fix outcome: fixed.** ui/run.tsx AgentPicker now takes value: AgentId | undefined and a placeholder. With no value it renders a disabled, selected '' option ('Choose an agent…' or 'Loading recipient…'), so picking any agent, including the first, fires change. ui/review.tsx: recipient = chatProvider ?? agent ?? lastWriter with no 'claude' fallback. The label reads 'Send to', the select shows the placeholder, and a disabled Send has title 'Choose who gets these comments'.

Fixer's check: QA server f06, script s3-recipient.mjs. I started a council run (three read steps) and opened Review as a user would: run page > side panel Changes > Full review. Before any pick the select value was '' and showed 'Choose an agent…' (disabled option), and Send was disabled with its title. Typing 'Claude' on the focused select fired 1 change event, against 2 needed before the fix. Value became claude and Send enabled. With GET /api/runs/:id answering 503 on a pipeline run, the page showed 'Couldn't load this run…' and the placeholder, and Send was disabled. After a normal reload it showed Codex with Send enabled. Browser errors [], axe 0. Screenshot /private/tmp/claude-501/-Users-mx--codex-wo …

Tests: `test/e2e/qa-review-diff-comments.e2e.ts`, `test/e2e/daily-workflow.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-12.

**Repro**

> 1. Run a Review council (no write steps). 2. Open its Review page and type an overall comment.

**Expected:** Either no agent is preselected (a placeholder), or the displayed agent can be used.

**Actual:** The label says 'Choose an agent' and the select shows 'Claude Code', but Send stays disabled. In a real browser, picking the option that is already selected fires no change event, so the user has to pick another agent and then Claude again.

**Root cause (verifier):** Disabling Send until a recipient is known is deliberate. Commit 991c2f3 (PR #42) added it, docs/getting-started.md:94 says "Sending waits for the original writer to load unless you explicitly choose a recipient", and test/e2e/daily-workflow.e2e.ts:331 covers the loading case. What is wrong is how the control shows the "writer unknown" state:
- ui/review.tsx:102: `const target: AgentId = agent ?? defaultAgent ?? "claude";` falls back to claude for display.
- ui/review.tsx:105: canSend requires `!!(agent ?? defaultAgent)`, which ignores that fallback.
- ui/review.tsx:209-210: the label says "Choose an agent", but `<AgentPicker value={target} .../>` shows Claude Code as already chosen.
- ui/run.tsx:1626-1637: AgentPicker has no placeholder or empty option, so the select can't show "nothing chosen". Picking the visible option never fires onChange, so setAgent is never called.
- ui/run-experience.ts:7-11: resultAgent returns undefined for any non-solo run without a write step in that worktree, unless the worktree is "integration". That includes every Review council ("review" worktree, read-only steps). It also includes the case where the run fails to load (the runError branch of the lab …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/changes.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`

**Suggested fix:** 1. Give AgentPicker an optional placeholder (ui/run.tsx:1626). Its value becomes `AgentId | undefined`. When there is no value it renders a first `<option value="" disabled>Choose an agent…</option>` and selects it, so any real pick fires change.
2. In ui/review.tsx, replace `target` with `const recipient = agent ?? defaultAgent;`. Render `<AgentPicker value={recipient} placeholder={run || runError ? "Choose an agent…" : "Loading…"} onChange={setAgent} />` and post `agent: recipient`. canSend already guarantees it is set.
3. Give the disabled Send button a title or help text such as "Choose who gets these comments", so the reason is visible.
4. Optional, for consistency with docs/getting-started.md:94: apply the same rule in ui/changes.tsx:67-70. Use a placeholder plus a canSend that requires a known recipient, instead of silently falling back to "claude".

**Suggested regression test:** Add a test next to the "review waits for the actual writer…" test in test/e2e/daily-workflow.e2e.ts. Start a council run with fake agents (pattern "council") and wait until it is done. Open `#/review/<id>/<worktrees[0].branch>` and fill "Overall comment". Then assert:
- the "Agent" combobox has inputValue "" and its selected option text is "Choose an agent…";
- "Send comments" is disabled.
Then `selectOption("claude")` and assert Send is enabled and the label reads "Send to". Because Playwright  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4679 on 127.0.0.1:4679. I moved the old v4679 home aside first and used a fresh browser profile for the check. I made a new scratch clone of MQTT-MCP and added it through the UI ("Open another repository", new project "v4679 MQTT"). In the composer I chose Run options > Advanced > workflow "council" and started run 2610252152-ecb3d423. It finished "done" with one worktree "review" (branch codeflow/2610252152-ecb3d423/review), no artifacts, and three read-mode steps: Review A (claude), Review B (codex), Merge the reviews (claude). There were no write steps.
I opened the Review page the way a user would: run page > side panel > Changes > "Full review". Before typing, the label said "Choose an agent", the select value was claude and Send was disabled. I clicked the Overall comment box and typed "Please tighten the loop bound". After that the label still said "Choose an agent", the select still showed "Claude Code" (options: Claude Code, Codex, Antigravity CLI), and the "Send comments" button stayed disabled with no hint why (screenshot shots/v4679/002-t1710-review-disabled.png).
Re-picking the option already shown does nothing: assigning the same selectedIndex fired 0 change events and Send stayed disabled, as the HTML spec says (change fires only when the selection actually changes). Keyboard typeahead "Claude" fired 2 change events because it passes through Codex first (C), and only then did Send enable. Playwright's selectOption("claude") always sends synthetic input/change events, which enabled Send and switched the label to "Send to". That means Playwright-based tests hide the bug, but a real mouse user picking the visible "Claude Code" gets no change.
No console errors. Cleanup: I deleted the run through the UI (the delete dialog keeps branches and worktrees by design). I then removed the scratch clone and its bare repo, which held that worktree, and removed the browser profile. The QA server is stopped and nothing is listening on 4679 or 4680.

</details>

### S04-4 · minor · When no writer is known, AgentPicker displays 'claude' while the label reads 'Choose an agent' and Send stays disabled. Choosing the option already shown fires no change event, so the user must pick another agent and switch back.

**Fix outcome: duplicate.** Same defect as t17-10 (the 'claude' display fallback in the Review AgentPicker), fixed there: the placeholder option plus recipient without a fallback.

Fixer's check: See t17-10. The run-load-503 case from this report was re-run in s3-recipient.mjs: warning shown, placeholder shown, Send disabled until a choice.

Tests: `test/e2e/qa-review-diff-comments.e2e.ts`

Source: code-level suspect at `ui/review.tsx:210` (confirmed hands-on).

**Repro**

> Fake server s04, Codex chat 2610251732-9438059e (done). Playwright routed GET /api/runs/<id> to 503 and opened #/review/<id>/<branch>, then filled #general. Read .review-to, the select value, selectedOptions text and the button's disabled state. Added a change listener, then pressed Home (0 events, still disabled), then 'a' and later 'c' (2 events, Send enabled). Script: work/s04/review.mjs, log: work/s04/review.log, screenshot: shots/s04/001-review-choose-agent.png.

**Expected:** With no known writer, the picker shows an empty 'Choose an agent…' placeholder, and selecting any provider, including Claude, enables Send.

**Actual:** With /api/runs/:id failing, the Review page showed the warning 'Couldn't load this run…', the label 'Choose an agent', the select displaying 'Claude Code' (value claude), and 'Send comments' disabled with an overall comment typed. Selecting the shown option by keyboard (Home on the focused select) produced 0 change events and Send stayed disabled. Only after switching to 'Antigravity CLI' (change event, label becomes 'Send to') and back to 'Claude Code' did Send become enabled with Claude.

**Root cause (verifier):** `target = agent ?? defaultAgent ?? "claude"` is passed as the select's value, so the select shows 'Claude Code' as if it were chosen. canSend requires `agent ?? defaultAgent` (line 105), and `agent` is set only by the select's onChange. A native select fires change only when the selection actually changes, so re-selecting the shown option leaves `agent` null.

**Suggested fix:** Let AgentPicker take an optional empty value with a disabled placeholder option ('Choose an agent…'). In Review, pass `agent ?? defaultAgent ?? ""`, so the shown value is the placeholder whenever the recipient is unknown and any real choice fires onChange. Apply the same to the Changes tab once it also requires an explicit recipient.

**Suggested regression test:** e2e: fail GET /api/runs/:id on the Review page, assert that the select shows the placeholder and Send is disabled, choose Claude Code with selectOption, and assert Send is enabled and the posted follow-up has agent claude.

### S04-2 · major · The Changes tab's comment recipient falls back to 'claude' until /api/runs/:id loads, or for good if that request fails. canSend does not wait for the real writer, so comments can go to the wrong provider.

**Fix outcome: fixed.** ui/changes.tsx: recipient = chatProvider(run) ?? agent ?? lastWriter(full) with no 'claude' fallback, and canSend now requires a recipient. A failed run load sets fullError and keeps the last good run instead of clearing it. The picker shows 'Loading recipient…' or 'Choose an agent…', and the help text says 'Couldn't load who wrote this: choose who gets them'. For an Agent chat the provider comes from the RunSummary (new chatProvider in ui/run-experience.ts), so it is right before /api/runs/:id loads.

Fixer's check: QA server f06, script s4-changes.mjs, side panel Changes tab with a line-comment draft. Codex Agent chat with GET /api/runs/:id delayed 8 s: at t+0.8 s 'To: Codex' was shown (fixed), and Send posted {kind: comments, agent: codex}. The follow-up f1 ran Codex, and there were no Claude steps (the bug report had agent claude). Pipeline run delayed 8 s: the select showed 'Loading recipient…' with Send disabled, then Codex after the load. With 503: 'Choose an agent…', the warning help text and Send disabled, and choosing Claude Code enabled Send. Browser errors [], server log clean. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/sc …

Tests: `test/e2e/qa-review-diff-comments.e2e.ts`, `test/qa-review-diff-comments-ui.test.ts`

Source: code-level suspect at `ui/changes.tsx:67` (confirmed hands-on).

**Repro**

> Fake server s04. Ran a Codex Agent chat to done. Opened the side panel, Changes tab, opened a file, clicked a diff line and added the comment 'Rename this file to something meaningful'; the picker showed 'Codex'. Reloaded with a Playwright route on GET /api/runs/<id>: delayed 8 s (work/s04/changes2.mjs slow send) or 503 (changes2.mjs fail). Read .changes-send select value and the disabled state, clicked Send, then checked run.followUps and the steps via the API: f1 agent=claude; steps s3 claude 'Address review comments'. Screenshots: shots/s04/003-changes-slow-late.png and 002-changes-fail-late.png.

**Expected:** Send stays disabled, showing 'Loading recipient…', until the writer is known. If the run fails to load, the tab shows a warning and asks the user to choose an agent. For a Codex chat the default recipient is Codex.

**Actual:** Codex Agent chat, Changes tab with one comment draft. With GET /api/runs/:id delayed 8 s: at t+0.8 s the picker showed 'Claude Code' with Send enabled. Clicking Send at t+0.9 s created follow-up f1 {kind: comments, agent: claude}. Claude then ran in the Codex chat's worktree and committed 'claude: address review comments (f1)'. With GET /api/runs/:id returning 503, the picker stayed 'To: Claude Code' with Send enabled for the whole observation (about 10 s) and no warning appeared. After a normal load it shows 'Codex'.

**Root cause (verifier):** `target = agent ?? lastWriter(full, worktree?.name) ?? "claude"`, and `canSend` only checks status, worktree, comments and sending (ui/changes.tsx:67-70). `full` starts as null and is reset to null on any fetch error (line 62). Comment drafts persist in localStorage, so Send is ready the moment the tab mounts. Review.tsx, by contrast, requires `agent ?? defaultAgent` and shows a load-error warning (review.tsx:105, 186, 208). For Agent chats the RunSummary already holds pattern, roles and conversationAgent, so the real recipient is known without waiting for the full run.

**Suggested fix:** Compute the default from the RunSummary when possible: for solo runs use `run.conversationAgent ?? run.roles.agent?.[0]`, otherwise resultAgent(full, ...). Make canSend require `!!(agent ?? writer)`, as review.tsx does. Show 'Loading recipient…' while loading. On fetch failure keep an error state and show a 'Couldn't load this run, choose who gets the comments' message instead of silently falling back to 'claude'.

**Suggested regression test:** e2e (fake Codex chat with a saved comment draft): route GET /api/runs/:id with a delay and assert Send is disabled and the picker is not 'claude' until the load completes, then becomes 'codex'. Route the request to 503 and assert a warning is shown and Send stays disabled until an explicit choice is made. Unit-test a shared recipient helper that returns the solo provider from a RunSummary.

### t17-11 · minor · Single-agent chat provider lock is enforced for replies but not for review comments

**Fix outcome: fixed.** src/engine.ts: a new keepChatProvider(run, agent) helper. followUp applies it to every kind except 'side' (comments, resolve-conflicts, ci-fix, reply), and watchPr refuses a different fixer up front. UI: AgentPicker has fixed mode. For solo runs, Review, the Changes tab, the WatchPanel and the MergePanel's conflict 'Ask' show the chat's provider as text (title 'This chat keeps its provider. Open a provider tab to switch providers.') instead of a select. docs/github.md documents the rule.

Fixer's check: QA server f06, script s5-lock.mjs, Codex Agent chat. POST /followups with agent claude returned 400 'This chat keeps its current provider…' for reply, comments and resolve-conflicts, and followUps stayed at 0. The Review send area read 'Send to Codex' with 0 selects. Sending posted {kind: comments, agent: codex}, and f1 finished done with only Codex steps. The unit test also checks that watchPr with claude throws while codex is accepted, that a default-kind follow-up with agy is refused, and that a side chat with claude is still allowed.

Tests: `test/qa-review-diff-comments.test.ts`, `test/e2e/qa-review-diff-comments.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-12.

**Repro**

> 1. Start an Agent (solo) chat with Codex. 2. POST a reply follow-up with agent=claude: 400 'This chat keeps its current provider...'. 3. In Review, choose Send to Claude Code and send an overall comment.

**Expected:** Same rule for both: the chat's provider is kept, or a provider switch is explicit.

**Actual:** The review comments follow-up is accepted (200) and runs Claude in the Codex chat's worktree.

**Root cause (verifier):** src/engine.ts:3790 enforces the solo provider lock only for kind === "reply":
`if (kind === "reply" && run.pattern === "solo" && input.agent !== (run.conversationAgent ?? run.roles.agent?.[0])) throw ...`
That lets "comments" (and "resolve-conflicts") follow-ups with any agent through. In runFollowUpInWorktree (src/engine.ts:~5815-5822), the session lookup only matches s.agent === f.agent. The other agent therefore starts a fresh session in the chat's worktree, and its step lands in the main transcript. The provider's own later turns resume their old native session, which never saw that turn. The UI encourages this: ui/review.tsx:100-101,209-210 and ui/changes.tsx:67,189 render a free AgentPicker "Send to" for every run pattern. They default to resultAgent(), which for solo returns the conversation provider (ui/run-experience.ts:9), but they do not lock it. Related: for solo runs only kind "reply" takes the no-commit conversation path (src/engine.ts:5865-5871). A comments follow-up falls through to ctx.commit (src/engine.ts:~5875), which commits all working files under the follow-up agent's name.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/changes.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-options.test.ts`

**Suggested fix:** Server: in followUp (src/engine.ts:3790), apply the lock to every main-thread follow-up of a solo run, not only replies. One way: `if (run.pattern === "solo" && kind !== "side" && input.agent !== (run.conversationAgent ?? run.roles.agent?.[0])) throw new Error("This chat keeps its current provider. Open a provider tab to switch providers.")`. Side chats are documented to use any provider, so they stay exempt. ci-fix/watch callers pass w.agent; check that those use the chat's provider for solo runs, or exempt them deliberately. UI: in ui/review.tsx and ui/changes.tsx, when run.pattern === "solo", show the conversation provider as a fixed recipient ("Send to Codex") instead of the free AgentPicker. Optionally add an explicit "Continue with another provider" action that calls POST /runs/:id/provider-chat. Optional follow-up: decide whether a solo "comments" follow-up should take the same no-commit conversation path as "reply" (src/engine.ts:5866), so review feedback doesn't commit the cha …

**Suggested regression test:** In test/chat-options.test.ts, right after the existing reply rejection at line 34, add `await assert.rejects(manager.followUp(run.id, { kind: "comments", worktree, agent: "claude", message: "Switch via review" }), /current provider/);`, then the same with kind "resolve-conflicts" (mergeFrom: "main"). Follow with `assert.equal(run.followUps.length, 0)`. Also assert that `{ kind: "comments", agent: "codex" }` is still accepted, and that `{ kind: "side", agent: "claude" }` is still allowed. For the …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server v4681 on 127.0.0.1:4681 (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/qa-server.sh start v4681 4681 fake). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681/ (start.mjs, review.mjs, reply.mjs) with logs review.log and reply.log.
1. Precondition, set up through the API: POST /api/runs {pattern:"solo", roles:{agent:["codex"]}, repo: MQTT-MCP}. This made run 2610252153-3c06d74d. It finished with status done, one Codex step s1 and conversationAgent unset, so the provider falls back to roles.agent[0]=codex.
2. POST /followups {kind:"reply", agent:"claude"} returned 400 {"error":"This chat keeps its current provider. Open a provider tab to switch providers."}.
3. In the browser I opened #/review/<id>/codeflow%2F<id>%2Fsolo. The "Send to" picker defaulted to "codex" and listed claude, codex and agy. I typed an Overall comment, chose Claude Code and clicked Send comments. The UI sent {"kind":"comments","worktree":"solo","agent":"claude",...} and got 200 {"ok":true}.
4. Result: follow-up f1 (comments, claude) finished as done, and step s2 is "Claude Code / Address review comments" in worktree "solo". The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681/003-run-after.png shows a Claude Code turn inside the "Codex · ..." chat tab, while the composer still says "Message Codex...".
5. Side effects I saw:
 - (a) The comments path committed the Agent chat's working files as "claude: address review comments (f1)" (commit 2c5faa8). That commit included Codex's uncommitted codex-04d52cbe.txt, so Codex's work is credited to Claude. Agent chats are documented as not auto-committing.
 - (b) I then sent a Codex reply through the run composer. Step s3 resumed Codex's original native session ff007e1d (the s1 session), so Codex's context never contains Claude's turn even though the transcript shows it in between.
Why I don't think it is by design: docs/plans/agent-mode-parity-plan.md:13,17 say an Agent chat has one chosen provider and that switching provider opens a new sibling tab with carried context, while the original tab keeps its provider and session. docs/runs.md:64 and :96 say feedback and comments go back to "the agent". POST /runs/:id/provider-chat (docs/api.md:43) is the explicit s …

</details>

### S04-3 · minor · The Agent-chat provider lock is enforced only for kind 'reply'. 'comments' follow-ups from the Review page or Changes tab can run a different provider inside a solo chat's workspace.

**Fix outcome: duplicate.** Same root cause as t17-11 (src/engine.ts followUp locking only kind 'reply'), fixed there, along with the watchPr check and the fixed recipient in the UI.

Fixer's check: See t17-11.

Tests: `test/qa-review-diff-comments.test.ts`

Source: code-level suspect at `src/engine.ts:3790` (confirmed hands-on).

**Repro**

> Fake server s04, same Codex chat 2610251732-9438059e. The comments follow-up with agent claude was sent from the Changes tab. Then curl POST /api/runs/<id>/followups with {"kind":"reply","worktree":"solo","agent":"claude","message":"hello"} returned the lock error, and GET /api/runs/<id> steps showed ['s3','claude','Address review comments','done']. `git log` in the worktree showed the claude commit.

**Expected:** A comments follow-up on an Agent chat uses the chat's provider. Choosing another provider is refused with the same 'keeps its current provider' error, or is routed through the provider-tab handoff (provider-chat), as replies are.

**Actual:** On a Codex Agent chat, POST /followups {kind: reply, agent: claude} returned 'This chat keeps its current provider. Open a provider tab to switch providers.' The comments follow-up with agent claude was accepted. A Claude step 'Address review comments' ran in the Codex chat's worktree, appeared in the Codex tab's history (screenshot shots/s04/003-changes-slow-late.png), and committed 1eeeca0 'claude: address review comments (f1)'. The composer still read 'Message Codex…'. This server gap is what let the Changes-tab misroute (ui/changes.tsx:67) take effect.

**Root cause (verifier):** followUp() checks `kind === "reply" && run.pattern === "solo" && input.agent !== (run.conversationAgent ?? run.roles.agent?.[0])` only. runFollowUpInWorktree then runs comments, ci-fix and resolve-conflicts with any f.agent in the chat worktree and commits the result. The design says 'The original tab keeps its own provider, session, and history' (docs/plans/agent-mode-parity-plan.md:17), and the e2e suite asserts that 'a started single-agent chat cannot change provider'. The generic AgentPicker on the Review page and Changes tab still lists every provider for solo chats.

**Suggested fix:** In followUp(), for run.pattern === 'solo' apply the provider check to every non-side kind (comments, ci-fix, resolve-conflicts), not only reply. In the UI, for solo runs, fix the Review/Changes AgentPicker to the chat's provider, or offer 'Send to another provider…' through the existing provider-chat handoff.

**Suggested regression test:** Engine test next to the existing /current provider/ assertion: on a solo codex run, `manager.followUp(run.id, { kind: "comments", worktree, agent: "claude", message: "x" })` rejects with /current provider/, and the same call with agent codex succeeds.
