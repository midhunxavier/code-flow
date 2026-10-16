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
  "learn": true
}
```

- `check` and `setup`: the composer suggests both from the repo (see [Checks](patterns.md#checks-loops-and-limits)), but set them here when the guess is wrong. A uv workspace whose tests live in their own member might use:

  ```json
  { "setup": "uv sync --all-packages", "check": "cd tests && uv run --no-sync pytest -q" }
  ```

  Setup runs once per worktree outside the agents' sandboxes, so the check can run without network (`--no-sync`). When a run's check can't run at all (not installed, nothing collected, `conftest.py` can't import the project), the run says so and asks you to set these.
- `copy` brings files git doesn't carry (like `.env`) from your checkout into every new worktree. Only regular files that git ignores are copied. Symlinks are refused, since a cloned repo's `.env` could point at your credentials, and so are files git would commit. Patterns can't reach outside the repo.
- `image` is the Docker image for running checks in isolation (automations, untrusted sources). `learn` passes recurring review problems on to later runs.
- A result's worktree that was removed (archived) is set up again when you follow up on it: files copied, setup run, context restored. If its branch was deleted, that follow-up fails with a clear message; the run itself stays finished.
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

Click the agent names in the top bar to see, for each CLI, whether it's installed, its version, and whether it's signed in. It uses `claude auth status`, `codex login status`, and for agy whether it can list models; credentials are never read. Claude's 5-hour and 7-day usage windows are shown from its own reports, with how to fix anything that's wrong. A run won't start with an agent that's signed out.

## Environment variables

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
| `CODEFLOW_REMOTE_PORT` | `PORT+1` | Port for the phone view (or the full app, with phone control) and webhooks on your network, when *Reachable from my Wi-Fi* is on |
| `CODEFLOW_SCHEDULER_TICK_MS` | `30000` | How often due automations are checked |
| `CODEFLOW_WATCH_INTERVAL_MS` | `60000` | How often watched PRs are checked for CI results and new comments |
| `CODEFLOW_CODEX_TRANSPORT` | `auto` | `auto`: `codex app-server` when the installed Codex has it, else `codex exec` (decided once per server start). `app-server`: require it. `exec`: always `codex exec` (your notes then wait for Codex's next turn) |
| `CODEFLOW_AGY_SKIP_PERMISSIONS` | `1` | Set to `0` to stop passing `--dangerously-skip-permissions` to agy; then configure `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` |
