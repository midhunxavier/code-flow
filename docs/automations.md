# Automations and away mode

Set up a run in the composer (task, team, check, settings), then choose **Save as automation…** next to *Start run*. It runs unattended.

Open **Settings → Automations** or press **a** to manage schedules, webhooks, deferred runs and the review inbox. Older `#/automations` links open this same Settings category.

## Projects

An automation's runs start in the [project](runs.md#projects) you were in when you saved it (from *All projects*, in its repository's project). If that project is deleted later, they start in the repository's project. Turning it off and on, or making a new webhook secret, keeps its project.

**Settings → Automations** follows the project you're in (the project button next to its title picks it). It lists that project's automations and the results waiting for you there. When other projects have some too, a line says how many, with **show all** to switch to *All projects*. The count on **Settings** in the sidebar and **Automations** within Settings always counts every project's results, so nothing waiting for you is out of sight.

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

- `details` (or `task`) is added to the task as information for the agents, not instructions: it goes in a fenced block they're told not to take orders from;
- `source` (e.g. `{"kind": "pr", "number": 12}`) starts from that issue or PR, or from a security alert (`{"kind": "alert", "tool": "dependabot", "number": 3}`, or `"tool": "code-scanning"`).

Anyone with the secret can send `details`, and programs on this computer can read the secret in `~/.codeflow/triggers.json`, the agents included. So a run with `details` is marked as carrying untrusted text, like one from a Dependabot PR: its reviews aren't learned as lessons for later runs, and project memory it proposes waits for your approval. Runs from a schedule, **Run now**, or a webhook without `details` are as before.

GitHub webhooks work directly through a tunnel. Use the secret as the webhook secret; code-flow checks `X-Hub-Signature-256`. These events start a run, and all others are ignored:

- an opened issue starts from that issue;
- an opened or updated pull request starts from that PR;
- a failed workflow run starts from its PR, with the failure logs;
- a new or reopened Dependabot alert or code scanning alert starts from that alert.

Leaked-secret alerts never start a run.

code-flow answers `202` at once (GitHub gives up on a delivery after 10 seconds) and starts the run in the background. If it can't start, the reason shows on the automation (*couldn't start: …*). A delivery GitHub sends again is ignored: one with the same `X-GitHub-Delivery` id, or a signed one with the same body whatever its id says, or with none (the signature covers the body, not the id). An automation that isn't a sweep starts at most 10 runs an hour from webhooks.

## The inbox

Automation and sweep results wait on the Automations page (with a count in the sidebar) and under *Needs you* at the top of the sidebar:

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

Check isolation runs the repository's scripts in the selected image. Agents normally use their own CLI sandboxes; explicit [agent container isolation](agent-containers.md) is a separate setting with its own prebuilt image and optional authentication volume. The default check image comes from `image` in [`.codeflow/config.json`](configuration.md#per-repo-config).

## Phone view

Turn on **Enable remote access** in **Settings → Remote access**. Choose **This computer only**, **Tailscale · access anywhere**, or **Wi-Fi · local network**.

- On its own it's a read-only view: what's running and what needs you, and each run's summary, review, results and steps. It refreshes itself and has no buttons.
- Runs are listed under their project's name. Projects with runs that need you come first, then those with runs going; runs in no project come last.
- **Wi-Fi · local network** also serves it, and webhooks, on your network at port `PORT+1`. Configure both `CODEFLOW_TLS_CERT` and `CODEFLOW_TLS_KEY` for HTTPS with a certificate your phone trusts. Without them the listener remains HTTP and full phone control is disabled.
- With network access on, the page shows a **QR code** for the selected connection: scan it with your phone's camera. (The `localhost` link only opens on the computer running code-flow, so there's no QR code until a network link exists.) If another program already has the port, the page says so instead; start code-flow with `CODEFLOW_REMOTE_PORT` set to a free one.
- The network listener refuses connections from the computer itself, whichever of its addresses they use: programs on it, the agents included, can read `~/.codeflow`, phone secrets and all.
- **New link** revokes the old one. So does turning off remote access or choosing **This computer only**: turning it back on gives a new link.

### Remote access with Tailscale

1. Install [Tailscale](https://tailscale.com/download) on the computer running code-flow and your phone, tablet or second computer. Sign in to the same tailnet and connect both devices.
2. Open **Settings → Remote access**, enable remote access and select **Tailscale · access anywhere**.
3. Code-flow detects the local Tailscale client and shows its connection status. If it is missing, signed out, awaiting approval or disconnected, follow the displayed instructions and select **Refresh Tailscale**. Detection also refreshes automatically.
4. Once connected and listening, copy the link or scan the QR code on the other device. The link uses this computer's Tailscale IPv4 address and `CODEFLOW_REMOTE_PORT` (normally 4318). For full control, configure HTTPS with `CODEFLOW_TLS_CERT` and `CODEFLOW_TLS_KEY`, restart Codeflow, then turn on **Full control from remote devices** and use the new pairing link.

The Tailscale mode binds only to the detected Tailscale address, never to the Wi-Fi address or all interfaces. Your tailnet access rules and host firewall must allow the remote port. The default link is HTTP **inside Tailscale's encrypted connection**; it is not a public URL. If you already configured TLS, code-flow retains HTTPS and uses the device's Tailscale DNS name when available; that name must resolve on the other device and match your certificate. Code-flow does not run `tailscale up`, change access rules or enable Serve/Funnel.

The computer must stay awake and online with code-flow running. Disconnecting Tailscale removes the link and closes its listener on the next check (within about ten seconds plus detection time); reconnecting restores it. A changed Tailscale address updates the link and QR code. Switching between Wi-Fi and Tailscale revokes previous links and paired-device sessions. Full control requires HTTPS on either connection. Tailscale encrypts network traffic, but browsers can send HTTP cookies to other services on the same host, so Tailscale alone does not protect full-control sessions.

Use the link on another device: connections from the server computer itself remain blocked to keep local agent processes from pairing. Direct access currently requires a Tailscale IPv4 address and an OS network interface; userspace-only Tailscale is not supported. Browser features that require an HTTPS secure context may be unavailable on the HTTP link. Local app previews still use separate localhost ports and are not published by this setting; this release provides remote access to Codeflow itself.

### Full control from your phone

With HTTPS configured for **Tailscale** or **Wi-Fi**, you can turn on **Full control from remote devices**. The pairing link signs your phone in to the whole app: start runs, answer approvals, message agents, review diffs, merge results and manage automations. `CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1` explicitly permits HTTP for development. Full control requires TLS even over Tailscale, so session cookies can be marked Secure and withheld from other HTTP services on the same host.

- The QR code is a separate sign-in link that expires after ten minutes, including across server restarts. The read-only link never signs a phone in.
- Scanning pairs one device with a separate 30-day session; the server stores only its token hash. The device list can revoke one phone immediately. **New link**, or disabling full control/network access, rotates the pairing generation and signs all devices out. TLS cookies are Secure. Legacy pairing links expire closed after upgrade.
- *Terminal*, *Editor* and *Folder* on a result open on your computer, not the phone. *Run app* starts the app on your computer; its link uses the computer's Wi-Fi address, so it only opens if the app listens on your network too (e.g. `vite --host`).
- Paired devices have owner control and can run commands on the computer. This pairing does not provide separate user identities or project roles.

Automations live in `~/.codeflow/triggers.json` and the phone settings in `~/.codeflow/remote.json`. Both files are readable only by you, and are written whole (through a temporary file), so a crash can't leave half of one. One that can't be read is moved aside to `triggers.json.corrupt-<time>` (or `remote.json.corrupt-<time>`) and logged in `~/.codeflow/server.log`; code-flow then starts without those automations, or with phone access off, rather than write over it. Automations in it that can be read are kept, and one whose schedule can't be read is kept but turned off.
