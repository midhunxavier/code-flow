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

In the UI, pick a repo with **Browse…**, or type an absolute path. The folder browser is served by the local server, because browsers don't expose absolute paths. It marks git repos and lists your recent ones. Then enter a task, pick a pattern, assign agents to roles, and press **Start run**. When the run finishes, each result is a branch such as `codeflow/<run>/build`. Review it and merge it yourself:

```bash
git diff main...codeflow/<run>/build
git merge codeflow/<run>/build
```

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
src/git.ts               worktrees, commits, diffs, merges
```

- **AgentAdapter** (`src/adapters/types.ts`): `run({prompt, cwd, mode, resumeSessionId}, onEvent) → {ok, finalText, sessionId}`. Adapters convert each CLI's JSONL into `text | thinking | tool_call | tool_result | usage | status | error` events.
- **TeamContext** gives patterns a few primitives. `ask()` runs one agent turn as a visible step, and `resume` continues that agent's own conversation. `worktree()`, `commit()`, `diff()` and `artifact()` handle git. Structured hand-offs (review verdicts, judge picks, subtask lists) use a fenced ```` ```json ```` block that `extractJson` parses.
- Every event is appended to `~/.codeflow/runs/<run>.jsonl`. Worktrees live in `~/.codeflow/worktrees/` (override with `CODEFLOW_HOME`).

### Adding a pattern

Write a `Pattern` (roles, options, `run(ctx)`) in `src/patterns/`, then add it to `src/patterns/index.ts`. The UI builds its form from the pattern definition.

### Adding an agent

Implement `AgentAdapter` in `src/adapters/`, then register it in `src/adapters/index.ts`. Add a fake for it in `test/fake-agent.mjs`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `CODEFLOW_HOME` | `~/.codeflow` | Worktrees and run logs |
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
