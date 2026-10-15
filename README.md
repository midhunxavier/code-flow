# code-flow

Run **Claude Code**, **Codex** and **Antigravity CLI (`agy`)** as one team of coding agents, using the subscriptions you already pay for. You pick a team pattern, assign an agent to each role, and watch them work together live in the browser. All work happens in git worktrees, so your own checkout is never touched.

## How it uses your subscriptions

code-flow never handles credentials. Each adapter launches the vendor's **official, unmodified CLI** in headless mode, and that CLI uses the login it already has:

| Agent | Command used | Login | Sandbox / permissions |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | Pro/Max (or API key) via `claude` | read: edit tools disabled, git read-only commands allowed · write: `acceptEdits` + an allow-list of build/test commands |
| Codex | `codex exec --json` / `codex exec resume` | ChatGPT plan (or API key) via `codex login` | Codex sandbox: `read-only` / `workspace-write` |
| Antigravity | `agy -p --output-format stream-json` | Google AI Pro/Ultra via an interactive `agy` login | `--sandbox` (verified: blocks writes outside the worktree) + `--dangerously-skip-permissions` (see caveats) |

**Read-only is enforced by code-flow itself, for every agent.** If a read-only step (plan, review, judge, debate) leaves its worktree modified, the changes are reverted and a warning is logged.

This is the boundary each vendor draws for personal use. Don't extend code-flow to read or reuse the CLIs' OAuth tokens; Anthropic and Google both prohibit that, and Google has suspended accounts for it. If you ever turn this into a product for other people, each user must sign in with their own account, and Anthropic's terms then require API keys for products.

> Gemini CLI stopped serving Google AI Pro/Ultra/free personal accounts on 2026-06-18. `agy` is the CLI that serves those plans now.

## Quick start

```bash
npm install
npm start            # http://localhost:4317
```

Prerequisites: Node 20+, git, and at least one of `claude`, `codex`, `agy` installed and logged in. Run each CLI once interactively first. The header shows which agents were found.

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
- **No progress means hand off:** in *Loop until green*, a round with no new commit, or with the same failure as before, counts as stuck. After *K* stuck rounds, the next vendor takes over.
- **Limits:** every run stops at a maximum number of minutes or agent steps (60 and 40 by default). A stopped run keeps its work: each worktree with changes is listed as "Work so far".
- **Setup:** an optional command, such as `npm ci`, that runs once in every new worktree before the agents start.

Agents may suggest their own test command (the tester in Test-first does). code-flow only runs it if it's a plain invocation of a known test runner, with no shell operators. Otherwise it falls back to your check.

> **Security:** a check runs the agents' code (tests, scripts) on your machine, outside Codex's and agy's sandboxes, as your CI would. Use code-flow on repos and tasks you trust, or run it inside a container or VM.

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
- **Clean shutdown:** Ctrl-C or SIGTERM stops running agents and marks their runs interrupted. A second Ctrl-C exits at once.
- **Needs you:** the sidebar groups runs into *Needs you* (finished runs you haven't opened, and interrupted runs), *Running*, *Recent* and *Archived*. The browser tab shows the count, and 🔔 turns on desktop notifications for when a run finishes or needs you.
- **Two servers:** `npm start` is your server (port 4317, `~/.codeflow`). `npm run dev` is a development server (port 4318, `.codeflow-dev/`) with **fake agents**, so working on code-flow never touches your real runs or quota. `npm run dev:real` is the same dev server with the real CLIs.

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

Every pattern works with any mix of agents. A good default is to have a **different vendor review or judge** than the one that wrote the code.

## Architecture

```
ui/*.tsx                 UI: Preact + TypeScript, compiled against the server's own types
scripts/build-ui.mjs     bundles the UI into one self-contained public/index.html (npm start builds it)
src/server.ts            HTTP API + SSE on 127.0.0.1 (Host/Origin checked)
src/store.ts             run logs and the replay journal on disk
src/ship.ts              per-file diffs, safe merges, pull requests, worktree cleanup
src/engine.ts            RunManager, TeamContext (ask / worktree / commit / diff), event log
src/patterns/*.ts        the five team patterns, written against TeamContext
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
| `CODEFLOW_MAX_DIFF_CHARS` | `60000` | Diffs longer than this are truncated before being passed to another agent |
| `CODEFLOW_CLAUDE_WRITE_TOOLS` | build/test allow-list | Comma-separated Claude tool rules for write mode, e.g. `Edit,Bash` |
| `CODEFLOW_AGY_SKIP_PERMISSIONS` | `1` | Set to `0` to stop passing `--dangerously-skip-permissions` to agy; then configure `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |

## Tests

```bash
npm test           # unit + workflow tests against fake CLIs
npm run test:e2e   # the real UI in Chrome (headless) against a server with fake agents
```

The suite runs every pattern end to end against fake `claude` / `codex` / `agy` binaries (`test/fake-bin`). Each fake emits that vendor's real JSONL format, so tests cost no quota. The suite covers review loops, races with a failing contestant, critique rounds, merge-conflict resolution, test tampering detection, and the guarantee that your checkout is untouched.

## Caveats and next steps

- **agy permissions** (tested with agy 1.3.5): when headless agy hits a tool it isn't allowed to use, it doesn't work around it. The turn ends with an empty answer, which code-flow reports as a failed step that names the denied action. That's why code-flow passes `--dangerously-skip-permissions` together with `--sandbox` by default. The sandbox confines writes to the worktree, and code-flow reverts any changes made during read-only steps. Older agy versions printed nothing when piped; code-flow reports that as an error too.
- Headless agents can't ask you anything. Tools that are not pre-allowed are denied, and the agent works around it or reports it.
- Claude's write mode can run allow-listed commands such as `npm`, `node` and `make`, and those can run arbitrary project scripts. Only run it on repos you trust. Codex is additionally confined by its own sandbox.
- Next steps worth doing:
  - Use `codex app-server` instead of `exec` for mid-turn steering and real approvals.
  - Add triggers: scheduled loops, and CI or GitHub events that start runs. Only after runs are saved to disk.
  - Track quota per vendor and route work to whichever plan has headroom.
  - Add a "council review" pattern for existing PRs.
