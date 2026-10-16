# Team patterns, checks and limits

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

**Auto** in a role picks an installed agent when the run starts. It skips plans that are at 90% or more of a usage window or recently hit a limit, until the limit resets (Claude reports its windows; the others report only when they're limited). Once agents have a few finished runs in a repo, it prefers the one whose code passed the check most often there. The pick and the reason are written to the run's activity log. Quota is saved, so a restart remembers which plans are out.

Verdicts, judge picks, subtask lists and test specs are **schema-constrained**: `claude --json-schema`, `codex --output-schema` and `agy --json-schema`. An answer that still doesn't fit gets one retry in the same session, and then the run **fails**: an unreadable review is never treated as approval.

Judging in a race is blind: no author summaries, a shuffled order (seeded per run, so a resumed run replays identically), and an optional **panel** of judges that vote. Pick vendors that aren't competing; the UI suggests one, and the log warns when a judge also competes.

## Checks, loops and limits

code-flow treats each pattern as a loop, and what it engineers is the loop around the agents:

- **Done when:** a check command such as `npm test`, `pytest` or `cargo test`. It's auto-detected from the repo and editable per repo.
  - Python projects locked with uv or Poetry get their own environment, since system Python doesn't have their packages: with `uv.lock`, setup `uv sync` (`uv sync --all-packages` in a uv workspace) and check `uv run --no-sync pytest -q`; with `poetry.lock`, setup `poetry install` and check `poetry run pytest -q`. When the pytest config lives only in `tests/` (a workspace member of its own), the check runs from there. The composer says what it detected from.
  - **code-flow runs it itself** after each change, in that worktree, and feeds the failing output back to the agent.
  - Loops end on that evidence, not on an agent saying it's done. Every check shows in the run's steps with its output.
  - Pipeline: reviewers only see code that passes.
  - Race: a candidate that fails can't win if another one passes.
  - Supervisor and Debate: the integrated or built result is checked, and the agent fixes failures.
  - Test-first: the new tests must fail first, then pass.
  - When a run finishes but the check still fails, the run is shown as a warning, not a success.
- **A check that can't run isn't a failing check.** Some failures say the environment is wrong, not the code: the command isn't installed (exit 127), Python has neither pytest nor the project's package, pytest can't load `conftest.py` or collects nothing (exit 4 or 5).
  - When the run's first check fails like that, code-flow runs it once more on the base commit, in a throwaway checkout (with your setup). If it fails the same way there, the change isn't to blame.
  - The check is then set aside for the rest of the run: no "Fix failing check" rounds (agents would only rewrite the test setup to get around it), and later checks are skipped.
  - The review still runs, and the reviewer is told nothing was tested. The verdict stays unknown instead of failing.
  - The log, the result card, the inbox and the phone view say *The check can't run here: \<first error line\>. Set `setup` and `check` in .codeflow/config.json*. *Loop until green* stops before its first round, since no round could pass.
  - If the check runs on the base commit, the change broke it, and it's a failing check like any other.
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
- **Setup:** an optional command, such as `npm ci` or `uv sync`, that runs once in every new worktree before the agents start. code-flow runs it itself, outside the agents' sandboxes, so dependencies are installed even though Codex has no network in Standard mode.

Agents may suggest their own test command (the tester in Test-first does). code-flow only runs it if it's a plain invocation of a known test runner, with no shell operators. Otherwise it falls back to your check.

> **Security:** a check runs the agents' code (tests, scripts) on your machine, outside Codex's and agy's sandboxes, as your CI would. Use code-flow on repos and tasks you trust, or run checks in Docker (see [Automations](automations.md#isolation)) or code-flow itself inside a container or VM. More in [Security](security.md).

Adding your own pattern: see [Architecture](architecture.md#adding-a-pattern).
