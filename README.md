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
| **Plan → Build → Review** | planner, builder, reviewer | Plan (read-only) → implement → independent review → builder fixes (resuming its own session) → re-review, up to *N* rounds | Most features and bug fixes. Cross-vendor review catches what a model misses in its own work |
| **Best-of-N race** | contestants (2+), judge | All contestants solve the task in parallel, each in its own worktree → judge compares **anonymized** diffs (Candidate A/B…) and picks one | The solution space is wide, or the task is risky enough to want several independent attempts |
| **Debate → Synthesize → Build** | debaters (2+), synthesizer, builder (optional) | Independent proposals → critique rounds where each debater sees the others' proposals and revises → synthesizer merges and records each decision → builder implements | Architecture, API design, big refactors. Leave the builder empty for design only |
| **Supervisor → Workers** | supervisor, workers (1+) | Supervisor splits the task into parallel subtasks and assigns workers → workers build on separate branches → branches merge into an integration branch; the supervisor resolves conflicts, reviews and fixes | Larger tasks that split cleanly (backend / frontend / tests) |
| **Test-first (adversarial tester)** | tester, builder | Tester writes failing tests → builder makes them pass without editing them (code-flow flags it if it does) → tester runs them, adds edge-case tests, and sends failures back | Behavior you can specify with tests. Stops an agent from grading its own homework |

Every pattern works with any mix of agents. A good default is to have a **different vendor review or judge** than the one that wrote the code.

## Architecture

```
public/index.html        single-page UI (vanilla JS, SSE)
src/server.ts            HTTP API + SSE on 127.0.0.1 (Host/Origin checked)
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
npm test
```

The suite runs every pattern end to end against fake `claude` / `codex` / `agy` binaries (`test/fake-bin`). Each fake emits that vendor's real JSONL format, so tests cost no quota. The suite covers review loops, races with a failing contestant, critique rounds, merge-conflict resolution, test tampering detection, and the guarantee that your checkout is untouched.

## Caveats and next steps

- **agy permissions** (tested with agy 1.3.5): when headless agy hits a tool it isn't allowed to use, it doesn't work around it. The turn ends with an empty answer, which code-flow reports as a failed step that names the denied action. That's why code-flow passes `--dangerously-skip-permissions` together with `--sandbox` by default. The sandbox confines writes to the worktree, and code-flow reverts any changes made during read-only steps. Older agy versions printed nothing when piped; code-flow reports that as an error too.
- Headless agents can't ask you anything. Tools that are not pre-allowed are denied, and the agent works around it or reports it.
- Claude's write mode can run allow-listed commands such as `npm`, `node` and `make`, and those can run arbitrary project scripts. Only run it on repos you trust. Codex is additionally confined by its own sandbox.
- Runs are kept in memory, so restarting the server clears the run list. The JSONL logs on disk remain.
- Next steps worth doing:
  - Use `codex app-server` instead of `exec` for mid-turn steering and real approvals.
  - Add human approval gates between steps.
  - Track quota per vendor and route work to whichever plan has headroom.
  - Add a "council review" pattern for existing PRs.
  - Add a button to clean up worktrees (`git worktree remove`).
