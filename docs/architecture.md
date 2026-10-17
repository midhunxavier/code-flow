# Architecture and development

## Layout

```
ui/*.tsx                 UI: Preact + TypeScript, compiled against the server's own types
                         (app: shell and top bar · rail: the sidebar · composer · run: the run thread · review · insights · automations · projects
                          · side: the side panel's chat, files, terminal, browser and notes)
ui/bits.tsx              small shared pieces: agent tags, the Markdown renderer, QR codes
ui/styles.css, ui/fonts  the stylesheet and its fonts (Manrope, Roboto Mono; licences included)
scripts/build-ui.mjs     bundles the UI, fonts and images into one self-contained public/index.html (npm start builds it)
scripts/check-node.mjs   stops npm start and npm run dev on a Node older than 20, saying why
src/server.ts            HTTP API + SSE on 127.0.0.1 (Host/Origin checked, session cookie or Bearer token)
src/store.ts             run logs and the replay journal on disk, the one-server lock
src/projects.ts          projects: named groups of repos, and which project a new run goes in
src/log.ts               code-flow's own log, ~/.codeflow/server.log (rotated at 5 MB)
src/env.ts               the environment of everything code-flow starts: yours, minus its token, npm_* and its own node_modules/.bin
src/integrity.ts         finds changes to tests that could make a check pass without a fix
src/diff.ts              fits a long diff into a prompt (whole files first)
src/learnings.ts         the repo's conventions files, and problems reviewers keep raising
src/slots.ts             caps how many agents and checks run at once
src/stats.ts             Insights: per agent, per pattern, comparisons; ranking for Auto
src/ship.ts              per-file diffs, safe merges, pull requests, worktree cleanup
src/github.ts            gh: issues, PRs, checks, failed-job logs, comments, pushes
src/watch.ts             PR follow-through: polls watched PRs and sends CI failures and comments back
src/routing.ts           "Auto" roles: pick an agent whose plan has room (and that passes most in this repo)
src/templates.ts         starting points (fix an issue, fix failing CI, council review…) and sweeps
src/sweeps.ts            sweeps: list issues, Dependabot PRs and alerts; start one run per picked item
src/automation.ts        automations: schedules, webhooks (Bearer or GitHub signature), firing runs
src/remote.ts            the phone link: read-only view (server-rendered), settings for full phone control
src/engine.ts            RunManager, TeamContext (ask / worktree / commit / diff), event log
src/patterns/*.ts        the team patterns, written against TeamContext
src/adapters/*.ts        AgentAdapter per CLI → normalized AgentEvent stream
src/git.ts               every git call (bounded, never prompts), worktrees with their submodules, branches, commits, diffs, merges
src/repo-tree.ts         file tree, search and file contents for the Files tab
src/shell.ts             the side panel's Terminal: shells kept open between commands, with a marker after each
src/notes.ts             the side panel's Notes, ~/.codeflow/notes.json
src/context.ts           validates and stages task context for agents
```

- **AgentAdapter** (`src/adapters/types.ts`): `run({prompt, cwd, mode, resumeSessionId}, onEvent) → {ok, finalText, sessionId, errorKind, resetsAt}`. `sessionId` is only ever one the CLI confirmed in that turn, never a session that failed to resume. A failed turn says why in `errorKind` (`usage_limit`, `auth`, `session_not_found`, `cli_incompatible`, `stalled`, `transient`…), read from the CLI's own signals (`src/adapters/errors.ts`), and the engine retries, stops or starts a fresh session on that. Adapters convert each CLI's JSONL into `text | thinking | tool_call | tool_result | usage | status | error` events. An adapter whose turns take input while they run calls `onSteerable(steer)` once its turn can be steered. The engine then hands queued notes to `steer`. `src/adapters/codex-app-server.ts` turns app-server notifications into the events `codex exec --json` prints, so both Codex transports share one handler.
- **TeamContext** gives patterns a few primitives. `ask()` runs one agent turn as a visible step, and `resume` continues that agent's own conversation. `worktree()`, `commit()`, `diff()` and `artifact()` handle git. `parallel()` runs branches side by side (race contestants, workers, debaters); when one throws, the others are stopped and waited for, so nothing keeps running after the run ends. Structured hand-offs (review verdicts, judge picks, subtask lists) use a fenced ```` ```json ```` block that `extractJson` parses.
- Every event is appended to `~/.codeflow/runs/<run>.jsonl`. Worktrees live in `<repo>/.worktrees/<run-id>/` (see [Worktrees and branches](getting-started.md#worktrees-and-branches)).

### Adding a pattern

Write a `Pattern` (roles, options, `run(ctx)`) in `src/patterns/`, then add it to `src/patterns/index.ts`. The UI builds its form from the pattern definition.

### Adding an agent

Implement `AgentAdapter` in `src/adapters/`, then register it in `src/adapters/index.ts`. Add a fake for it in `test/fake-agent.mjs`.

## Development

`npm start` is your server (port 4317, `~/.codeflow`). `npm run dev` is a development server (port 4318, `.codeflow-dev/`) with **fake agents**, so working on code-flow never touches your real runs or quota. It puts `test/fake-bin` on `PATH` by absolute path and refuses to start if `claude`, `codex` or `agy` would still resolve to a real CLI. `npm run dev:real` is the same dev server with the real CLIs. Both rebuild the UI and restart the server as you edit.

```bash
npm run dev        # http://localhost:4318, fake agents
npm run typecheck
```

## Tests

```bash
npm test           # unit + workflow tests against fake CLIs
npm run test:e2e   # the real UI in Chrome (headless) against a server with fake agents
```

CI (`.github/workflows/ci.yml`) runs the typecheck and `npm test` on every push and pull request: Ubuntu with Node 20 and 22, macOS with Node 22. The e2e test runs there too, in its own job that doesn't fail the build.

The suite runs every pattern end to end against fake `claude` / `codex` / `agy` binaries (`test/fake-bin`). Each fake emits that vendor's real JSONL format, so tests cost no quota.

- The fake `codex` also serves the app-server protocol (`test/fake-codex-app-server.mjs`). Its threads persist across processes, so resume and per-turn token counts are tested. A prompt containing `WAIT-FOR-STEER` keeps a turn open until a note is steered in. `test/codex-app-server.test.ts` covers mid-turn notes, declined approvals, cancellation, and the `exec` fallback.
- A fake `gh` keeps issues, PRs, checks, comments and security alerts in a JSON file and pushes to a local bare repository, so the GitHub flows (fix CI → push → watch → fix again, and sweeps of issues, Dependabot PRs and alerts) are tested without touching GitHub.
- A fake `docker` records its arguments and runs the command in place, so isolation is tested without Docker.
- The suite covers review loops, races with a failing contestant, critique rounds, merge-conflict resolution, and the guarantee that your checkout is untouched.

`test/hardening.test.ts` covers the guarantees about processes, runs and tests:

- a background process an agent leaves behind neither hangs a step nor survives it;
- a run can't be resumed twice at once;
- a commit made in a read-only step is undone;
- a loop doesn't accept a pass made by deleting the failing test;
- race commits name no vendor;
- the builder's test edits are undone;
- retries, usage-limit stops and token accounting work.

Reliability has tests of its own:

- `test/foundation.test.ts`: the child environment, numeric settings, bounded git, the repo lock, and orphaned processes reaped at the next start;
- `test/store-reliability.test.ts`: a failed write can't corrupt the next line of a run log; the server lock is taken over from a reused pid or a previous boot, and of several servers starting at once exactly one gets it;
- `test/git-reliability.test.ts`: worktrees get their submodules (nested, in parallel, or a warning when one can't be cloned), and the Files tab's git calls;
- `test/side-panel.test.ts`: the side panel's server side: reading a file (and never one outside the repo), notes that persist, shells whose `cd` holds between commands and whose exit codes come back, and the list of running apps;
- `test/engine-reliability.test.ts`: parallel branches that stop together, steps that always end, read-only that fails closed, worktrees set up again after an interrupted setup, retries that continue instead of redoing, dead sessions, usage limits with reset times, lockdown without network, and unique run ids;
- `test/adapters-reliability.test.ts` and `test/health-routing.test.ts`: the stall watchdog, the grace after a result, crashes mid-stream, dead sessions, unknown flags, huge lines, typed errors, Health's flag checks, and Auto skipping a signed-out CLI. The fakes simulate these with `FAKE_SLEEP_VENDOR`, `FAKE_HANG_AFTER_RESULT_VENDOR`, `FAKE_CRASH_VENDOR`, `FAKE_UNKNOWN_FLAG`, `FAKE_HUGE_LINE_MB`, `FAKE_CLAUDE_RESETS_AT`, and for app-server `FAKE_CODEX_SLOW_INIT_MS`, `FAKE_CODEX_INIT_CRASH`, `FAKE_CODEX_HANG_METHOD` and `FAKE_CODEX_SERVER_REQUEST`.

The GitHub tests cover untrusted issues (lockdown, fenced text, Docker or your confirmation) and PR watches that act only on comments from you and the people you allow. The e2e test also covers sign-in, Insights and run search.

## What's next

- Real approvals through `codex app-server` (it already declines approval requests): ask you in the UI instead.
- A container option for the agents themselves (today only checks and setup run in Docker).
- Write run snapshots as deltas and compact old logs (today every state change appends a full snapshot).
- Read PR line comments (review threads), not just conversation comments and review summaries.
- Linear as a source, next to GitHub issues.
