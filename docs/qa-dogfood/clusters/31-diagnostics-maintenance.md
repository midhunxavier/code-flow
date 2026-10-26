# Cluster 31 · diagnostics-maintenance

**Diagnostics redaction & export, maintenance CLI and retention**

Status: **fixed and independently reviewed** · 9 issues / 6 root causes · branch `codex/qa-diagnostics-maintenance`

Planner notes: t24-3 (major): the key/value redaction at src/privacy.ts:11 allows only whitespace between the key and '=' or ':'. JSON-quoted secrets ("api_key": "...") and Authorization token/Basic headers therefore leak into the diagnostics export. t03-16: later patterns run over earlier [REDACTED] output and garble it. Rewrite redactText as a single pass or with non-overlapping replacements, and add tests. t24-4/S15-4: the preamble at src/workspace-api.ts:46 requires a valid repo for every route, diagnostics included. t24-5/S12-3: retention-settings in scripts/maintenance.ts writes without taking server.lock. t24-13: the retention preview lists already-cleaned runs as protected, with a raw ENOENT as the reason. t24-14/S12-4: the maintenance CLI reports raw EEXIST/ENOENT, and it checks the output path and password only after the expensive work (writeExclusive and createEncryptedBackup in src/maintenance.ts). Duplicate groups: [["t24-4","S15-4"],["t24-5","S12-3"],["t24-14","S12-4"]]

Likely files: `src/privacy.ts`, `src/workspace-api.ts`, `src/log.ts`, `scripts/maintenance.ts`, `src/maintenance.ts`, `src/retention-policy.ts`, `ui/settings.tsx`

## Continuation outcome · 2026-10-26

| Issue | Outcome | Fresh evidence |
|---|---|---|
| t24-3 | Fixed. Credential assignments recognize quoted and multiply JSON-escaped keys/values, all Authorization schemes, cookie headers, common vendor formats and environment-style keys. Quoted values with whitespace, escaped quotes and trailing backslashes are consumed completely. Numeric token metrics remain intact. Truncated leading log records are omitted to avoid exporting an unkeyed secret fragment. | Table-driven nested-log tests; actual isolated server-log records collected and downloaded through Advanced settings. Fake markers absent from export. |
| t03-16 | Fixed. Assignment redaction runs first and consumes an existing placeholder in full; repeated redaction stays stable. | Original Files → add uncommitted file → Context inspector → Preview replay; visible `api_key = "[REDACTED]"`, no `TOKEN]` fragment. |
| t24-4 / S15-4 | Fixed. Diagnostics and capabilities accept an unavailable optional repository. Git version is collected from the application home; workspace file operations still reject missing repositories. Starting a new collection clears the previous export, so failed collection cannot export stale data. | Selected scratch repository renamed away while the page stayed open; Collect succeeds with `repository: "missing"`. Exact injected diagnostics500 removes Export and displays the error. |
| t24-5 / S12-3 | Fixed. Offline retention settings and preview take `server.lock`; policy revision checking and atomic write now share a cross-process lock with stale-owner recovery. | Settings command rejected while an actual QA server holds its lock; saved policy byte-identical. Two simultaneous child processes saving revision0 produce one success, one409, final revision1. |
| t24-13 | Fixed. Absent managed workspace roots are omitted; symlink/non-directory ancestry remains protected and filesystem reasons use readable wording. | Fake Fix & review run archived through the UI, with branch deletion to also remove staged context; Data & storage preview shows no attachments/worktrees protection for the absent root. Unit cases cover both absent parent/root and malicious ancestry. The current branch intentionally retains staged context while keeping branches; that variation has a real directory and remains eligible for ordinary retention. |
| t24-14 / S12-4 | Fixed. Backup/plan output collisions and missing parents are checked before scan/encryption; backup password length is validated before home traversal; exclusive final write still protects races. Missing run and input files have direct messages. | Offline CLI backup success → duplicate refusal with unchanged bytes; plan success → duplicate refusal; missing compact run; missing input/parent cases; short password rejected before nonexistent home lookup. |

Validation: `npx tsc --noEmit`; 38 focused/related unit/API/CLI cases; 14 store-reliability/context-inspection cases; five new Chrome scenarios plus the existing retention Chrome workflow all passed. Existing `test/maintenance.test.ts` changes only its old raw-EEXIST assertion to the intentional friendly message; new cases are in `test/qa-diagnostics-maintenance.test.ts` and `test/e2e/qa-diagnostics-maintenance.e2e.ts`.

Evidence: `/private/tmp/codeflow-qa-continue/diagnostics31-targeted.log`, `diagnostics31-related.log`, `diagnostics31-e2e-final.log`, `diagnostics31-typecheck.log`; screenshots and captured browser/server logs under this branch's `output/playwright/qa-diagnostics-maintenance/`. Context and retention screenshots were visually inspected. No unexpected browser errors; the test distinguishes one injected diagnostics500 and a handled `/api/fs`404 for the exact workspace removed by archive. No unexplained server errors. All commands used an explicit scratch `CODEFLOW_HOME`; repositories/homes were disposable, fake providers only, no real-agent evidence.

Independent adversarial review found and repaired four additional edge cases before integration: Digest and quoted-cookie header fragments, backslashes in bare credential values, credential objects/arrays nested in JSON strings, and a regular-file output parent producing raw ENOTDIR. `test/qa-diagnostics-review.test.ts` contributes four cases including 294 quoted-value/key/escape-depth combinations; the downloaded diagnostics replay now includes Digest, Cookie and structured credential fixtures. A separate process probe killed its own lock holder, then raced six writers in four rounds: exactly one writer per revision succeeded, all five others returned409, final revision4, no leftover lock. Probe scripts/logs: `/private/tmp/codeflow-qa-continue/review31/`. All probes used explicit scratch homes. No unresolved cluster31 product issue remains.

## Issues

### t24-3 · major · Diagnostics export says credential-like values are redacted but leaks JSON-quoted secrets and token/Basic Authorization headers

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-20.

**Repro**

> 1. In a throwaway QA home, have server.log contain an error such as: Request failed: {"api_key":"FAKE...","password":"FAKE..."} or 'Authorization: token FAKE...' / 'Authorization: Basic RkFL...'. Every server.log line is JSON, so any error message that embeds a JSON body or headers looks like this. 2. Settings > Advanced > Collect diagnostics > Export diagnostics. 3. Search the exported codeflow-diagnostics.json.

**Expected:** Credential-like values are redacted, as the card promises ('Credential-like values are redacted before export').

**Actual:** The JSON-quoted api_key and password values, the 'Authorization: token X' value and the Basic auth credential appear verbatim in recentErrors. Calling redactText directly also leaves '{"password":"abc12345xyz"}', '"token":"tok_..."', 'secret=abc12345', 'AWS_SECRET_ACCESS_KEY=...' and Slack xoxb- tokens unchanged. URL credentials, Bearer, ghp_, x-api-key and env-var values are redacted correctly.

**Root cause (verifier):** The main cause is src/privacy.ts:11. The key/value rule `((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[=:]\s*["']?)[^\s"',;}]+` only allows whitespace between the key name and `=`/`:`. In JSON (`"password":"x"`) a closing quote sits there, and in server.log (`\"password\":\"x\"`) a backslash and a quote do, so neither form matches. Its key list also leaves out bare `token`, `secret`, `authorization` and `*_SECRET_ACCESS_KEY`/`*_TOKEN` names.

Other gaps in the same file:
- **privacy.ts:9** handles only the `Bearer` scheme, so `Authorization: token X` (GitHub style) and `Authorization: Basic <b64>` pass through.
- **privacy.ts:10** matches `token`/`secret`/`password`/`key`/`signature` only as URL query parameters, after `?` or `&`.
- **privacy.ts:8** recognises only sk-, gh*_ and github_pat_ tokens. There is nothing for AWS keys (AKIA/ASIA, aws_secret_access_key), Slack (xox[abprs]-) or other common vendor tokens.

How it reaches the export:
- **src/workspace-api.ts:158-160** reads the last 32 KB of server.log (diagnosticTail, lines 27-38) and puts it into `recentErrors` as one plain string.
- **privacy.ts:23** can redact by key name (password, token, authorization …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/privacy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/log.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/privacy.test.ts`

**Suggested fix:** 1. **privacy.ts key/value rule.** Allow an optional closing quote and backslash between the key and the separator, and an optional escaped quote after it. For example: `(\\?["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|passwd|private[_-]?key|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))\\?["']?\s*[=:]\s*\\?["']?)[^\s"'\\,;}&]+`. Keep counters such as `inputTokens: 25` working, either by requiring a word boundary or by allowing only non-numeric values for bare `token`.
2. **Authorization headers.** Add a rule for any scheme: `(\bauthorization\\?["']?\s*[:=]\s*\\?["']?(?:Bearer|token|Basic|Digest)?\s*)[^\s"'\\,;}]+` should become `$1[REDACTED]`. Also redact `\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}`.
3. **Vendor tokens.** Add `\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, `\bxox[abposr]-[A-Za-z0-9-]{10,}`, `\b(?:sk|rk)_live_[A-Za-z0-9]{16,}`, `\bAIza[0-9A-Za-z_-]{35}`, `\bnpm_[A-Za-z0-9]{36}` and `\bglpat-[A-Za-z0-9_-]{20,}`.
4. **St …

**Suggested regression test:** 1. **test/privacy.test.ts.** Add a table-driven test. For each input, assert that `redactText(input, [])` no longer contains the secret:
   - `{"password":"abc12345xyz"}`
   - the escaped form `{\"api_key\":\"abc12345xyz\"}`
   - `{'password': 'abc12345xyz'}`
   - `Authorization: token abcdefghijklmnop`
   - `Authorization: Basic dXNlcjpwYXNzd29yZA==`
   - `"token":"tok_abcdefghijk"`
   - `secret=abc12345`
   - `AWS_SECRET_ACCESS_KEY=wJalr…`
   - `AKIAIOSFODNN7EXAMPLE`
   - `xoxb-1234567890-0987 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server on 127.0.0.1:4663 with a new home (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4663-t243). I skipped the old v4663 home because it held earlier state. I wrote no lines by hand: I used CodeFlow's own logError (src/log.ts) to write 6 realistic error entries into that home's server.log, with random FAKE values (script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663-t243/plant.mjs, values in markers.json in the same folder). The entries were:
- a JSON body `Request failed: {"api_key":"FAKEJK…","password":"FAKEJP…"}`
- `Authorization: token FAKEAT…`
- `Authorization: Basic <base64>`
- `Authorization: Bearer FAKEBR…` (control)
- `api_key=FAKEPK…` (control)
- `{"token":"tok_FAKE…"} secret=… AWS_SECRET_ACCESS_KEY=… xoxb-… x-api-key: …`

Because log.ts:22 JSON-encodes every line, the file stores these as `{\"api_key\":\"…\"}`. That is what any error message with a JSON body looks like on disk.

Next, in a fresh headless Chrome (no saved profile; script diag.mjs in the same folder) I went to Settings > Advanced. The Diagnostics card says "Credential-like values are redacted before export." I clicked Collect diagnostics, then Export diagnostics, and searched the downloaded codeflow-diagnostics.json (saved in the same folder):
- **Leaked verbatim in recentErrors:** jsonApiKey, jsonPassword, the `Authorization: token` value, the Basic credential, `"token":"tok_…"`, `secret=…`, the AWS secret and the Slack xoxb- token.
- **Redacted correctly:** Bearer, `api_key=`, `x-api-key:` and the server's CODEFLOW_TOKEN (matched by its value from the environment).
- No console or 5xx errors.

Last, I called redactText(text, []) directly (redact.mjs, output in redact.log):
- **Unchanged:** `{"password":"abc12345xyz"}`, its escaped form `{\"password\":\"…\"}`, `{"api_key": "…"}`, `{'password': '…'}`, `Authorization: token …`, `Authorization: Basic …`, `"token":"tok_…"`, `token=…`, `secret=…`, `GITHUB_TOKEN=…` as literal text, `AWS_SECRET_ACCESS_KEY=…`, `AKIA…` and `xoxb-…`.
- **Redacted:** `password: "…"`, `password=…`, `client_secret=…`, Bearer, `?token=` in a URL, credentials in a URL, ghp_, sk- and `x-api-key:`.

Why I don't think it is by design: docs/api.md:64 promises "sanitized recent logs". privacy.ts:11 already allows an optional quote after the separator, which shows it meant to …

</details>

### t03-16 · cosmetic · Context inspector redaction garbles an api_key whose value is a token: shows '[REDACTED] TOKEN]'

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-34.

**Repro**

> 1. Add an uncommitted file containing 'api_key = "sk-ant-api03-QAFAKE…"' as context (Files > +).
> 2. Run options > Context inspector > Preview selected context > expand the file.

**Expected:** api_key = "[REDACTED]" (or [REDACTED TOKEN]).

**Actual:** api_key = "[REDACTED] TOKEN]"

**Root cause (verifier):** In src/privacy.ts, redactText applies its regexes one after another, and later patterns run on text that earlier patterns already replaced. Line 8 replaces sk-/gh*_/github_pat_ tokens with the 2-word placeholder "[REDACTED TOKEN]". Then line 11 runs: `/((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi`. Its value class `[^\s"',;}]+` does not exclude '[' or ']', and it stops at the space inside the placeholder. So it matches only `[REDACTED` and replaces it with `[REDACTED]`, leaving ` TOKEN]` behind. Line 10, the query-parameter pattern `[^&#\s]+`, has the same flaw for `?token=<token>`. The context inspector calls this function at src/context-inspection.ts:84, and so do the other redactText/redactExport users: readiness output, notifications, diagnostics exports, shared projections and others. All of them can show the same garbled label.

**Files:** `src/privacy.ts`, `test/privacy.test.ts`

**Suggested fix:** Stop the key=value and query-parameter patterns from re-matching placeholders that earlier patterns inserted. Any of these works:
(a) Simplest: add a negative lookahead after the captured prefix on lines 10 and 11, e.g. `...["']?)(?!\[REDACTED)[^\s"',;}]+` and `([?&](?:token|...)=)(?!\[REDACTED)[^&#\s]+`.
(b) Run the key=value (line 11) and query-param (line 10) replacements before the token-shape replacement on line 8. Then `api_key = "sk-..."` becomes `api_key = "[REDACTED]"`, and line 8 no longer sees a token there.
(c) Use a single placeholder without spaces, e.g. "[REDACTED_TOKEN]". This changes the visible label, so the UI/docs copy would need to agree.
Option (a) or (b) keeps the existing labels and output for every other case.

**Suggested regression test:** Add a case to test/privacy.test.ts, e.g. test("token-shaped values behind credential keys redact once"):
- assert.equal(redactText('api_key = "sk-ant-api03-QAFAKEabcdefghijklmnop"', []), 'api_key = "[REDACTED]"'). If option (a) is used, expect '[REDACTED TOKEN]' instead.
- Assert the same for 'password: ghp_QAFAKEabcdefghijklmnopqrstuv', 'client_secret=github_pat_QAFAKEabcdefghijklmnopqrst' and 'https://x.test/cb?token=sk-ant-api03-QAFAKEabcdefghijklmnop'.
- For all of them, assert.doesNotMatch( …

<details><summary>Verifier's independent reproduction</summary>

1. Started a fresh fake-mode QA server: qa-server.sh start v4665 4665 fake (new home, no runs).
2. Created a scratch repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4665-redact (git init, committed README.md). It has an uncommitted qa-secret.txt containing `api_key = "sk-ant-api03-QAFAKEv4665abcdefghijklmnop"`, `plain_token: sk-ant-...`, `password=hunter2hunter2` and `GITHUB_TOKEN=ghp_...`.
3. Added that repo through the UI ("Open another repository" > Create project "v4665 Redact"). Opened New run > Files, clicked "+" on qa-secret.txt, opened Run options > Context inspector > "Preview selected context", and expanded qa-secret.txt. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/r1.mjs; log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/r1.log.
4. The preview showed `api_key = "[REDACTED] TOKEN]"`. The bare token line shows correctly as `plain_token: [REDACTED TOKEN]`, and `password=[REDACTED]` is also correct. POST /api/workspace/context returns the same garbled preview string, so this comes from the server, not the UI. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/001-redaction-preview.png. No console or page errors appeared.
5. Called redactText directly on a snapshot copy (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/variants.ts, run with npx tsx in builds/v4665). The same garbling happens for `api_key=sk-...`, `password: ghp_...`, `client_secret=github_pat_...` and `?token=sk-...`; each gives `...[REDACTED] TOKEN]`. `Bearer sk-...` and non-token values are fine.
Why this is not by design or an environment problem: docs/context-inspection.md only says that recognized secret patterns are hidden. No test or doc expects "[REDACTED] TOKEN]" (grep finds the literal only at src/privacy.ts:8). The result does not depend on the browser profile, credentials or agent mode. No secret is exposed, because the whole value is still removed; only the label is broken.

</details>

### t24-4 · minor · Diagnostics cannot be collected when the selected repository no longer exists

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-20.

**Repro**

> 1. Create a project for a scratch git repo and select it in New run. 2. Delete that repo folder on disk while the app stays open. 3. Settings > Advanced > Collect diagnostics.

**Expected:** Diagnostics are collected (without the repo-specific git field) and exported. A missing repository is exactly when troubleshooting is needed.

**Actual:** Red 'Choose an existing Git repository' error (HTTP 400). No diagnostics and no Export button. The composer for the same repo shows a friendlier message ('<repo> isn't a git repository'). Reproduced 2/2.

**Root cause (verifier):** The cause is src/workspace-api.ts:46, in the shared preamble of handleWorkspaceApi. That function handles readiness, verification, workspace, diagnostics and v1, and the preamble runs for every one of them:

`const repo = owned?.tree.path ?? (absolute ? await repoRoot(absolute).catch(() => { throw new HttpError(400, "Choose an existing Git repository"); }) : undefined);`

If ?repo= names a path that is no longer a Git repository, the request throws 400 before it reaches the diagnostics branch at lines 156-159. That branch only uses `repo` as the working directory for `git --version` (line 159: `git: repo ? await git(["--version"], repo)... : undefined`), so the repo is not actually needed.

On the client side, ui/settings.tsx:166 (AdvancedSettings) always adds `?repo=${repo.value}` when one is selected. repo.value comes from the cached repoInfo (ui/state.ts:163), which setRepo (ui/state.ts:172-218) only re-checks on selection or reload. So a repository deleted while the app stays open leaves a stale value, and diagnostics fails until the page is reloaded.

The same preamble also makes GET /api/v1/capabilities?repo=<missing> return 400.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workspace-namespace.test.ts`

**Suggested fix:** Fix this on the server (I verified it in the snapshot copy at qa/builds/v4665). In handleWorkspaceApi, treat the repo as optional for routes that only describe the machine: when parts[1] is "diagnostics" or "v1", return undefined from the repoRoot catch instead of throwing 400:

`const optionalRepo = parts[1] === "diagnostics" || parts[1] === "v1"; ... .catch(() => { if (optionalRepo) return undefined; throw new HttpError(400, ...); })`

For the git field, run `git --version` in `repo ?? CODEFLOW_HOME` and tolerate failure (`.then(r => r.stdout.trim(), () => undefined)`). That way the git version is always reported, which also helps when git itself is broken.

Optionally, add a field such as `repository: "found" | "missing"` so the exported bundle shows that the selected repository was unavailable. That is the troubleshooting signal the reporter wanted. Do not include the raw path; redactExport already applies.

Optional UI hardening in ui/settings.tsx:166: if the call with ?repo= fail …

**Suggested regression test:** Add a unit test, either in test/workspace-namespace.test.ts or a new test/diagnostics-missing-repo.test.ts (I wrote and ran this in the snapshot). It calls handleWorkspaceApi directly with a stub manager `{ list: () => [], busy: {...}, inspectRepositoryActivity: () => [] }`, requests GET `/api/diagnostics?repo=<tmpdir path that does not exist>`, and asserts `status === 200`, `body.version === 1` and `body.repository === "missing"`. It also checks that `/api/workspace/file?repo=<missing>` still r …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4665 on port 4665 (the old home was moved aside to homes/v4665.prev-*). I created a scratch repo at qa/clones/v4665-gone with `git init` and one commit.

Run 1 (qa/work/v4665/t24-4/repro.mjs, results in run1.log):
- In New run I clicked "Open another repository", typed the path into the folder picker, chose "Open this repository", then "Create project" (named v4665-gone). The composer showed v4665-gone as the selected repository.
- Baseline: Settings > Advanced > Collect diagnostics worked (GET /api/diagnostics?repo=<path> returned 200) and the Export button appeared.
- I renamed the repo folder away without reloading the app and clicked Collect diagnostics again. GET /api/diagnostics?repo=<path> returned 400 {"error":"Choose an existing Git repository"}. The red alert read "Choose an existing Git repository" and no Export diagnostics button appeared (shot qa/shots/v4665/003-diag-gone.png).
- Direct API calls: /api/diagnostics with no repo returned 200; with the missing repo it returned 400.

Run 2 (repro2.mjs, run2.log), using a fresh browser profile and a real `rm -rf` of the folder, as the reporter did:
- Collect diagnostics failed 2 out of 2 times with the same alert and no Export button.

Refutation checks:
- The reporter's selectors and profile were not the cause; I reproduced it with my own script.
- docs/api.md lists `GET /diagnostics | optional repo query`. The help text says diagnostics are "for the current machine". So failing on a stale repo path is not by design.

Limits I found:
- Reloading the page is a workaround. On reload, /api/branches fails, so repoInfo becomes null and repo.value becomes "". The composer then shows "v4665-gone isn't a git repository. Pick the folder…" and diagnostics succeed without ?repo.
- Before a reload, the composer still shows the deleted repo as selected, with the branch "main" (004-composer-gone.png). The reporter's "friendlier composer message" only appears after a reload.

Fix check:
- In my snapshot copy, a focused unit test (test/diagnostics-missing-repo.test.ts) failed at src/workspace-api.ts:46 before the patch and passed after it. The existing test/workspace-namespace.test.ts still passed.
- I restarted the QA server from the patched snapshot. The same UI flow then collected diagnostics with the Export button shown, 2 out of 2 times.

Cleanup: I deleted the QA project, stopped the server and removed the scratch clone. No runs were created and nothing is left over.

</details>

### S15-4 · minor · GET /api/diagnostics throws 400 when the optional ?repo is not a Git repository. Settings → Advanced always passes the currently selected repo, so a moved or deleted repository blocks diagnostics collection entirely.

Source: code-level suspect at `src/workspace-api.ts:46` (confirmed hands-on).

**Repro**

> QA server s15 (fake), Playwright (qa/work/s15/s3-diag.mjs). Set localStorage repo=<scratch repoC> and loaded the app, so the repo was selected. Went to #/settings/advanced and clicked 'Collect diagnostics': 200, panel shown. Renamed repoC on disk (simulating a moved repository) without reloading, then clicked 'Collect diagnostics' again: GET /api/diagnostics?repo=... returned 400 {"error":"Choose an existing Git repository"}, and the card shows the red alert 'Choose an existing Git repository'. Screenshot: qa/shots/s15/002-diag-fails-after-move.png. The previous 'Collected diagnostics' block also stays visible next to the error, so 'Export diagnostics' would export stale data.

**Expected:** Diagnostics are collected. The git field is the git version (or is omitted / notes that the selected repository is missing), since a missing repository is exactly when someone collects diagnostics.

**Actual:** Collection fails with an error about choosing a repository on a page that has no repository chooser. Stale diagnostics stay on screen.

**Root cause (verifier):** handleWorkspaceApi resolves selected/absolute for every route, including diagnostics, and calls repoRoot(absolute).catch(() => { throw new HttpError(400, 'Choose an existing Git repository') }) before branching on parts[1]. Diagnostics only uses repo as the cwd for `git --version`, which needs no repository. ui/settings.tsx:166 appends ?repo=repo.value whenever a repo is selected, and repo.value stays set for the life of the tab after the repo was validated once.

**Suggested fix:** In handleWorkspaceApi, make repo resolution lazy, or skip it for parts[1]==='diagnostics'. Run `git --version` without a repo cwd (or with process.cwd()), and optionally add repoStatus:'missing'. In the UI, call setDiagnostics(undefined) when a collection starts or fails.

**Suggested regression test:** API test: GET /api/diagnostics?repo=/nonexistent/path returns 200 with a git version. UI test: after a failed collection, the old 'Collected diagnostics' block is not shown.

### t24-5 · minor · maintenance retention-settings writes into a running server's data directory without taking server.lock

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-23.

**Repro**

> 1. Run a QA server on home H. 2. Open Settings > Data & storage, save settings (rev 1) and preview. 3. While the server is running: npx tsx scripts/maintenance.ts retention-settings --input settings.json --home H. 4. Stop the server and apply the downloaded rev-1 plan.

**Expected:** Per docs/maintenance.md ('Stop the code-flow server before running maintenance. Every operation against an existing data directory takes the same exclusive server.lock'), the command is refused while the server holds the lock, like backup/apply/compact.

**Actual:** The command succeeds while the server runs and bumps the policy to revision 2 underneath it. The open UI's preview/plan silently becomes stale, and its apply later fails with 'Data, ownership or policy changed after preview'. backup and retention-policy --apply are correctly refused in the same state.

**Root cause (verifier):** scripts/maintenance.ts:56-59. The `retention-settings` branch creates `new RetentionPolicyStore(join(home, "retention-policy.json"))`, reads the policy and calls `store.set(...)`. It never calls `acquireLock(0, home)`, and it never resolves the home with homePath/realpath. Every other command that touches an existing home goes through `offline()` in src/maintenance.ts:32-36 (backup, retention --days, compact, even compact without --apply) or through `acquireLock` in applyRetention (src/retention-policy.ts:242), so those refuse to run while the server holds the lock.
RetentionPolicyStore.set (src/retention-policy.ts:53-55) checks the revision inside a per-process promise queue (`policyQueues`, line 33). Two processes can both read revision N and both write N+1, because atomicJson only renames the file into place without comparing first. Without the lock, the CLI can therefore silently overwrite or race a running server's settings.
This contradicts docs/maintenance.md:7 ("Every operation against an existing data directory takes the same exclusive server.lock ... and refuses to run while another server holds it"), docs/maintenance.md:38 ("concurrent saves cannot overwrite each other") …

**Files:** `scripts/maintenance.ts`, `src/maintenance.ts`, `src/retention-policy.ts`, `test/retention-policy.test.ts`, `docs/maintenance.md`

**Suggested fix:** Run the retention-settings write under the same offline lock as the other maintenance commands:
- Export a small helper, e.g. `saveRetentionSettingsOffline({ home, input })` in src/retention-policy.ts, or export `offline` from src/maintenance.ts. It resolves the home with homePath (existing directory, no symlink), takes `acquireLock(0, path)`, then calls `new RetentionPolicyStore(join(path, "retention-policy.json"))`, does get(), then set(value, previous.revision), and releases in a finally block.
- In scripts/maintenance.ts:56-59, call that helper instead of using the store directly.
- Optionally also wrap the `retention-policy` preview (scripts/maintenance.ts:52) in the lock so that "every operation" in docs/maintenance.md:7 is literally true. If online preview from the CLI should stay allowed, change the docs instead.
- Optionally make RetentionPolicyStore.set safe across processes on its own, so the docs' "concurrent saves cannot overwrite each other" also holds outside the server  …

**Suggested regression test:** In test/retention-policy.test.ts, add a test modelled on "apply rejects an expired preview or live server lock ...":
- Write a settings JSON to f.directory.
- Spawn `sleep 30` and write its pid to join(f.home, "server.lock").
- Assert that `execFileSync(process.execPath, ["--import", "tsx", "scripts/maintenance.ts", "retention-settings", "--input", settingsFile, "--home", f.home], { cwd: root, env: { ...process.env, CODEFLOW_HOME: f.home }, stdio: "pipe" })` throws /Another code-flow server/.
-  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4667t245" on 127.0.0.1:4667, with a fresh home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4667t245. I ran the CLI from my snapshot copy /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4667. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667t245/repro.mjs (log in repro.log in the same folder).
1. In the UI at #/settings/data the policy started at revision 0. I set "Retention days archivedRuns" to 60 and clicked "Save retention settings". The status said "Retention settings saved" and GET /api/maintenance/retention returned revision 1.
2. I clicked "Preview saved retention policy". The UI showed "Policy revision 1". "Download reviewed retention plan" saved plan-rev1.json (policyRevision 1, 0 targets, truncated false).
3. server.lock was held by the server (pid 78985). With the server still running:
   - `backup` exited 1 with "Another code-flow server (pid 78985) is using ...".
   - `retention-policy --plan plan-rev1.json --apply` exited 1 with the same message.
   - `compact --id nope` (preview only, no --apply) also exited 1 with the same message.
   - `retention-settings --input settings.json --home H` exited 0 and printed revision 2 (archivedRuns 30). The server's GET then returned revision 2.
4. The open UI gave no sign of the change. It still showed "Policy revision 1" and the field still said 60. Saving from the UI again failed with HTTP 409: "Retention settings changed. Reload before saving."
5. `retention-policy --output` (read-only preview) also succeeded while the server held the lock (exit 0).
6. I stopped the server (server.lock was removed) and ran `retention-policy --plan plan-rev1.json --apply`. It exited 1 with "Data, ownership or policy changed after preview. No changes applied; create and review another preview." This matches the report exactly.
Extra check, not in the report: on a scratch home, I started 4 processes with a timing barrier. Each called RetentionPolicyStore.get() and then set(..., prev.revision). In all 6 rounds every writer reported "ok rev 0->1", but the file kept only one writer's keepRunIds. The "expectedRevision" check only works within one process (the policyQueues Map), so it does not stop two processes from overwriting each other. That contradicts  …

</details>

### S12-3 · minor · retention-settings writes retention-policy.json without taking server.lock. A running server's in-process revision queue does not see the change, so concurrent saves from the UI and the CLI can race.

Source: code-level suspect at `scripts/maintenance.ts:58` (confirmed hands-on).

**Repro**

> With s12 running (server.lock held by its pid 76243), I saved the policy through the API (revision 1). Then I ran `npx tsx scripts/maintenance.ts retention-settings --input settings.json --home <s12 home>` from the snapshot. It succeeded with exit 0 and wrote revision 2. For comparison, `maintenance.ts backup` on the same home refused: 'Another code-flow server (pid 76243) is using ...'. GET /api/maintenance/retention then returned revision 2, so the server does see the change. A stale UI save with expectedRevision 1 got 409 'Retention settings changed'. Cross-process race: the scratch script work/s12/race.mjs spawns two processes (test/s12-policy-racer.ts). Each reads the policy and both call RetentionPolicyStore.set(..., seenRevision) at an aligned instant. In 20 of 20 trials both were told they saved revision 1, and the file kept only one writer's days; the other update was lost silently.

**Expected:** docs/maintenance.md says every maintenance operation on an existing data directory takes the exclusive server.lock and refuses to run while a server holds it, and that concurrent saves cannot overwrite each other.

**Actual:** retention-settings runs while the server is up. The revision check only serializes within a single process, so two processes that read the same revision both succeed and one update is lost. The claim's sub-point that the server 'does not see the change' is wrong: the server re-reads the file on every get, so a stale save later conflicts as intended.

**Root cause (verifier):** The retention-settings branch in scripts/maintenance.ts:58 calls RetentionPolicyStore.set directly, without the offline()/acquireLock wrapper that backup, restore and apply use. RetentionPolicyStore.set (src/retention-policy.ts) relies on the module-level policyQueues map, so between readPolicy and the atomic rename there is no cross-process mutual exclusion.

**Suggested fix:** Wrap the CLI command in `const release = await acquireLock(0, realHome); try { ... } finally { release(); }` to match the documented offline contract. Optionally also make set() safe across processes with an exclusive lock file (for example open(`${file}.lock`, 'wx')) around the read-check-rename, or re-read the file identity just before rename and reject on change.

**Suggested regression test:** 1) While another process holds server.lock for the home, running maintenance.ts retention-settings exits 1 with the 'Another code-flow server' message and leaves the file unchanged. 2) Two child processes call set() with the same expectedRevision at the same instant: exactly one resolves, the other rejects with RetentionPolicyConflictError, and the final revision equals 1 plus the number of successes.

### t24-13 · cosmetic · Retention preview lists already-cleaned runs under 'Protected data' with a raw ENOENT path as the reason

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features PLAT-22.

**Repro**

> 1. Archive a finished run with 'Remove its worktree' ticked. 2. Set worktree/attachment retention days and Preview saved retention policy. 3. Open 'Protected data and scan limits'.

**Expected:** Runs whose workspace no longer exists are omitted (nothing to delete) or shown as 'Workspace already removed'.

**Actual:** attachments and worktrees entries for run 2610251654-c516a0b8 show 'ENOENT: no such file or directory, lstat '<repo>/.worktrees/2610251654-c516a0b8''.

**Root cause (verifier):** The problem is in src/retention-policy.ts. previewRetention reaches line 199-201 for every archived terminal run that isn't held, whenever attachment or worktree retention is enabled:
  try { managed = await managedRoot(run); }
  catch (error) { protect("attachments", id, (error as Error).message); protect("worktrees", id, (error as Error).message); continue; }

managedRoot (line 113-118) calls safeParents(join(expected, ".context")) at line 117. safeParents (line 71-73) lstat()s each ancestor, starting with expected = <repo>/.worktrees/<runId>. That folder is gone because Engine.archive({cleanup:true}) → tidyRunFolder (src/engine.ts ~3721-3731) rmdir()s an empty run folder by design. So lstat throws a raw ErrnoException ENOENT.

The catch at line 201 makes no distinction between "absent" and "unsafe". It passes the raw errno text, including the absolute path, as a protection reason for both kinds.

This contradicts line 206, which treats a missing per-tree path as nothing to do (`if (!(await exists(tree.path))) continue;`), and the folder loop at line 219, which treats a missing attachment folder as `if (!info) continue`. The archive dialog ticks "Remove its worktree" by default,  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/retention-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/retention-policy.test.ts`

**Suggested fix:** Handle an absent managed run directory before the ownership checks in src/retention-policy.ts. Two ways to do it:

(a) In the per-run loop, before calling managedRoot, check that the run's identity fields are valid and that the expected path is absent:
  const expected = resolve(await realpath(run.repo), WORKTREE_DIR, run.id); if (!(await exists(expected))) continue;
With this option nothing is listed; alternatively it can record a single neutral entry with protect(kind, id, "Workspace already removed").

(b) Have managedRoot return undefined when lstat(expected) is ENOENT, and keep throwing for real safety failures: a symlinked ancestor, not a directory, or outside the managed directory. The caller then does `if (!managed) continue;`.

Either way:
- Keep surfacing genuine safety failures. A symlinked or non-directory ancestor must still be protected.
- Translate any remaining errno-style messages into user wording rather than passing (error as Error).message through raw. A small reaso …

**Suggested regression test:** Add a test to test/retention-policy.test.ts named "a run whose managed workspace was already removed is not protected with a raw error". The existing writeRun(f, id) without workspace=true already builds this case: an archived, terminal run whose worktreeDir <repo>/.worktrees/<id> was never created. Steps:
- Call `const plan = await previewRetention({ home: f.home, now })` with the fixture's 30-day attachments and worktrees policy.
- Assert `!plan.protected.some(item => /ENOENT|no such file|lsta …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server: qa-server.sh start v4683r 4683 fake, with a new home. Its project was my own scratch clone of MQTT-MCP at scratchpad/qa/clones/v4683r-mqtt, whose origin is a local bare repo. Everything below was done in the UI with Playwright; scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683r/.
1. Created project v4683r-mqtt from Settings → Projects (setup.mjs).
2. In the composer I chose Run options → Advanced → Workflow "Fix & review" and sent "Add a one-line comment to README.md…" (fixreview.mjs). Run 2610252347-f6c3fd22 finished with status done and one worktree, .worktrees/<id>/build.
3. On the run page I opened More run actions → Archive…. "Remove its 1 worktree" is ticked by default, and I clicked Archive (archive2.mjs). The run log said "Archived: removed 1 worktree(s); branches kept; removed the run's folder". On disk, <clone>/.worktrees/2610252347-f6c3fd22 no longer existed; branch codeflow/<id>/build was kept.
4. In Settings → Data & storage I set attachments=7 and worktrees=7, clicked Save retention settings, then Preview saved retention policy, and opened "Protected data and scan limits · 16" (ret.mjs; log ret-a.log; screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683r/001-protected-open.png). The list showed:
   attachments · 2610252347-f6c3fd22: ENOENT: no such file or directory, lstat '<clone>/.worktrees/2610252347-f6c3fd22'
   worktrees · 2610252347-f6c3fd22: ENOENT: no such file or directory, lstat '<clone>/.worktrees/2610252347-f6c3fd22'
The API preview returned the same entries, with truncated=false and no console or 5xx errors. The plan is still applicable and nothing is lost, so the defect is presentation only.

Why the reporter's selector and environment are not the cause:
- The behaviour comes from server code; the UI renders reason strings verbatim.
- docs/maintenance.md and test/retention-policy.test.ts say nothing about a missing workspace being shown as protected.
- The same function already skips a missing individual worktree silently (line 206).

Notes found along the way (not part of this issue):
- Chat ("Agent") runs have no cleanup archive dialog.
- Team runs are retained as a "Shared chat workspace".
- Insights → Compare setups returned 400 "Fix & review: Team switching requires a local Agent conversation" because it forwarded  …

</details>

### t24-14 · minor · Maintenance CLI reports raw Node errors (EEXIST with temp-link paths, ENOENT) and only after doing the expensive work

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-23, PLAT-24.

**Repro**

> 1. backup --output to an existing file. 2. retention-policy --output to an existing file. 3. compact --id nope-123.

**Expected:** Clear messages ('Backup file already exists; choose a new path', 'Run nope-123 not found'), checked before reading, encrypting or scanning everything.

**Actual:** (1) 'EEXIST: file already exists, link '<out>.<pid>.<rand>.tmp' -> '<out>'' after reading all files and deriving the scrypt key; (2) 'EEXIST: file already exists, open ...' after a full retention scan; (3) 'ENOENT: no such file or directory, lstat '<home>/runs/nope-123.jsonl''.

**Root cause (verifier):** 1) src/maintenance.ts:47-55 writeExclusive(): the output path is created only by link(temp, path) at line 52, after the whole file has been written to temp. Node's raw EEXIST, which names the internal temp path, goes straight to scripts/maintenance.ts:64, which prints error.message. createEncryptedBackup (src/maintenance.ts:58-105) never checks whether the output exists. Line 59 only does realpath(dirname), which gives the raw ENOENT realpath error for a missing directory. The existence check therefore comes after the MemoryStore load (line 68), the full walk/read of up to 256 MiB (72-93), the scrypt key derivation (97), gzip and encryption (101-102), and the temp write (103). By contrast, restoreEncryptedBackup checks its destination with a friendly message at line 144.
2) scripts/maintenance.ts:52-53: previewRetention({home}) runs the full bounded scan first. Only then does writeFile(output, ..., {flag:'wx'}) run, and its raw EEXIST or ENOENT 'open' error is not translated.
3) src/maintenance.ts:194-199 readRunLog(): `await lstat(path)` at line 198 has no ENOENT handling, unlike retentionPlan at line 225. A missing run gives the raw 'ENOENT ..., lstat <home>/runs/<id>.jsonl'. The …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/maintenance.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/maintenance.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/maintenance.test.ts`

**Suggested fix:** Check paths before doing any work, and keep the atomic exclusive write as the final race-safe guard.
(a) In createEncryptedBackup, right after resolving `output` and before offline():
- If lstat(output) succeeds, throw 'Backup file already exists: <output>. Choose a new path; existing backups are never overwritten.'
- Catch ENOENT from realpath(dirname) and throw 'Backup folder does not exist: <dir>.'
- Validate the password length up front (call the length check from passwordKey before the walk).
(b) In writeExclusive, catch EEXIST from link() and rethrow the same friendly message, which covers a file created concurrently. Do not mention the temp path.
(c) In scripts/maintenance.ts retention-policy:
- Before previewRetention, if --output is given, lstat it: if it exists, throw 'Plan file already exists: <path>. Choose a new path.'; if its parent directory is missing, throw a clear error.
- Map EEXIST from the later 'wx' write to the same message, for the race case.
(d) In readRunLog,  …

**Suggested regression test:** Changes in test/maintenance.test.ts:
1) Replace the /EEXIST/ assertion at line 86 with assert.rejects(createEncryptedBackup({home, output: archive, password: PASSWORD}), /Backup file already exists/). Also assert the message does not match /\.tmp/.
2) Add a test showing the pre-check runs before the expensive work: with an existing output and password 'short', the call must reject with /already exists/, not the password-length error. Also assert that readdir of the output folder holds only the o …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode home v4685t2414 on port 4685. I created a scratch git repo (qa/clones/v4685-mini), ran one fake solo run to status done through the API, then stopped the server because maintenance needs server.lock. I ran the CLI from my snapshot copy (qa/builds/v4685) with CODEFLOW_HOME and --home set to the QA home and a random 32-hex-character CODEFLOW_BACKUP_PASSWORD.
(0) backup --output out/b1.cfb succeeded in 0.44 s.
(1) Same command again, output already exists: 'EEXIST: file already exists, link '<out>/b1.cfb.62638.f1ae8be707e0.tmp' -> '<out>/b1.cfb'', exit 1. The existing file's sha256 was unchanged and no .tmp file was left behind.
(1b) Existing output plus a 5-character password: the error is 'Use a backup password of 12 to 1,024 characters...'. So the password check runs before the existence check, and the existence check only happens at the final link().
(1c) Output directory missing: 'ENOENT: no such file or directory, realpath '<dir>''.
(1d) With a 100 MB random file added to the home, the EEXIST rejection takes 3.09 s instead of 0.4 s. Every file is read, base64-encoded, gzipped, scrypt-keyed, encrypted and written as a full temp copy before the rejection.
(2a) retention-policy --output plan.json succeeded.
(2b) Same command again: 'EEXIST: file already exists, open '<out>/plan.json''. This comes after the full previewRetention scan.
(2c) Output directory missing: 'ENOENT: ..., open '<dir>/plan.json''.
(3a) compact --id nope-123: 'ENOENT: no such file or directory, lstat '<home>/runs/nope-123.jsonl''.
(3c) compact --id ../x: friendly 'Choose a valid run id.'
The same raw-error pattern appears elsewhere: restore --input missing.cfb gives 'ENOENT ..., lstat'; retention-settings --input and retention-policy --plan with a missing file give 'ENOENT ..., open'.
No data is lost or overwritten, so the protection itself works. Only the wording and the late check are wrong.
Not by design: docs/maintenance.md:22 and :46 and the CLI help say existing outputs are rejected but don't specify the wording. The sibling restore path already has a curated message (src/maintenance.ts:144, 'Restore destination already exists. Choose a new directory.'), so backup and retention-policy are inconsistent with it.
I re-assessed the severity from cosmetic to minor, because of the wasted full-backup work and the temp copy written on large homes.
Cleanup: run deleted through the UI, scratch repo and output files removed, server stopped, ports 4685/4686 free.

</details>

### S12-4 · minor · createEncryptedBackup checks the password (passwordKey) only after walking and reading every file. An invalid password is reported last, and size or limit errors take precedence over it.

Source: code-level suspect at `src/maintenance.ts:58` (confirmed hands-on).

**Repro**

> Offline CLI from the snapshot, on temporary homes with CODEFLOW_BACKUP_PASSWORD empty. A home with 20,001 empty files printed 'Backup exceeds 20,000 files.' A 280 MiB home printed 'Backup exceeds the 256 MiB data limit. Archive older runs separately first.' A 240 MiB home printed 'Use a backup password of 12 to 1,024 characters...', but only after reading all 240 MiB into memory. An empty home printed the password error immediately.

**Expected:** An invalid or missing password, which needs no I/O to detect, is rejected before the data directory is walked and read.

**Actual:** The password is validated after the full walk and read, up to 256 MiB held in memory. A user with a too-large home and no password first fixes the size problem, reruns, and only then learns the password is invalid.

**Root cause (verifier):** passwordKey(), which holds the 12–1,024 character check, is first called at `createCipheriv('aes-256-gcm', await passwordKey(input.password, salt), iv)`. That happens after walk('') and after the manifest is built, inside offline().

**Suggested fix:** Split out a synchronous validateBackupPassword(password) and call it at the top of createEncryptedBackup, and of restoreEncryptedBackup, before realpath/offline/walk. Keep the scrypt derivation where it is.

**Suggested regression test:** createEncryptedBackup({home: dirWith20001Files, output, password: ''}) rejects with /backup password/, not /exceeds/. A spy or fs counter can confirm that no data file was opened.
