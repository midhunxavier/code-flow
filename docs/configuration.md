# Configuration

## Per-repo config

Commit `.codeflow/config.json` and every run in that repo (and every teammate) gets the same defaults. Anything you set in the UI wins.

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
  "learn": true,
  "prove": true
}
```

- `check` and `setup`: the composer suggests both from the repo (see [Checks](patterns.md#checks-loops-and-limits)), but set them here when the guess is wrong. A uv workspace whose tests live in their own member might use:

  ```json
  { "setup": "uv sync --all-packages", "check": "cd tests && uv run --no-sync pytest -q" }
  ```

  Setup runs once per worktree outside the agents' sandboxes, so the check can run without network (`--no-sync`). When a run's check can't run at all (not installed, nothing collected, `conftest.py` can't import the project), the run says so and asks you to set these.
- `copy` brings files git doesn't carry (like `.env`) from your checkout into every new worktree. Only regular files that git ignores are copied. Symlinks are refused, since a cloned repo's `.env` could point at your credentials, and so are files git would commit. Patterns can't reach outside the repo.
- `image` is the Docker image for running checks in isolation (automations, untrusted sources). `learn` passes recurring review problems on to later runs. `prove` checks that each passing result has a test that fails without it ([fail-to-pass](patterns.md#checks-loops-and-limits)); set it to `false` when the check is too slow to run twice.
- A result's worktree that was removed (archived) is set up again when you follow up on it: files copied, setup run, context restored, and the files you sent with the follow-up added. If its branch was deleted, that follow-up fails with a clear message; the run itself stays finished. A follow-up also fails, rather than delete anything, when the worktree's folder is there but holds something else: move that folder away, then send it again.
- **Try it:** each result has **Terminal**, **Editor** (Cursor, VS Code, Zed or Sublime, whichever is installed) and **Folder** buttons that open its worktree, plus **▶ Run app**.
  - Run app starts your dev server in the worktree on a free port (passed as `$PORT`), with logs and **Stop app**. Servers stop when the run is archived or code-flow shuts down.

## What agents may do while building

**Settings → permissions:**

| Mode | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Safe | edits files; no shell beyond read-only git | edits inside its sandbox | sandboxed to the worktree |
| Standard (default) | edits + common build/test commands (npm, node, pytest, uv, poetry, cargo, go, make…) | sandboxed, no network | sandboxed to the worktree |
| Trusted | any command | sandboxed, with network | sandboxed to the worktree |
| Full access | any tool, no permission checks (`bypassPermissions`) | no sandbox (`danger-full-access`) | no sandbox (no `--sandbox`) |

**Full access** turns every agent's sandbox off in steps that build: an agent can run anything, use the network, and change files outside its worktree with your credentials. Use it only on repos and tasks you trust completely. To keep it a choice you make:

- It's picked per run in the composer, which warns while it's on, and the run shows ⚠ full access. A repo's `.codeflow/config.json` can't turn it on: `"trust": "full"` there is ignored.
- Planning, reviewing and judging steps stay read-only, as in every mode.
- Runs nobody watches get less: automations and sweeps run with Trusted, and fixes for watched pull requests with Standard.
- A run started from someone outside the repo is locked down to Safe whatever you picked (see [Untrusted text](github.md#untrusted-text)).

Whatever the mode, code-flow never merges or pushes on its own.

## Models

Per provider in **Settings → Models & effort**, and per role right under each role's agents in the team. See [Getting started](getting-started.md#models-and-effort).

## Health

Click the agent dots at the bottom of the sidebar to see, for each CLI, whether it's installed, its version, and whether it's signed in. It uses `claude auth status`, `codex login status`, and for agy whether it can list models; credentials are never read. Claude's 5-hour and 7-day usage windows are shown from its own reports, with how to fix anything that's wrong. A run won't start with an agent that's signed out, and Auto skips an agent that turned out to be signed out for 15 minutes. If agy can't reach its servers, its sign-in shows as unknown rather than signed out.

Health also checks that each installed CLI still accepts the flags and subcommands code-flow passes (from its `--help`), and warns when one is missing: after a CLI update, that's the difference between "healthy" and every step failing on an unknown option. It also checks for git 2.38 or newer, which Merge needs.

Once an agent CLI reports its final result, it gets 10 seconds to exit; one that's still running then (a hook or MCP server that hangs on shutdown) is stopped and its result kept. A single output line over 16 MB is skipped, not read into memory.

## Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | Server port |
| `CODEFLOW_HOME` | `~/.codeflow` | Run logs and code-flow's own files (see [below](#files-in-codeflow)) |
| `CODEFLOW_WORKTREE_DIR` | `.worktrees` | Worktree folder; relative paths are inside each repo, absolute paths are used as-is |
| `CODEFLOW_STEP_TIMEOUT_MIN` | `30` | Timeout per agent step |
| `CODEFLOW_STEP_IDLE_MIN` | `15` | An agent CLI that prints nothing for this long is stuck (a login prompt, a stalled network, a hook that never returns) and is stopped. Keep it above your longest silent test run |
| `CODEFLOW_GIT_TIMEOUT_SEC` | `300` | Longest a git command may run, hooks included; cloning a new worktree's submodules gets 10 minutes |
| `CODEFLOW_MAX_AGENTS` | `6` | Agent CLIs running at once, across all runs |
| `CODEFLOW_MAX_CHECKS` | `3` | Check and setup commands running at once, across all runs |
| `CODEFLOW_RETRY_DELAYS_MS` | `20000,60000` | Waits before retrying an agent turn that failed for a passing reason |
| `CODEFLOW_TOKEN` | random per start | The session token (set it to keep browsers signed in across restarts; anything that can read it can use the API) |
| `CODEFLOW_MAX_DIFF_CHARS` | `60000` | Diffs longer than this are fitted (whole files first) before being passed to another agent |
| `CODEFLOW_CLAUDE_WRITE_TOOLS` | build/test allow-list | Comma-separated Claude tool rules for write mode, e.g. `Edit,Bash` |
| `CODEFLOW_REMOTE_PORT` | `PORT+1` | Port for the phone view (or the full app, with phone control) and webhooks on your network, when *Reachable from my Wi-Fi* is on |
| `CODEFLOW_TLS_CERT`, `CODEFLOW_TLS_KEY` | unset | Configure both certificate/key file paths for the HTTPS network listener; normal full phone control requires TLS |
| `CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL` | unset | Explicit `1` permits full phone control over HTTP for development |
| `CODEFLOW_INTEGRATIONS_FILE`, `CODEFLOW_INTEGRATIONS_JSON` | unset | Explicit read-only external source definitions with server credential references; see [sources](external-sources.md) |
| `CODEFLOW_NOTIFICATIONS_FILE`, `CODEFLOW_NOTIFICATIONS_JSON` | unset | Explicit outbound destinations; targets remain disabled until event/project opt-in; see [notifications](notifications.md) |
| `CODEFLOW_SCHEDULER_TICK_MS` | `30000` | How often due automations are checked |
| `CODEFLOW_WATCH_INTERVAL_MS` | `60000` | How often watched PRs are checked for CI results and new comments |
| `CODEFLOW_CODEX_TRANSPORT` | `auto` | `auto`: `codex app-server` when the installed Codex has it, else `codex exec`. A Codex without app-server is re-checked every 10 minutes; a slow or failed app-server start fails only that turn. `app-server`: require it. `exec`: always `codex exec` (your notes then wait for Codex's next turn) |
| `CODEFLOW_PYTHON` | `python3` | The Python 3 that runs the side panel Terminal's pseudo-terminal (`scripts/pty.py`). It's found once and run by its full path, so a repository that pins another Python (pyenv, asdf, mise) still gets a terminal. Without a working one, terminals are line-based (`interactiveTerminal: false` in `/api/health`) |
| `CODEFLOW_CHROME` | first one installed | The Chrome, Chromium, Edge or Brave the side panel Browser's **Snapshot** runs headless. Without one, Snapshot says so |
| `CODEFLOW_AGY_SKIP_PERMISSIONS` | `1` | Set to `0` to stop passing `--dangerously-skip-permissions` to agy; then configure `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |

A numeric setting that isn't a valid number (`30m`, say) or is out of range falls back to its default, with a warning in the terminal.

Child processes exclude the application API token, scoped team capabilities, integration/notification configuration and their registered server credential variables. They also exclude npm lifecycle variables about code-flow itself and its own dependency bin paths; your `npm_config_*` settings remain. A check's tools come from its repository. Explicit agent containers use a smaller environment and only their configured authentication volume; see [container setup](agent-containers.md).

## Files in `~/.codeflow`

| File | What it is |
|---|---|
| `runs/<run>.jsonl` | Each run's event log, appended as it happens; runs are rebuilt from it at startup. Unreadable lines (a crash mid-write) are skipped and noted in `server.log` |
| `runs/<run>.journal.jsonl` | The result of each completed step, written to disk at once, so **Resume** replays them instead of running them again |
| `projects.json` | Your [projects](runs.md#projects): names, repositories, and the team each one last used. Written whole (through a temporary file); a change that can't be saved fails and is undone. One that can't be read is moved aside to `projects.json.corrupt-<time>` and logged; if it can't be moved either, projects are off (runs start without one) until it's fixed |
| `server.log` | code-flow's own log, one JSON line per entry: failed requests, unhandled errors, failed writes, processes it cleaned up. Past 5 MB it moves to `server.log.1` (one old file is kept) |
| `processes.json` | The process groups code-flow has started and not seen finish. If code-flow dies without a clean exit (a crash, `kill -9`, a closed terminal), the next start stops what's left before resuming anything, so an orphaned agent can't keep editing a worktree. Pids from before a reboot, or reused by another program, are left alone |
| `server.lock` | One server per `CODEFLOW_HOME`. It records the server's pid, start time and the boot, so a lock left by a crash is taken over even when another program now has that pid, or after a reboot |

## Dynamic teams

`CODEFLOW_AUTO_TEAM_ENABLED=false` disables new Auto team runs while preserving saved-run viewing and recovery. Auto remains opt-in; the rollout record and evaluation evidence are shown in Insights. The recorded stage is informational (and a composer default when set to `default`); only `CODEFLOW_AUTO_TEAM_ENABLED` changes whether new Auto runs can start. Existing runs without the `eventDriven` option retain dependency-wave replay; newly created Auto runs default it on.

The authenticated run API accepts `loop.maxInvocations` as an additional per-allocation ceiling on actual CLI launches, including retries. Auto already caps launches with its step budget. Follow-up requests can specify `budget: { maxSteps, maxInvocations, maxMinutes }`; the UI exposes this fresh allocation and retains lifetime usage.

Project memory is in `memory.json`; evaluation reports and the explicit rollout decision live under the evaluation store in `CODEFLOW_HOME`. Both use durable replacement writes. See [Auto team](auto-team.md) for scope, trust, revision and deletion semantics.
