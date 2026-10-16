# GitHub, review and shipping

## Review and ship

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

### Issues and pull requests

**GitHub** in the task box starts from any open issue or PR:

- An **issue's** title and description go to every agent with the task.
- A **PR's** branch is fetched (`pull/N/head`, so forks work too) and becomes the run's base. Its description goes to the agents, and its changes are compared against the PR's target branch.
- When a run came from a PR, a result has **Push to PR #N**. It pushes to the PR's branch and is never forced, so it fails if someone else pushed in the meantime. You can't push to a PR from a fork; you can still review it.

### Review council

A read-only pattern: several agents review the same changes independently, and a chair merges their findings.

- Reviewers are anonymous to the chair ("Reviewer A/B"), and findings several reviewers agree on rank first.
- Nothing is changed. **Post to PR #N** posts the review as a comment, and only when you click it.

### Follow-through

**Watch PR** works on a result that has a PR. code-flow checks it every minute:

- **Failing CI:** the failed jobs' logs go to the agent you picked, which fixes the cause. code-flow commits and pushes to the PR.
- **New comments** from you (the account `gh` is signed in as), or from people you list under *Also act on comments from*, go to the agent in the same way. Nobody reviews these fixes before they're pushed, so anyone else's comments are logged and ignored, even an org member's. Comments that were there before you started watching are never acted on.
- These unattended fixes never run with more than *standard* permissions, and a fix that changes tests in ways that could hide the failure isn't pushed. It's handed back to you instead.
- **Stops:** after the number of fixes you allow, if someone else pushed to the PR, or when the PR is merged or closed. It then shows under *Needs you* with a notification.
- It **never merges**.

### Untrusted text

Text from outside the repo is untrusted. Issue and PR descriptions, comments and CI logs can carry instructions aimed at the agents. code-flow asks GitHub who wrote an issue or PR. Unless it's the repo's owner, a member or a collaborator, and not a fork, the run is locked down (🔒 in the run view):

- agents run in Safe mode;
- files like `.env` aren't copied in;
- checks run in Docker without network.

Without Docker, code-flow asks before running that person's tests on your machine; automations never do. The text itself is quoted in a fence it can't break out of, marked as information rather than instructions. Conventions files are read from where the PR started, not from the PR.

To run these jobs on a schedule or from webhooks, see [Automations](automations.md).
