# GitHub, review and shipping

## Review and ship

When a run finishes, each result branch has **Review changes**, **Merge…** and **Open PR…** buttons.

- **Review changes** opens a per-file diff. Click any line to comment on it, and add an overall comment if you like.
  - **Send N comments to [agent]** queues a *follow-up* in the same run: that agent continues its own session in the worktree, addresses the comments, and code-flow commits and re-runs the check.
  - Follow-ups are recorded on the run, so they survive restarts. The result header and summary reflect the latest follow-up.
  - Draft comments are kept if you navigate away.
- **Merge…** merges the result into one of your branches, and only when that's safe:
  - If the target branch is checked out (e.g. `main` in your checkout), the merge happens there, and only when it has no uncommitted changes to tracked files (staged or not).
  - If something else stops it — untracked files the merge would overwrite, another git holding the repository's lock, a failing hook, git not knowing your name and email — you're told which (and which files), and your checkout is put back as it was.
  - That merge runs your hooks, with up to 30 minutes for them (`CODEFLOW_MERGE_TIMEOUT_SEC`), so a post-merge `npm install` or a Git LFS download has time. If git is stopped after it made the merge commit, the merge is done, and you're warned the hook may not have finished.
  - If the target branch isn't checked out anywhere, code-flow builds the merge with `git merge-tree` and moves the branch, so no checkout is touched. That needs git 2.38 or later; with an older git, check the branch out and merge there.
  - A branch that's being rebased or bisected in one of your worktrees isn't merged into: finishing or aborting the rebase would undo the merge. You're told where, and what to run there first.
  - On a real conflict you see the files and can **ask an agent to resolve them**: code-flow merges the target into the result branch and the agent fixes the markers. Then merge again.
  - By default the run is archived after merging (worktrees removed, branches kept).
  - Merging a branch that's already in the target says *Nothing to merge* instead of recording a second merge.
- **Merge PR…** takes the place of **Merge…** once the branch has a pull request, and merges that pull request on GitHub (`gh pr merge`):
  - Pick how, from the ways the repository allows: a merge commit, squash, or rebase. You confirm before anything happens. The panel shows the PR's CI, and says so if GitHub reports a conflict.
  - It merges only while the pull request is exactly the branch you reviewed here. If the branch has commits the PR doesn't have yet (a follow-up that wasn't pushed), or someone pushed to the PR, you're told which and nothing is merged; GitHub also refuses if the PR moves in the meantime.
  - A draft or closed PR isn't merged; one already merged on GitHub is recorded as merged. No branch is deleted, and `origin/<base>` is fetched afterwards.
  - With a merge queue, or rules that hold the merge until required checks pass, GitHub accepts it and merges later.
  - **Merge into a local branch instead…** still offers the local merge above.
- **Open PR…** pushes the branch to `origin` and opens a pull request with `gh`, using the task and summary as the description (cut to fit GitHub's 65,536-character limit). If the push works but `gh` then fails, or a pull request for the branch is already open, code-flow finds that pull request and records it, so trying again doesn't fail with "already exists".
- **Archive…** removes a run's worktrees (optionally its branches too). Kept branches can still be merged or resumed later. A worktree git won't remove (a locked one, one with submodules) is tried again with `--force` twice; whatever still can't be removed is reported rather than left behind silently.
- **Try it:** each result also has **Terminal**, **Editor** and **Folder** buttons and **▶ Run app**; see [Configuration](configuration.md#per-repo-config).

## Start from where the work lives

Runs can start from GitHub instead of a blank task box, using GitHub CLI (`gh`) with your own login.

### Templates

**Start from** above the task box sets up common jobs:

| Template | Pattern | Starts from |
|---|---|---|
| **Fix an issue** | Plan → Build → Review | an issue; the PR you open later says `Closes #N` |
| **Fix failing CI** | Plan → Build → Review | a PR, with its failing checks and their job logs (`gh run view --log-failed`) given to the agents |
| **Review a PR as a council** | Review council | a PR |
| **Upgrade a dependency** | Plan → Build → Review | the task box (replace `PACKAGE`) |

The task names the issue or PR by number. Its title isn't put in the task (whoever opened it wrote it, and agents read the task as instructions); it reaches them with the issue's or PR's text.

### Sweeps: many at once

**Sweep** under *Start from* lists a whole kind of work, with a checkbox per item. The ones you pick start **one run each**, with the team, check and settings you set up in the composer. Each result waits in the [inbox](automations.md#the-inbox) for you to approve, revise or reject, and nothing is merged automatically.

| Sweep | Lists | Picked by default | Each run |
|---|---|---|---|
| **Fix open issues** | open issues | all, except ones labelled *question*, *wontfix*, *duplicate*, *invalid*… | fixes the issue and adds a test; **Approve & open PR** says `Closes #N` |
| **Fix Dependabot PRs** | Dependabot's open PRs (`gh pr list --app dependabot`), with their CI | only the ones whose CI fails; green ones say *ready for you to merge* | gets the failing checks and their logs, adapts the code to the new version, with the PR's text and logs [fenced as untrusted](#untrusted-text); **Approve & push to PR #N** pushes the fix to Dependabot's branch (never forced) |
| **Fix security alerts** | Dependabot alerts, code scanning alerts and leaked secrets | high and medium alerts that have a fix | Dependabot alerts: one run per package, upgrading past every alert on it. Code scanning: one run per alert, fixing the cause rather than suppressing it |

- An item that already has a run (running, or finished and not rejected) starts unpicked and links to that run, so sweeping again doesn't redo work. For a package's Dependabot alerts that means a run covering every one of them: a new alert on the package is new work.
- Lists read every page GitHub has, up to 1,000 items of each kind (200 Dependabot PRs), and say so when there were more.
- Dependabot alerts that an open Dependabot PR already upgrades start unpicked, and so do alerts with no patched version yet (that run would have to mitigate instead).
- **Leaked secrets are never handed to an agent.** They're listed so you can revoke and rotate them yourself.
- At most 25 runs start per sweep; agents and checks still queue behind `CODEFLOW_MAX_AGENTS` and `CODEFLOW_MAX_CHECKS`. A run that can't start (an untrusted issue without Docker, say) is reported, and the rest go on.
- *Also check every day at…* saves the sweep as an [automation](automations.md#sweeps) that starts runs for new items.
- Reading security alerts needs the `security_events` scope for private repositories: `gh auth refresh -s security_events` (and admin or security manager access). The sweep says so if it's missing, or if a feature isn't turned on for the repo.

### Issues and pull requests

**GitHub** in the task box starts from any open issue or PR:

- An **issue's** title and description go to every agent with the task.
- A **PR's** branch is fetched (`pull/N/head`, so forks work too) and becomes the run's base. Its description goes to the agents, and its changes are compared against the PR's target branch.
- When a run came from a PR, a result has **Push to PR #N**. It pushes to the PR's branch and is never forced, so it fails if someone else pushed in the meantime. You can't push to a PR from a fork; you can still review it.

### Review council

A read-only pattern: several agents review the same changes independently, and a chair merges their findings.

- Reviewers are anonymous to the chair ("Reviewer A/B"). code-flow runs the tests reviewers show their bugs with before the chair merges, and findings rank by severity, then by whether a test confirms them, then by how many reviewers agree. The verdict follows the findings, not the chair: changes are requested when a finding blocks (see [checked review findings](patterns.md#checks-loops-and-limits)).
- Nothing is changed. **Post to PR #N** posts the review as a comment, and only when you click it.

### Follow-through

**Watch PR** works on a result that has a PR. code-flow checks it every minute. A PR that stays green with no new comments is checked less often, up to every 10 minutes, and every minute again once something changes:

- **Failing CI:** the failed jobs' logs go to the agent you picked, which fixes the cause. code-flow commits and pushes to the PR.
- **New comments** from you (the account `gh` is signed in as), or from people you list under *Also act on comments from*, go to the agent in the same way. Nobody reviews these fixes before they're pushed, so anyone else's comments are logged and ignored, even an org member's. Comments that were there before you started watching are never acted on.
  - PR comments and a review's summary are read. Line comments on the diff aren't read yet; the run's log says so when watching starts.
- These unattended fixes never run with more than *standard* permissions, and a fix that touches the tests at all isn't pushed: a deleted, skipped or weakened test, a changed test config or CI workflow, the runner's settings in `package.json` or `pyproject.toml`, or fewer tests running than before the fix. It's handed back to you instead.
- **Stops:** after the number of fixes you allow, if someone else pushed to the PR, or when the PR is merged or closed. It then shows under *Needs you* with a notification.
- **Can't check:** when checking the PR fails (`gh` signed out, rate-limited, offline), code-flow waits longer before each retry. After three failures in a row the watch shows under *Needs you* with the reason, e.g. *gh isn't signed in — run `gh auth login`* (it asks `gh auth status` to tell). It keeps retrying, and goes back to watching once `gh` answers again.
- It **never merges**.

### Untrusted text

Text from outside the repo is untrusted. Issue and PR titles and descriptions, comments and CI logs can carry instructions aimed at the agents. code-flow asks GitHub who wrote an issue or PR. Unless it's the repo's owner, a member or a collaborator, and not a fork, the run is locked down (🔒 in the run view):

- agents run in Safe mode;
- files like `.env` aren't copied in;
- checks run in Docker without network.

**Dependabot's PR text is untrusted too.** GitHub opens the PRs, but their descriptions quote the new version's release notes and commit messages word for word, and their CI logs print the new package's output. That text is fenced as data. The run itself isn't locked down: the branch is this repository's and installs what merging it would, so setup can install the new version (with network) and the check can verify it. Pushing a fix to Dependabot's branch still works.

**A code scanning alert's message is fenced too.** It quotes the code it flags (names, strings), which whoever wrote that code chose. The rule's own description and help aren't fenced.

Without Docker, code-flow asks before running that person's tests on your machine; automations never do. **▶ Run app** on a locked-down run asks first too: the app is that code, running on your machine outside any container. The text itself — title, branch name and description — is quoted in a fence it can't break out of, marked as information rather than instructions. Conventions files are read from where the PR started, not from the PR.

To run these jobs on a schedule or from webhooks, see [Automations](automations.md).
