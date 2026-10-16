# Automations and away mode

Set up a run in the composer (task, team, check, settings), then choose **Save as automation…** next to *Start run*. It runs unattended.

## When it runs

- at a time on chosen weekdays (e.g. weekdays at 07:00), or every *N* minutes (at least 5);
- from a webhook;
- or when you press **Run now** on the **Automations** page.

Times missed while code-flow was closed are skipped, not caught up. If the previous run is still going, the next one is skipped, so automations never pile up.

## Sweeps

A [sweep](github.md#sweeps-many-at-once) saved with *Also check every day at…* is an automation too. Each time it fires it lists the open issues, Dependabot PRs or security alerts again and starts a run for each **new** item that would be picked by default, up to 5 at a time. It remembers which items it already started, so nothing is swept twice. **Run now** does the same on demand.

## Webhooks

`POST /hooks/<id>` with `Authorization: Bearer <secret>` and a JSON body. Both fields are optional:

- `details` is added to the task;
- `source` (e.g. `{"kind": "pr", "number": 12}`) starts from that issue or PR, or from a security alert (`{"kind": "alert", "tool": "dependabot", "number": 3}`, or `"tool": "code-scanning"`).

GitHub webhooks work directly through a tunnel. Use the secret as the webhook secret; code-flow checks `X-Hub-Signature-256`. These events start a run, and all others are ignored:

- an opened issue starts from that issue;
- an opened or updated pull request starts from that PR;
- a failed workflow run starts from its PR, with the failure logs;
- a new or reopened Dependabot alert or code scanning alert starts from that alert.

Leaked-secret alerts never start a run.

## The inbox

Automation and sweep results wait on the Automations page (with a count in the top bar) and under *Needs you*:

- **Approve:** keeps the result. **Approve & open PR** also pushes the branch and opens a pull request. For a run that started from a pull request (a Dependabot PR, say), **Approve & push to PR #N** pushes the fix to that PR instead.
- **Revise:** your note goes to the agent that wrote the code, in its own session. The result comes back to the inbox.
- **Reject:** deletes the run's worktrees and branches.
- Runs that changed nothing are archived on their own, and their branches deleted.
- Automations never pause for plan approval, and **nothing is ever merged automatically**.

## Isolation

Tick *Run checks and setup in a Docker container* and code-flow runs those commands with `docker run`:

- only the worktree is mounted read-write, plus the repo's `.git` read-only, so git works;
- none of your environment variables or your home folder are visible inside;
- the files it creates belong to you.

Agents still run as their own CLIs (they need your subscription logins) inside their own sandboxes. The repo's own scripts are what run in the container. The image comes from `image` in [`.codeflow/config.json`](configuration.md#per-repo-config).

## Phone view

Turn on the *read-only view behind a secret link* on the Automations page.

- It lists what's running and what needs you, and each run's summary, review, results and steps. It refreshes itself.
- It has no buttons: nothing can be started, approved or merged from it.
- *Reachable from my Wi-Fi* also serves it, and webhooks, on your network at port `PORT+1`. It's plain HTTP, so use it only on networks you trust, or over a VPN like Tailscale.
- With *Reachable from my Wi-Fi* on, the page shows a **QR code** for the Wi-Fi link: scan it with your phone's camera. (The `localhost` link only opens on the computer running code-flow, so there's no QR code until the Wi-Fi link exists.)
- **New link** revokes the old one.

Automations live in `~/.codeflow/triggers.json` and the phone view's settings in `~/.codeflow/remote.json`. Both files are readable only by you.
