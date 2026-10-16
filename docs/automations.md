# Automations and away mode

Set up a run in the composer (task, team, check, settings), then choose **Save as automation…** next to *Start run*. It runs unattended.

## When it runs

- at a time on chosen weekdays (e.g. weekdays at 07:00), or every *N* minutes (at least 5);
- from a webhook;
- or when you press **Run now** on the **Automations** page.

The next time is saved, so restarting code-flow doesn't move it. A time missed while code-flow was closed or the computer asleep fires once when code-flow is back, if it's at most an hour late and today is still one of the schedule's days; otherwise it's skipped and the schedule moves on to its next time. A schedule never fires on a day you left out.

If the previous run is still going (or still starting), a scheduled run or **Run now** is skipped, so automations never pile up. A webhook event that arrives meanwhile waits instead, and fires once that run ends; the same event sent twice waits once.

## Sweeps

A [sweep](github.md#sweeps-many-at-once) saved with *Also check every day at…* is an automation too. Each time it fires it lists the open issues, Dependabot PRs or security alerts again and starts a run for each **new** item that would be picked by default, up to 5 at a time. It remembers which items it already started, so nothing is swept twice; alerts are remembered by number, so a new alert on a package that was swept before is new work. **Run now** does the same on demand.

A webhook that reaches a sweep names one item, and goes through the same rules:

- it has to be the sweep's kind: an issue for *Fix open issues*, a pull request for *Fix Dependabot PRs*, an alert for *Fix security alerts*;
- the sweep's list has to pick it: not labelled *question* or *wontfix*, not a Dependabot PR whose CI passes (or is still running), not a low-severity alert or one with no fix yet, not one that already has a run;
- webhooks start at most the sweep's limit of runs (5 by default) per hour, so someone opening fifty issues doesn't start fifty runs.

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

code-flow answers `202` at once (GitHub gives up on a delivery after 10 seconds) and starts the run in the background. If it can't start, the reason shows on the automation (*couldn't start: …*). A delivery GitHub sends again, with the same `X-GitHub-Delivery` id, is ignored. An automation that isn't a sweep starts at most 10 runs an hour from webhooks.

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

Turn on the *Phone link* under **Phone** on the Automations page.

- On its own it's a read-only view: what's running and what needs you, and each run's summary, review, results and steps. It refreshes itself and has no buttons.
- *Reachable from my Wi-Fi* also serves it, and webhooks, on your network at port `PORT+1`. It's plain HTTP, so use it only on networks you trust, or over a VPN like Tailscale.
- With *Reachable from my Wi-Fi* on, the page shows a **QR code** for the Wi-Fi link: scan it with your phone's camera. (The `localhost` link only opens on the computer running code-flow, so there's no QR code until the Wi-Fi link exists.) If another program already has the port, the page says so instead; start code-flow with `CODEFLOW_REMOTE_PORT` set to a free one.
- The network listener refuses connections from the computer itself, whichever of its addresses they use: programs on it, the agents included, can read `~/.codeflow`, phone secrets and all.
- **New link** revokes the old one. So does turning off *Phone link* or *Reachable from my Wi-Fi*: turning it back on gives a new link.

### Full control from your phone

With *Reachable from my Wi-Fi* on, you can also turn on *Full control from my phone*. Then the Wi-Fi link signs your phone in to the whole app, laid out for a phone: start runs (pick the repo, attach files, start from GitHub), answer plan approvals, message agents, review diffs and send comments, merge, open PRs, triage the inbox, and change automations.

- The QR code is then a sign-in link with a secret of its own. The read-only link never signs a phone in, so someone who saw it can't get full control with it.
- Scanning the QR code sets a cookie for that address and opens code-flow. The phone stays signed in for up to 30 days, across restarts too, until you make a **New link** or turn off full control, *Reachable from my Wi-Fi* or the phone link. Each of those signs every phone out and closes their open connections, and turning it back on doesn't sign them back in.
- *Terminal*, *Editor* and *Folder* on a result open on your computer, not the phone. *Run app* starts the app on your computer; its link uses the computer's Wi-Fi address, so it only opens if the app listens on your network too (e.g. `vite --host`).
- Anyone who gets the link can run agents and commands on your computer, the same as you can. Keep it to your own phone, and to networks you trust or a VPN. The link isn't encrypted on plain HTTP.

Automations live in `~/.codeflow/triggers.json` and the phone settings in `~/.codeflow/remote.json`. Both files are readable only by you, and are written whole (through a temporary file), so a crash can't leave half of one. One that can't be read is moved aside to `triggers.json.corrupt-<time>` (or `remote.json.corrupt-<time>`) and logged in `~/.codeflow/server.log`; code-flow then starts without those automations, or with phone access off, rather than write over it. Automations in it that can be read are kept, and one whose schedule can't be read is kept but turned off.
