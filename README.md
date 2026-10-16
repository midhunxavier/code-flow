# code-flow

Run **Claude Code**, **Codex** and **Antigravity CLI (`agy`)** as one team of coding agents, using the subscriptions you already pay for. You pick a team pattern, assign an agent to each role, and watch them work together live in the browser. All work happens in git worktrees, so your own checkout is never touched.

## How it uses your subscriptions

code-flow never handles credentials. Each adapter launches the vendor's **official, unmodified CLI** in headless mode, and that CLI uses the login it already has:

| Agent | Command used | Login | Sandbox / permissions |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | Pro/Max (or API key) via `claude` | read: edit tools disabled, git read-only commands allowed · write: `acceptEdits` + an allow-list of build/test commands |
| Codex | `codex exec --json` / `codex exec resume` | ChatGPT plan (or API key) via `codex login` | Codex sandbox: `read-only` / `workspace-write` |
| Antigravity | `agy -p --output-format stream-json` | Google AI Pro/Ultra via an interactive `agy` login | `--sandbox` (verified: blocks writes outside the worktree) + `--dangerously-skip-permissions` (see caveats) |

**Read-only is enforced by code-flow itself, for every agent.** Before a read-only step (plan, review, judge, debate) code-flow snapshots its worktree: the commit, uncommitted changes and untracked files. Afterwards it puts back anything the step changed, including commits, and logs a warning.

This is the boundary each vendor draws for personal use. Don't extend code-flow to read or reuse the CLIs' OAuth tokens; Anthropic and Google both prohibit that, and Google has suspended accounts for it. If you ever turn this into a product for other people, each user must sign in with their own account, and Anthropic's terms then require API keys for products.

> Gemini CLI stopped serving Google AI Pro/Ultra/free personal accounts on 2026-06-18. `agy` is the CLI that serves those plans now.

## Quick start

```bash
npm install
npm start            # http://localhost:4317
```

Prerequisites: Node 20+, git, and at least one of `claude`, `codex`, `agy` installed and logged in. Run each CLI once interactively first. The header shows which agents were found.

**Signing in.** The first browser that opens code-flow is signed in automatically. That stays possible until code-flow first starts an agent, a check or an app. After that, other browsers need the link code-flow prints when it starts (`Open http://localhost:4317/?token=…`). The session token exists only in the server's memory, so the agents code-flow runs can't use its API, even sandboxed ones with network access. A restart starts a new session, and reloading the page signs you in again.

Using it:

1. Click the **repository button** in the top bar to choose a repo. The folder browser is served by the local server, because browsers don't expose absolute paths. It marks git repos and remembers recent ones.
2. Describe the task. Drag files from the **Files** panel, or from Finder, onto the task box to give the agents context.
3. Pick how the agents work together, and click an agent for each role. The sentence under the team, such as *"Claude plans → Codex builds → Claude reviews"*, shows what will happen.
4. Optionally open **Settings** to pick the base branch, the result branch name, rounds, and the model and effort per provider.
5. Press **Start run** (⌘↵).
   - The run view shows each step in a timeline, with the selected agent's live transcript beside it.
   - When the run finishes, each result is a branch such as `codeflow/<run>/build`, with buttons to copy its diff and merge commands.
   - **Edit & run again** puts the task back in the composer.

Review and merge results yourself:

```bash
git diff main...codeflow/<run>/build
git merge codeflow/<run>/build
```

## Giving agents context

The **Files** panel shows the selected repo: ignored files are hidden, files with uncommitted changes are marked **M**, and untracked files **U**. To add something to the task's context, drag it onto the task box, click **+**, or double-click it. You can also add files from your computer, such as specs, screenshots or logs (up to 10 MB each, 25 MB in total). Drop them from Finder, or use **Attach**.

Every agent's first prompt gets a *Context from the user* section listing these items. Nothing is pasted into the prompt:

- Repo files and folders that are identical in the base branch are referenced by path; every worktree already has them.
- Your **working-copy** version of a file is copied into `.codeflow-context/repo/<path>` in each worktree when the file is uncommitted or differs from the base branch. The agent sees exactly what you see.
- Dropped files are copied into `.codeflow-context/attachments/`.
- `.codeflow-context/` is listed in `.git/info/exclude`, so it never ends up in an agent's commit.
- Folders that aren't in the base branch are rejected. Commit them, or drop the individual files.

## Models and effort

**Settings → Models & effort** sets a model and a reasoning effort per provider. Every role that uses that provider runs with them. Leave either on *Default* to use the CLI's own configuration.

| Provider | Model list | Flags passed |
|---|---|---|
| Claude Code | aliases `fable`, `opus`, `sonnet`, `haiku`, or any full model name via *Other…* | `--model`, `--effort` (low … max) |
| Codex | `codex debug models`, with each model's supported efforts; the default comes from `~/.codex/config.toml` | `-m`, `-c model_reasoning_effort=…` |
| Antigravity | `agy models` | `--model`, `--effort` (low … max) |

Model lists are cached for 10 minutes. Your choices are remembered in the browser.

## Checks, loops and limits

code-flow treats each pattern as a loop, and what it engineers is the loop around the agents:

- **Done when:** a check command such as `npm test`, `pytest` or `cargo test`. It's auto-detected from the repo and editable per repo.
  - **code-flow runs it itself** after each change, in that worktree, and feeds the failing output back to the agent.
  - Loops end on that evidence, not on an agent saying it's done. Every check shows in the run timeline with its output.
  - Pipeline: reviewers only see code that passes.
  - Race: a candidate that fails can't win if another one passes.
  - Supervisor and Debate: the integrated or built result is checked, and the agent fixes failures.
  - Test-first: the new tests must fail first, then pass.
  - When a run finishes but the check still fails, the run is shown as a warning, not a success.
- **A pass only counts if the tests are still the tests.** After every change, code-flow looks for edits that make a check pass without fixing anything:
  - deleted test files;
  - added `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `t.Skip()`…;
  - test files that lost assertions;
  - a changed test config or CI workflow;
  - a changed `scripts.test` (or whichever script the check runs);
  - fewer tests running than before, read from the runner's summary.

  What happens next depends on the pattern:
  - Loop until green: a pass that relies on such changes doesn't end the loop. The agent is told to undo them and fix the code. If it keeps them (the task may need it), the result is flagged.
  - Pipeline, Supervisor and Debate: the changes go to the reviewer, who requests changes unless the task needs them.
  - Race: a candidate that passes only that way can't beat one that passes honestly.
  - Test-first: the builder's edits to the tests are undone, and so are the tester's edits outside them.
  - PR follow-through: a fix that changes tests that way isn't pushed.

  Every flagged result shows **⚠ Changes to tests to check before merging**.
- **Independent review:** Supervisor has a *Reviewer* role (default Codex) that checks the integrated result instead of the supervisor checking its own work. It also writes the *contracts* (interfaces, names, data shapes) that every worker gets. Debate can have a reviewer check the build against the agreed plan.
- **What agents see:** long diffs keep whole source files first, put lockfiles and generated files last, and list any file that didn't fit with the command to read it. A long check log keeps the lines around each failure plus the runner's summary, not just the tail. Agents also get the repo's own conventions files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, …), since each CLI otherwise reads only its own. They're also told about problems reviewers raised in more than one earlier run in that repo (turn this off with `"learn": false`).
- **No progress means hand off:** in *Loop until green*, a round with no new commit, or with the same failure as before, counts as stuck. After *K* stuck rounds, the next vendor takes over.
- **Limits:** every run stops at a maximum number of minutes or agent steps (60 and 40 by default). A stopped run keeps its work: each worktree with changes is listed as "Work so far".
- **Plan usage:** if a CLI says its plan is out of usage, the run stops instead of failing, so you can resume it once the plan resets. A turn that fails for a passing reason (overloaded, a network error) is retried after 20 s, then 60 s.
- **One machine, many runs:** at most 6 agent CLIs and 3 checks run at once across all runs (`CODEFLOW_MAX_AGENTS`, `CODEFLOW_MAX_CHECKS`). Others wait their turn, and the step says so.
- **Stopping really stops:** each agent CLI and each check runs in its own process group. Cancelling, a time limit or the CLI exiting stops everything it started, such as a dev server it left in the background, and escalates to SIGKILL if needed.
- **Setup:** an optional command, such as `npm ci`, that runs once in every new worktree before the agents start.

Agents may suggest their own test command (the tester in Test-first does). code-flow only runs it if it's a plain invocation of a known test runner, with no shell operators. Otherwise it falls back to your check.

> **Security:** a check runs the agents' code (tests, scripts) on your machine, outside Codex's and agy's sandboxes, as your CI would. Use code-flow on repos and tasks you trust, or run it inside a container or VM.

## Workspaces that just work

**Per-repo config.** Commit `.codeflow/config.json` and every run in that repo (and every teammate) gets the same defaults. Anything you set in the UI wins.

```json
{
  "check": "npm test",
  "setup": "npm ci",
  "copy": [".env", ".env.local", "config/*.local.json"],
  "run": { "command": "npm run dev", "port": 3000 },
  "models": { "claude": { "model": "opus", "effort": "high" } },
  "limits": { "maxMinutes": 90, "maxSteps": 60 },
  "trust": "standard",
  "image": "node:22",
  "learn": true
}
```

- `copy` brings files git doesn't carry (like `.env`) from your checkout into every new worktree. Only regular files that git ignores are copied. Symlinks are refused, since a cloned repo's `.env` could point at your credentials, and so are files git would commit. Patterns can't reach outside the repo.
- `image` is the Docker image for running checks in isolation (automations, untrusted sources). `learn` passes recurring review problems on to later runs.
- A result's worktree that was removed (archived) is set up again when you follow up on it: files copied, setup run, context restored. If its branch was deleted, that follow-up fails with a clear message; the run itself stays finished.
- **Try it:** each result has **Terminal**, **Editor** (Cursor, VS Code, Zed or Sublime, whichever is installed) and **Folder** buttons that open its worktree, plus **▶ Run app**.
  - Run app starts your dev server in the worktree on a free port (passed as `$PORT`), with logs and **Stop app**. Servers stop when the run is archived or code-flow shuts down.

**What agents may do while building** (Settings → permissions):

| Mode | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Safe | edits files; no shell beyond read-only git | edits inside its sandbox | sandboxed to the worktree |
| Standard (default) | edits + common build/test commands (npm, node, pytest, cargo, go, make…) | sandboxed, no network | sandboxed to the worktree |
| Trusted | any command | sandboxed, with network | sandboxed to the worktree |

Whatever the mode, code-flow never merges or pushes on its own.

**Per-role models:** under each role, *⚙ model for this role* overrides the provider default, for example Opus to plan and Sonnet to review.

**Health:** click the agent names in the top bar to see, for each CLI, whether it's installed, its version, and whether it's signed in. It uses `claude auth status`, `codex login status`, and for agy whether it can list models; credentials are never read. Claude's 5-hour and 7-day usage windows are shown from its own reports, with how to fix anything that's wrong. A run won't start with an agent that's signed out.

## Review & ship

When a run finishes, each result branch has **Review changes**, **Merge…** and **Open PR…** buttons.

- **Review changes** opens a per-file diff. Click any line to comment on it, and add an overall comment if you like.
  - **Send N comments to [agent]** queues a *follow-up* in the same run: that agent continues its own session in the worktree, addresses the comments, and code-flow commits and re-runs the check.
  - Follow-ups are recorded on the run, so they survive restarts. The result header and summary reflect the latest follow-up.
  - Draft comments are kept if you navigate away.
- **Merge…** merges the result into one of your branches, and only when that's safe:
  - If the target branch is checked out (e.g. `main` in your checkout), the merge happens there, and only when it has no uncommitted changes. On conflict it aborts cleanly.
  - Otherwise code-flow builds the merge with `git merge-tree` and moves the branch, so no checkout is touched.
  - On conflict you see the files and can **ask an agent to resolve them**: code-flow merges the target into the result branch and the agent fixes the markers. Then merge again.
  - By default the run is archived after merging (worktrees removed, branches kept).
- **Open PR…** pushes the branch to `origin` and opens a pull request with `gh`, using the task and summary as the description.
- **Archive…** removes a run's worktrees (optionally its branches too). Kept branches can still be merged or resumed later.

Verdicts, judge picks, subtask lists and test specs are **schema-constrained**: `claude --json-schema`, `codex --output-schema` and `agy --json-schema`. An answer that still doesn't fit gets one retry in the same session, and then the run **fails**: an unreadable review is never treated as approval.

Judging in a race is blind: no author summaries, a shuffled order (seeded per run, so a resumed run replays identically), and an optional **panel** of judges that vote. Pick vendors that aren't competing; the UI suggests one, and the log warns when a judge also competes.

## Start from where the work lives

Runs can start from GitHub instead of a blank task box, using GitHub CLI (`gh`) with your own login:

- **Templates** above the task box set up common jobs:

  | Template | Pattern | Starts from |
  |---|---|---|
  | **Fix an issue** | Plan → Build → Review | an issue; the PR you open later says `Closes #N` |
  | **Fix failing CI** | Plan → Build → Review | a PR, with its failing checks and their job logs (`gh run view --log-failed`) given to the agents |
  | **Review a PR as a council** | Review council | a PR |
  | **Upgrade a dependency** | Plan → Build → Review | the task box (replace `PACKAGE`) |

- **⇄ GitHub** in the task box starts from any open issue or PR:
  - An **issue's** title and description go to every agent with the task.
  - A **PR's** branch is fetched (`pull/N/head`, so forks work too) and becomes the run's base. Its description goes to the agents, and its changes are compared against the PR's target branch.
  - When a run came from a PR, a result has **Push to PR #N**. It pushes to the PR's branch and is never forced, so it fails if someone else pushed in the meantime. You can't push to a PR from a fork; you can still review it.
- **Review council** is a read-only pattern: several agents review the same changes independently, and a chair merges their findings.
  - Reviewers are anonymous to the chair ("Reviewer A/B"), and findings several reviewers agree on rank first.
  - Nothing is changed. **Post to PR #N** posts the review as a comment, and only when you click it.
- **Follow-through** (**Watch PR**) works on a result that has a PR. code-flow checks it every minute:
  - **Failing CI:** the failed jobs' logs go to the agent you picked, which fixes the cause. code-flow commits and pushes to the PR.
  - **New comments** from you (the account `gh` is signed in as), or from people you list under *Also act on comments from*, go to the agent in the same way. Nobody reviews these fixes before they're pushed, so anyone else's comments are logged and ignored, even an org member's. Comments that were there before you started watching are never acted on.
  - These unattended fixes never run with more than *standard* permissions, and a fix that changes tests in ways that could hide the failure isn't pushed. It's handed back to you instead.
  - **Stops:** after the number of fixes you allow, if someone else pushed to the PR, or when the PR is merged or closed. It then shows under *Needs you* with a notification.
  - It **never merges**.
- **Auto** in a role picks an installed agent when the run starts. It skips plans that are at 90% or more of a usage window or recently hit a limit, until the limit resets (Claude reports its windows; the others report only when they're limited). Once agents have a few finished runs in a repo, it prefers the one whose code passed the check most often there. The pick and the reason are written to the run's activity log. Quota is saved, so a restart remembers which plans are out.
- **Text from outside the repo is untrusted.** Issue and PR descriptions, comments and CI logs can carry instructions aimed at the agents. code-flow asks GitHub who wrote an issue or PR. Unless it's the repo's owner, a member or a collaborator, and not a fork, the run is locked down (🔒 in the run view):
  - agents run in Safe mode;
  - files like `.env` aren't copied in;
  - checks run in Docker without network.

  Without Docker, code-flow asks before running that person's tests on your machine; automations never do. The text itself is quoted in a fence it can't break out of, marked as information rather than instructions. Conventions files are read from where the PR started, not from the PR.

## Automations and away mode

Set up a run in the composer (task, team, check, settings), then choose **Save as automation…** next to *Start run*. It runs unattended:

- **When it runs:**
  - at a time on chosen weekdays (e.g. weekdays at 07:00), or every *N* minutes (at least 5);
  - from a webhook;
  - or when you press **Run now** on the ⏱ Automations page.

  Times missed while code-flow was closed are skipped, not caught up. If the previous run is still going, the next one is skipped, so automations never pile up.
- **Webhooks:** `POST /hooks/<id>` with `Authorization: Bearer <secret>` and a JSON body. Both fields are optional:
  - `details` is added to the task;
  - `source` (e.g. `{"kind": "pr", "number": 12}`) starts from that issue or PR.

  GitHub webhooks work directly through a tunnel. Use the secret as the webhook secret; code-flow checks `X-Hub-Signature-256`. These events start a run, and all others are ignored:
  - an opened issue starts from that issue;
  - an opened or updated pull request starts from that PR;
  - a failed workflow run starts from its PR, with the failure logs.
- **The inbox:** automation results wait on the Automations page (with a count in the top bar) and under *Needs you*:
  - **Approve:** keeps the result. **Approve & open PR** also pushes the branch and opens a pull request.
  - **Revise:** your note goes to the agent that wrote the code, in its own session. The result comes back to the inbox.
  - **Reject:** deletes the run's worktrees and branches.
  - Runs that changed nothing are archived on their own, and their branches deleted.
  - Automations never pause for plan approval, and **nothing is ever merged automatically**.
- **Isolation:** tick *Run checks and setup in a Docker container* and code-flow runs those commands with `docker run`:
  - only the worktree is mounted read-write, plus the repo's `.git` read-only, so git works;
  - none of your environment variables or your home folder are visible inside;
  - the files it creates belong to you.

  Agents still run as their own CLIs (they need your subscription logins) inside their own sandboxes. The repo's own scripts are what run in the container.
- **Phone view:** turn on the *read-only view behind a secret link* on the Automations page.
  - It lists what's running and what needs you, and each run's summary, review, results and steps. It refreshes itself.
  - It has no buttons: nothing can be started, approved or merged from it.
  - *Reachable from my Wi-Fi* also serves it, and webhooks, on your network at port `PORT+1`. It's plain HTTP, so use it only on networks you trust, or over a VPN like Tailscale. **New link** revokes the old one.

Automations live in `~/.codeflow/triggers.json` and the phone view's settings in `~/.codeflow/remote.json`. Both files are readable only by you.

## Insights, comparisons and finding runs

- **Insights** (◔ in the top bar, or <kbd>i</kbd>) shows, per agent and per pattern, for one repo or all, over 7 days, 30 days or all time:
  - runs, and how often the result passed its check;
  - race wins, loops each agent got green, and review findings other reviewers agreed with;
  - failed steps, tokens (input, output, cached) and time per step;
  - Claude's API-equivalent cost. Your plan isn't billed per token; it's a measure of size.
- **Compare setups…** (next to *Start run*) starts the same task with several patterns at once, each with the team you last picked for it, optionally 2–3 times each. Insights shows them side by side: result, time, steps, tokens, cost, and whether tests were touched. The best value in each column is highlighted.
- **Tokens and cost** also show on each step, in the run header (with a per-agent breakdown on hover) and in the sidebar.
- **Disk:** every worktree is a full checkout, often with its own `node_modules`. Insights measures them and **Clean up** removes the worktrees, not the branches, of runs that finished more than *N* days ago and need nothing from you.
- **Finding runs:** the sidebar has search (<kbd>/</kbd>), filters (needs you, running, passed, failing, tests changed; pattern; agent; this repo), and <kbd>j</kbd>/<kbd>k</kbd> to move between runs. In a run, <kbd>[</kbd>/<kbd>]</kbd> move between steps. <kbd>?</kbd> lists every shortcut. Run status changes are announced to screen readers.

## Talking to a run

Runs are conversations, not fire-and-forget jobs:

- **Approve the plan:** tick *Let me approve the plan* (the subtasks for Supervisor, the tests for Test-first). The run pauses at that checkpoint, and its time budget with it.
  - **Approve:** the agents start building.
  - **Ask for changes:** your note goes to the author, who revises in its own session and asks again.
  - **Reject:** the run ends without building anything.
  - A pending checkpoint survives restarts. Waiting runs show under *Needs you*, with a notification.
- **Message the team** while it runs: your note is delivered at the start of the next turn of the agent you pick (or whoever goes next), never into a turn that has already started. The run view shows each note as queued or delivered.
- **Reply** after it finishes:
  - to an agent in its worktree: it continues its own session, then code-flow commits and re-runs the check;
  - or to *the whole team again*: a new run that starts from this run's result branch, with your feedback added to the task.

Prompts are passed on **stdin**, not as command-line arguments (`claude -p` reading stdin, `codex exec -`, and agy's stream-json input), so long tasks and diffs aren't limited by the operating system's argument size.

## Runs survive restarts

Every run is saved to disk as it happens (`~/.codeflow/runs/<run>.jsonl`), and the server rebuilds the run list from those files when it starts.

- **Interrupted runs:** if code-flow stops while a run is going (Ctrl-C, a restart, a crash), the run comes back as **Interrupted**.
  - **Resume** re-runs the pattern from the top. Each step that already finished (agent turns, checks, commits, worktrees) is replayed instantly from a journal (`<run>.journal.jsonl`), and real work continues at the first unfinished step. Nothing finished is redone.
  - Runs that hit a time or step limit, failed, or were stopped by you can be resumed the same way, with a fresh budget.
  - A recorded check is replayed only if the code it checked is still the code at that point. A recorded commit is replayed only if it's still in the branch's history. Anything else runs again.
  - Follow-ups on a finished run don't replay the pattern at all; only the follow-ups run. A follow-up that fails doesn't undo the finished run.
  - Resume is claimed at once, so a double click or a PR watch can't start the same run twice. Notes delivered to a turn that never finished go to the next turn.
- **Clean shutdown:** Ctrl-C or SIGTERM stops running agents and marks their runs interrupted. A second Ctrl-C exits at once.
- **One server per data folder:** a second server on the same `CODEFLOW_HOME` waits for the first to stop (as in a restart), then refuses to start. A crash mid-write can leave a line half-written; it's closed off before the next write, so it never corrupts the next line. Failed writes, such as a full disk, are counted and reported at `/api/health`.
- **Needs you:** the sidebar groups runs into *Needs you* (finished runs you haven't opened, and interrupted runs), *Running*, *Recent* and *Archived*. The browser tab shows the count, and 🔔 turns on desktop notifications for when a run finishes or needs you.
- **Two servers:** `npm start` is your server (port 4317, `~/.codeflow`). `npm run dev` is a development server (port 4318, `.codeflow-dev/`) with **fake agents**, so working on code-flow never touches your real runs or quota. It puts `test/fake-bin` on `PATH` by absolute path and refuses to start if `claude`, `codex` or `agy` would still resolve to a real CLI. `npm run dev:real` is the same dev server with the real CLIs.

## Worktrees and branches

Every worktree a pattern needs (`build`, `candidate-a`, `integration`, …) is created with:

```bash
git worktree add -b <prefix>/<name> <repo>/.worktrees/<run-id>/<name> <base>
```

- **Base branch:** the starting point for every worktree in the run. By default this is the repo's current `HEAD`. The dropdown also lists local branches, remote branches, and the result branches of earlier runs, so you can build on a previous result. Uncommitted changes in your checkout aren't included.
- **Result branch prefix:** defaults to `codeflow/<run-id>`. If you set it to, say, `feat/rate-limit`, results land on `feat/rate-limit/build`. A prefix can only be used once, because git can't have both a `feat/rate-limit` branch and `feat/rate-limit/…` branches.
- **Location:** worktrees go in `<repo>/.worktrees/`. code-flow adds `/.worktrees/` to `.git/info/exclude`, which keeps them out of `git status` without editing your `.gitignore`. Tools that don't read git's ignore files (some test runners, linters, `tsc` globs) may still scan `.worktrees/`. Exclude it in their config, or set `CODEFLOW_WORKTREE_DIR` to an absolute path to keep worktrees outside the repo.
- **Cleanup:** remove a run's worktrees with `git worktree remove .worktrees/<run-id>/<name>`, or delete the folder and run `git worktree prune`. The branches stay until you delete them.

## Team patterns

| Pattern | Roles | Flow | Reach for it when |
|---|---|---|---|
| **Plan → Build → Review** | planner, builder, reviewer | Plan (read-only) → implement → **check** (the builder fixes it first if it fails) → independent review → builder fixes → re-check and re-review, up to *N* rounds | Most features and bug fixes. Cross-vendor review catches what a model misses in its own work |
| **Loop until green** | workers (1+, in hand-off order) | Baseline check → the agent works → code-flow runs the check → the failure goes back to the agent → repeat until it passes. After *K* rounds without progress, the next vendor takes over with a handover note | "Done" is a command: failing tests, type errors, a broken build. Needs a check |
| **Best-of-N race** | contestants (2+), judge | All contestants solve the task in parallel, each in its own worktree → judge compares **anonymized** diffs (Candidate A/B…) and picks one | The solution space is wide, or the task is risky enough to want several independent attempts |
| **Debate → Synthesize → Build** | debaters (2+), synthesizer, builder (optional) | Independent proposals → critique rounds where each debater sees the others' proposals and revises → synthesizer merges and records each decision → builder implements | Architecture, API design, big refactors. Leave the builder empty for design only |
| **Supervisor → Workers** | supervisor, workers (1+) | Supervisor splits the task into parallel subtasks and assigns workers → workers build on separate branches → branches merge into an integration branch; the supervisor resolves conflicts, reviews and fixes | Larger tasks that split cleanly (backend / frontend / tests) |
| **Test-first (adversarial tester)** | tester, builder | Tester writes failing tests → builder makes them pass without editing them (code-flow flags it if it does) → tester runs them, adds edge-case tests, and sends failures back | Behavior you can specify with tests. Stops an agent from grading its own homework |
| **Review council** | reviewers (1+), chair | Reviewers review the PR's or branch's changes independently, read-only → the chair merges the findings without knowing who wrote what, and agreement ranks first | Reviewing a PR before merging. Nothing is changed or posted without you |

Every pattern works with any mix of agents. A good default is to have a **different vendor review or judge** than the one that wrote the code.

## Architecture

```
ui/*.tsx                 UI: Preact + TypeScript, compiled against the server's own types (ui/insights.tsx: Insights)
scripts/build-ui.mjs     bundles the UI into one self-contained public/index.html (npm start builds it)
src/server.ts            HTTP API + SSE on 127.0.0.1 (Host/Origin checked, session cookie or Bearer token)
src/store.ts             run logs and the replay journal on disk, the one-server lock
src/integrity.ts         finds changes to tests that could make a check pass without a fix
src/diff.ts              fits a long diff into a prompt (whole files first)
src/learnings.ts         the repo's conventions files, and problems reviewers keep raising
src/slots.ts             caps how many agents and checks run at once
src/stats.ts             Insights: per agent, per pattern, comparisons; ranking for Auto
src/ship.ts              per-file diffs, safe merges, pull requests, worktree cleanup
src/github.ts            gh: issues, PRs, checks, failed-job logs, comments, pushes
src/watch.ts             PR follow-through: polls watched PRs and sends CI failures and comments back
src/routing.ts           "Auto" roles: pick an agent whose plan has room (and that passes most in this repo)
src/templates.ts         starting points (fix an issue, fix failing CI, council review…)
src/automation.ts        automations: schedules, webhooks (Bearer or GitHub signature), firing runs
src/remote.ts            the read-only phone view (server-rendered, secret link)
src/engine.ts            RunManager, TeamContext (ask / worktree / commit / diff), event log
src/patterns/*.ts        the team patterns, written against TeamContext
src/adapters/*.ts        AgentAdapter per CLI → normalized AgentEvent stream
src/git.ts               worktrees, branches, commits, diffs, merges
src/repo-tree.ts         file tree + search for the Files panel
src/context.ts           validates and stages task context for agents
```

- **AgentAdapter** (`src/adapters/types.ts`): `run({prompt, cwd, mode, resumeSessionId}, onEvent) → {ok, finalText, sessionId}`. Adapters convert each CLI's JSONL into `text | thinking | tool_call | tool_result | usage | status | error` events.
- **TeamContext** gives patterns a few primitives. `ask()` runs one agent turn as a visible step, and `resume` continues that agent's own conversation. `worktree()`, `commit()`, `diff()` and `artifact()` handle git. Structured hand-offs (review verdicts, judge picks, subtask lists) use a fenced ```` ```json ```` block that `extractJson` parses.
- Every event is appended to `~/.codeflow/runs/<run>.jsonl`. Worktrees live in `<repo>/.worktrees/<run-id>/` (see above).

### Adding a pattern

Write a `Pattern` (roles, options, `run(ctx)`) in `src/patterns/`, then add it to `src/patterns/index.ts`. The UI builds its form from the pattern definition.

### Adding an agent

Implement `AgentAdapter` in `src/adapters/`, then register it in `src/adapters/index.ts`. Add a fake for it in `test/fake-agent.mjs`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `CODEFLOW_HOME` | `~/.codeflow` | Run logs |
| `CODEFLOW_WORKTREE_DIR` | `.worktrees` | Worktree folder; relative paths are inside each repo, absolute paths are used as-is |
| `CODEFLOW_STEP_TIMEOUT_MIN` | `30` | Timeout per agent step |
| `CODEFLOW_MAX_AGENTS` | `6` | Agent CLIs running at once, across all runs |
| `CODEFLOW_MAX_CHECKS` | `3` | Check and setup commands running at once, across all runs |
| `CODEFLOW_RETRY_DELAYS_MS` | `20000,60000` | Waits before retrying an agent turn that failed for a passing reason |
| `CODEFLOW_TOKEN` | random per start | The session token (set it to keep browsers signed in across restarts; anything that can read it can use the API) |
| `CODEFLOW_MAX_DIFF_CHARS` | `60000` | Diffs longer than this are fitted (whole files first) before being passed to another agent |
| `CODEFLOW_CLAUDE_WRITE_TOOLS` | build/test allow-list | Comma-separated Claude tool rules for write mode, e.g. `Edit,Bash` |
| `CODEFLOW_REMOTE_PORT` | `PORT+1` | Port for the phone view and webhooks on your network, when *Reachable from my Wi-Fi* is on |
| `CODEFLOW_SCHEDULER_TICK_MS` | `30000` | How often due automations are checked |
| `CODEFLOW_WATCH_INTERVAL_MS` | `60000` | How often watched PRs are checked for CI results and new comments |
| `CODEFLOW_AGY_SKIP_PERMISSIONS` | `1` | Set to `0` to stop passing `--dangerously-skip-permissions` to agy; then configure `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |

## Tests

```bash
npm test           # unit + workflow tests against fake CLIs
npm run test:e2e   # the real UI in Chrome (headless) against a server with fake agents
```

The suite runs every pattern end to end against fake `claude` / `codex` / `agy` binaries (`test/fake-bin`). Each fake emits that vendor's real JSONL format, so tests cost no quota. A fake `gh` keeps issues, PRs, checks and comments in a JSON file and pushes to a local bare repository, so the GitHub flows (fix CI → push → watch → fix again) are tested without touching GitHub. A fake `docker` records its arguments and runs the command in place, so isolation is tested without Docker. The suite covers review loops, races with a failing contestant, critique rounds, merge-conflict resolution, and the guarantee that your checkout is untouched. `test/hardening.test.ts` covers the guarantees about processes, runs and tests:
- a background process an agent leaves behind neither hangs a step nor survives it;
- a run can't be resumed twice at once;
- a commit made in a read-only step is undone;
- a loop doesn't accept a pass made by deleting the failing test;
- race commits name no vendor;
- the builder's test edits are undone;
- retries, usage-limit stops and token accounting work.

The GitHub tests cover untrusted issues (lockdown, fenced text, Docker or your confirmation) and PR watches that act only on comments from you and the people you allow. The e2e test also covers sign-in, Insights and run search.

## Caveats and next steps

- **agy permissions** (tested with agy 1.3.5): when headless agy hits a tool it isn't allowed to use, it doesn't work around it. The turn ends with an empty answer, which code-flow reports as a failed step that names the denied action. That's why code-flow passes `--dangerously-skip-permissions` together with `--sandbox` by default. The sandbox confines writes to the worktree, and code-flow reverts any changes made during read-only steps. Older agy versions printed nothing when piped; code-flow reports that as an error too.
- Headless agents can't ask you anything. Tools that are not pre-allowed are denied, and the agent works around it or reports it.
- Claude's write mode can run allow-listed commands such as `npm`, `node` and `make`, and those can run arbitrary project scripts. Only run it on repos you trust. Codex is additionally confined by its own sandbox.
- agy needs `--dangerously-skip-permissions` for read-only steps too, so for agy the snapshot-and-restore is what enforces read-only. Changes to gitignored files during a read-only step aren't detected.
- The test-integrity checks catch the common ways to game a check, not every one. A flagged result is a prompt to look, and an unflagged one isn't proof.
- Next steps worth doing:
  - Use `codex app-server` instead of `exec` for mid-turn steering and real approvals.
  - A container option for the agents themselves (today only checks and setup run in Docker).
  - Write run snapshots as deltas and compact old logs (today every state change appends a full snapshot).
  - Read PR line comments (review threads), not just conversation comments and review summaries.
  - Linear as a source, next to GitHub issues.
