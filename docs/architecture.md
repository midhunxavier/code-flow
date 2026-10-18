# Architecture and development

## Layout

```
ui/*.tsx                 UI: Preact + TypeScript, compiled against the server's own types
                         (app: shell and top bar · rail: the sidebar · composer · run: the run thread · review · insights · automations · projects
                          · project: a project's page · side: the side panel, its files and notes · side-chat, changes, terminal, browser: its other tabs
                          · panel-bits: what the tabs share (folders, the strip of open sessions, menus))
ui/bits.tsx              small shared pieces: agent tags, the Markdown renderer, QR codes
ui/styles.css, ui/fonts  the stylesheet and its fonts (Manrope, Roboto Mono; licences included)
scripts/build-ui.mjs     bundles the UI, fonts and images into one self-contained public/index.html (npm start builds it)
scripts/check-node.mjs   stops npm start and npm run dev on a Node older than 20, saying why
scripts/pty.py           the Terminal's pseudo-terminal (Python 3 standard library, no native npm module): runs your login shell in a pty, relays its bytes, takes resizes and reports the shell's pid, its terminal and the foreground on fd 3; when it ends, it hangs up everything in the shell's session
src/server.ts            HTTP API + SSE on 127.0.0.1 (Host/Origin checked, session cookie or Bearer token)
src/store.ts             run logs and the replay journal on disk, the one-server lock
src/teams.ts             provider-independent team members, tasks, messages and context projections
src/memory.ts            private/team/project memory, revisions, provenance and atomic snapshots
src/team-memory.ts       run/project scope and Git applicability for memory retrieval and proposals
src/team-mailbox.ts      validated atomic collaboration commands, requests and waits
src/team-scheduler.ts    recorded completion batches with concurrent worker lifetimes
src/team-tools.ts        expiring member capability service; stdio MCP client in team-tool-client.mjs
src/team-evaluation.ts   immutable evaluations and evidence-gated rollout decisions
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
src/shell.ts             the side panel's Terminal: shells kept open, in a pseudo-terminal through scripts/pty.py (busy while a program other than the shell is in the foreground; never closed to make room while it has jobs in the background, found with ps); line-based with a marker after each command when there's no python3
src/preview.ts           the side panel's Browser: a proxy per local app, on a port of its own, that adds the overlay (src/preview-overlay.js: pick, box, console, adjust), rewrites the app's Content-Security-Policy so only code-flow (and the app itself) can frame it, and keeps code-flow's cookies from the app
src/snapshot.ts          the Browser's Snapshot: a screenshot of any address in a headless Chrome with a fresh profile, driven over its DevTools pipe (no debugging port), one at a time
src/notes.ts             the side panel's Notes, ~/.codeflow/notes.json
src/context.ts           validates and stages task context for agents
```

- **AgentAdapter** (`src/adapters/types.ts`): `run({prompt, cwd, mode, resumeSessionId}, onEvent) → {ok, finalText, sessionId, errorKind, resetsAt}`. `sessionId` is only ever one the CLI confirmed in that turn, never a session that failed to resume. A failed turn says why in `errorKind` (`usage_limit`, `auth`, `session_not_found`, `cli_incompatible`, `stalled`, `transient`…), read from the CLI's own signals (`src/adapters/errors.ts`), and the engine retries, stops or starts a fresh session on that. Adapters convert each CLI's JSONL into `text | thinking | tool_call | tool_result | usage | status | error` events. An adapter whose turns take input while they run calls `onSteerable(steer)` once its turn can be steered. The engine then hands queued notes to `steer`. `src/adapters/codex-app-server.ts` turns app-server notifications into the events `codex exec --json` prints, so both Codex transports share one handler.
- **TeamContext** gives patterns a few primitives. `ask()` runs one agent turn as a visible step, and `resume` continues that agent's own conversation. `worktree()`, `commit()`, `diff()` and `artifact()` handle git. `parallel()` runs branches side by side (race contestants, workers, debaters); when one throws, the others are stopped and waited for, so nothing keeps running after the run ends. Structured hand-offs (review verdicts, judge picks, subtask lists) use a fenced ```` ```json ```` block that `extractJson` parses.
- Every event is appended to `~/.codeflow/runs/<run>.jsonl`. Worktrees live in `<repo>/.worktrees/<run-id>/` (see [Worktrees and branches](getting-started.md#worktrees-and-branches)).

**Auto team** uses the same engine with validated plans and bounded event-driven scheduling (with saved-wave compatibility) (`src/patterns/auto-team-model.ts`, `auto-team.ts`). Stable member IDs separate identity from provider; turn metadata binds settings, session, task, usage and selected context. Questions yield a turn rather than holding a slot. Accepted plans and admission decisions replay from the journal; strict journal failures stop dependent execution. A stopped workflow resumes through completed waves and final verification before beginning another user-authorized allocation. Project memory selections journal references, not bodies; replay resolves only still-applicable exact revisions. See [Auto team](auto-team.md) for the public behavior and trust/retention boundaries.

### Adding a pattern

Write a `Pattern` (roles, options, `run(ctx)`) in `src/patterns/`, then add it to `src/patterns/index.ts`. The UI builds its form from the pattern definition.

`ctx.artifact()` proves a result whose check passed (fail-to-pass, see `TeamContext.prove`), so a new pattern gets proofs without doing anything. To act on one before publishing, as Pipeline does before review, use `proveOrAsk()` from `src/patterns/prompts.ts`, and `proofEvidence()` to show it to a reviewer or judge.

A pattern with a reviewer asks for `REVIEW_SCHEMA` with `reproRule()` and `REVIEW_SHAPE`, then passes the verdict to `checkReview()` (all in `src/patterns/findings.ts`): it runs each finding's repro on the result (`TeamContext.reproduce`), records the review on the run, and marks what blocks approval (`blocks` in the engine). `approves()` is the gate, and `findingsForBuilder()` is what the builder gets back.

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
- `test/ship.test.ts` covers side chats too: sessions and messages kept apart from the run's thread, a budget of their own behind the team, an Ask that keeps the verdict and your edits, and files sent to a run whose worktrees were removed.

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
- `test/side-panel.test.ts`: the side panel's server side: reading a file (and never one outside the repo), notes that persist, shells whose `cd` holds between commands and whose exit codes come back, a new shell never closing a busy one or one with a job in the background, terminals that hang up their `nohup`'d and disowned jobs when code-flow stops and that still start in a repo pinning a Python its version manager doesn't have, the list of running apps, and the browser's preview proxy (the overlay added, frames allowed, the app's own host and origin, WebSockets, and the Host check);
- `test/preview.test.ts`: the preview proxy against a stand-in dev server: where the overlay goes in a page, the app's policy kept but frameable, the host name and code-flow's cookies, compressed pages, connections that close when the browser's do, and the overlay itself in headless Chrome (Box doesn't click through, no passwords in snapshots, console reports; skipped without Chrome);
- `test/snapshot.test.ts`: Snapshot's checks on the address and size, the viewport and the whole page checked pixel by pixel (a desktop page at phone width zoomed out, not cut off), one Chrome at a time, a page that can't be opened, an `alert()`, a Chrome that dies (and the next snapshot still working), and no profiles left behind (skipped without Chrome);
- `test/browser.test.ts` and `test/chat-views.test.ts`: the side panel's UI logic, bundled with esbuild: which addresses the Browser believes from the page, where pins can be sent and how they're named, comment drafts shared by the review and the Changes tab, and side chats kept out of the run's thread;
- `test/engine-reliability.test.ts`: parallel branches that stop together, steps that always end, read-only that fails closed, worktrees set up again after an interrupted setup, retries that continue instead of redoing, dead sessions, usage limits with reset times, lockdown without network, and unique run ids;
- `test/adapters-reliability.test.ts` and `test/health-routing.test.ts`: the stall watchdog, the grace after a result, crashes mid-stream, dead sessions, unknown flags, huge lines, typed errors, Health's flag checks, and Auto skipping a signed-out CLI. The fakes simulate these with `FAKE_SLEEP_VENDOR`, `FAKE_HANG_AFTER_RESULT_VENDOR`, `FAKE_CRASH_VENDOR`, `FAKE_UNKNOWN_FLAG`, `FAKE_HUGE_LINE_MB`, `FAKE_CLAUDE_RESETS_AT`, and for app-server `FAKE_CODEX_SLOW_INIT_MS`, `FAKE_CODEX_INIT_CRASH`, `FAKE_CODEX_HANG_METHOD` and `FAKE_CODEX_SERVER_REQUEST`.

The GitHub tests cover untrusted issues (lockdown, fenced text, Docker or your confirmation) and PR watches that act only on comments from you and the people you allow. The e2e test also covers sign-in, Insights and run search. Its terminals run bash with a home of their own, so your dotfiles and shell history stay out of it.

## What's next

- Real approvals through `codex app-server` (it already declines approval requests): ask you in the UI instead.
- A container option for the agents themselves (today only checks and setup run in Docker).
- Write run snapshots as deltas and compact old logs (today every state change appends a full snapshot).
- Read PR line comments (review threads), not just conversation comments and review summaries.
- Linear as a source, next to GitHub issues.

## Dynamic team control and replay

A live tool command and its receipt are fsynced together before acknowledgement. The scheduler records which command batch it consumes at each boundary, so replay cannot inject a future reply into an earlier task. Completion batches likewise record observed order before serial integration. One server owns the journal; no dispatch lease or outbox is needed. See the [implementation plan](dynamic-teams-implementation-plan.md) for the invariants.

The scoped loopback bridge is separate from the user API and its bearer token. Official adapters receive a temporary stdio MCP configuration for supported turns. Memory tools inherit the active member, project, task and source provenance from the engine. Native spawning controls, sandbox support and nested usage limitations are exposed through the capability inventory. Supervisor shares decomposition/integration primitives while retaining its public ID and historical replay identities.
