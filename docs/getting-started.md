# Getting started

## Requirements

- Node 20+ (`npm start` and `npm run dev` stop with a clear message on an older Node).
- git 2.38 or newer: **Merge** relies on `git merge-tree --write-tree`, which 2.38 added. Check yours with `git --version`.
- At least one of `claude`, `codex` and `agy` installed and signed in. Run each CLI once interactively first. The dots at the bottom of the sidebar show which agents code-flow found.

## Install and run

```bash
git clone https://github.com/midhunxavier/code-flow.git
cd code-flow
npm install
npm start            # http://localhost:4317
```

### Signing in

The first browser that opens code-flow is signed in automatically. That stays possible until a browser signs in (with or without the link) or code-flow first starts an agent, a check or an app. After that, other browsers need the link code-flow prints when it starts (`Open http://localhost:4317/?token=…`).

The session token exists only in the server's memory, so the agents code-flow runs can't use its API, even sandboxed ones with network access. A restart starts a new session, and reloading the page signs you in again.

## Your first run

![The composer: a task and the team patterns, with Plan → Build → Review picked (demo data)](images/composer-light.png)

1. Click the **repository button** under the composer's title to choose a repo. The folder browser is served by the local server, because browsers don't expose absolute paths. It marks git repos and remembers recent ones.
2. Describe the task. Drag files from the **Files** panel, or from Finder, onto the task box to give the agents context. **Improve** (at the right of the task box) rewrites a rough task so agents can act on it: the same intent, with the goal first, the specifics, how to tell it's done, and any open questions. **Undo** puts your text back.
   - It's one short turn by the agent Auto picks, on your subscription, using its read-only permissions in a disposable private Git directory. Improve never resets your working checkout.
   - The arrow next to it picks how: **Quick rewrite** (the default) works from your text alone on a fast model (Claude's Haiku, low effort for Codex and Antigravity). **Use the repository** reads a snapshot of the current committed version so the rewrite can name real files and commands; it takes longer. Uncommitted changes, untracked/ignored files and executable provider configuration are not copied.
   - **Stop** cancels. Editing the task or changing its repository, context, source or execution profile discards the old request; Undo applies only while the rewritten text is still current.
   - Improve supports the **local** execution profile. SSH and container selections disable it, and filesystem restrictions pause it. Other Code Flow mutations in that repository are refused until the turn and cleanup finish. Repository snapshots allow up to 5,000 regular files, 2 MiB per file and 128 MiB in total; unsupported symlinks, submodules and larger snapshots fail explicitly.
3. Pick how the agents work together, and click an agent for each role. Under each role you can set that agent's model and effort for the role. The sentence under the team, such as *"Claude plans → Codex builds → Claude reviews"*, shows what will happen.
4. Optionally open **Settings** to pick the base branch, the result branch name, rounds, limits, permissions, and the default model and effort per provider.
5. Press **Start run** (⌘↵).
   - The run reads like a conversation: your task, then the agents' work as one list of steps (open any step to see its live transcript), then the result. A reply box stays at the bottom.
   - When the run finishes, each result is a branch such as `codeflow/<run>/build`, with buttons to review it, merge it, open a PR, or copy its diff command.
   - **Edit & run again** puts the task back in the composer.

Review and merge results yourself if you prefer the command line:

```bash
git diff main...codeflow/<run>/build
git merge codeflow/<run>/build
```

## Giving agents context

The **Files** tab of the [side panel](runs.md#the-side-panel) (the **Files** button under the task, or <kbd>\</kbd>) shows the selected repo: ignored files are hidden, files with uncommitted changes are marked **M**, and untracked files **U**. To add something to the task's context, drag it onto the task box, click **+**, or double-click it; clicking a file opens it to read. You can also add files from your computer, such as specs, screenshots or logs (up to 10 MB each, 25 MB in total). Drop them from Finder, or use **Attach**.

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

**Per role:** under each role in the team, every agent you picked has a model picker and an effort picker. They override the provider's setting for that role only, for example Opus to plan and Sonnet to review. Left on *Default · …*, they show what the agent will use.

Model lists are cached for 10 minutes. Your choices are remembered in the browser.

## Worktrees and branches

Every worktree a pattern needs (`build`, `candidate-a`, `integration`, …) is created with:

```bash
git worktree add -b <prefix>/<name> <repo>/.worktrees/<run-id>/<name> <base>
```

- **Base branch:** the starting point for every worktree in the run. By default this is the repo's current `HEAD`. The dropdown also lists local branches, remote branches, and the result branches of earlier runs, so you can build on a previous result. Uncommitted changes in your checkout aren't included.
- **Result branch prefix:** defaults to `codeflow/<run-id>`. If you set it to, say, `feat/rate-limit`, results land on `feat/rate-limit/build`. A prefix can only be used once, because git can't have both a `feat/rate-limit` branch and `feat/rate-limit/…` branches.
- **Submodules:** a worktree of a repo with a `.gitmodules` gets its submodules checked out (`git submodule init`, then `git submodule update --init --recursive`, for up to 10 minutes). `init` registers them in the repo's `.git/config`, as it would in your checkout. If cloning one fails (say a private submodule git would have to prompt for), the worktree is still created, without it.
- **Location:** worktrees go in `<repo>/.worktrees/`. code-flow adds `/.worktrees/` to `.git/info/exclude`, which keeps them out of `git status` without editing your `.gitignore`. Tools that don't read git's ignore files (some test runners, linters, `tsc` globs) may still scan `.worktrees/`. Exclude it in their config, or set `CODEFLOW_WORKTREE_DIR` to an absolute path to keep worktrees outside the repo.
- **Cleanup:** remove a run's worktrees with `git worktree remove .worktrees/<run-id>/<name>`, or delete the folder and run `git worktree prune`. The branches stay until you delete them. **Archive…** on a run, and **Clean up** in [Insights](runs.md#insights-comparisons-and-finding-runs), do this for you.

Next: [Team patterns](patterns.md) · [Talking to a run](runs.md)
