<p align="center">
  <img src="ui/brand/code-flow-mark.svg" alt="" width="64" height="64">
</p>
<h1 align="center">code-flow</h1>
<p align="center"><b>Turn Claude Code, Codex and Antigravity into an AI team.</b></p>
<p align="center">
  Describe a goal. code-flow builds the team and the workflow, runs it on your machine<br>
  with the CLIs you already use, and shows you the evidence before anything ships.
</p>
<p align="center">
  <a href="#install">Install</a> ·
  <a href="#use-it-from-your-cli">Use it from your CLI</a> ·
  <a href="https://midhunxavier.com/code-flow/docs/">Docs</a> ·
  <a href="docs/security.md">Security</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/run-dark.png">
  <img src="docs/images/run-light.png" alt="A code-flow task showing agent activity, verification evidence and review actions, captured with demo agents." width="100%">
</picture>

> **Preview.** code-flow is early software. Expect rough edges and breaking changes.

## Why code-flow

- **No team setup.** You say what you want. A lead agent proposes who does what, in what order, with which checks. You approve, then it runs.
- **Mix providers.** One agent writes with Claude, another reviews with Codex. Pick models and effort per agent, or let the lead choose.
- **Your subscriptions, your machine.** It drives the `claude`, `codex` and `agy` CLIs you've already signed in to. It never reads or reuses your tokens.
- **Safe by default.** Agents work in separate Git worktrees. Nothing touches your checkout until you apply it.
- **Proof, not promises.** Checks, independent reviews and test evidence are shown separately, so "finished" never quietly means "verified".

## Install

You need **Node.js 22.13+**, **Git 2.38+**, and at least one of `claude`, `codex` or `agy`, installed and signed in. Runs on macOS, Linux, and Windows through WSL2.

```bash
npm install -g https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.14/midhunxavier-code-flow-0.1.0-preview.14.tgz
codeflow
```

This opens code-flow in your browser at [localhost:4317](http://localhost:4317). Keep the terminal open; press **Ctrl+C** to stop.

<details>
<summary>Desktop apps for macOS and Windows</summary>

- **macOS 13+:** [Apple Silicon DMG](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.14/code-flow-0.1.0-preview.14-macos-arm64-unnotarized.dmg) · [Intel DMG](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.14/code-flow-0.1.0-preview.14-macos-x64-unnotarized.dmg). Drag **Code Flow** to Applications. These builds are unnotarized, so macOS may block them. If it does, use npm.
- **Windows (WSL2):** [x64 ZIP](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.14/code-flow-0.1.0-preview.14-windows-x64-unsigned.zip) · [ARM64 ZIP](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.14/code-flow-0.1.0-preview.14-windows-arm64-unsigned.zip). Extract it and open **Code Flow.exe**. Git and your agent CLIs live inside WSL. See the [Windows guide](docs/windows-desktop.md).

[Release notes and checksums](https://github.com/midhunxavier/code-flow/releases/tag/v0.1.0-preview.14) · [Full installation guide](docs/getting-started.md)

</details>

## Use it in the browser

1. Click **New chat** and pick a project folder.
2. Choose **Team**, then describe your goal:
   > Add a password reset flow. Use Claude to build it and Codex to review it. Run the tests.
3. Review the proposed team: agents, models, task order, checks and limits. Click **Start implementation** (or **Start planning** / **Start review** for plan-only or review-only work).
4. Follow progress in the chat. When it's done, inspect the diff and the evidence, then apply the changes or open a pull request.

Want a single agent instead? Keep **Agent** selected and chat as usual. You can switch to Team at any point in the same conversation. → [Chat guide](docs/conversational-tasks.md) · [How Team mode works](docs/auto-team.md)

## Use it from your CLI

Prefer to stay in Claude Code, Codex or Antigravity? Connect code-flow once:

```bash
codeflow init
codeflow doctor
```

Then start your CLI inside any Git repository and ask for a team:

| CLI | Invoke |
| --- | --- |
| Claude Code | `/codeflow` |
| Codex | `$codeflow` |
| Antigravity (`agy`) | `/codeflow` |

> /codeflow Fix the empty-email validation bug, run the focused tests, and have another agent review the change.

Your CLI shows the proposed team and asks you to approve it. If it can't show an approval form, you get a link or a `codeflow approve` command instead. Progress and results come back to the same conversation. → [CLI guide](docs/cli-conversational-teams.md)

`codeflow init` only touches your user settings. It never writes into your repositories. Remove it any time with `codeflow uninstall --user`.

### Claude Desktop and the Codex app

Run this inside the repository you want to work on (macOS):

```bash
codeflow desktop setup
```

Reopen Claude Desktop, or enable the new `codeflow-…` server in the Codex app's MCP settings and open a fresh chat. Then ask: *"Use Code Flow to have Claude plan a login form and Codex review it. Plan only."* → [Desktop guide](docs/desktop-mcp.md)

## Supported agents

| Provider | Runs as | Sign-in |
| --- | --- | --- |
| Claude Code | `claude -p` | Claude Code's own login |
| Codex | `codex app-server` / `codex exec` | `codex login` |
| Antigravity | `agy -p` (sandboxed by default) | agy's own login |
| Any ACP agent | Your saved command | That CLI's login |

Models, limits and usage come from your own accounts. Repository checks run real code on your machine, so read the [security notes](docs/security.md) before pointing it at code you don't trust.

## Learn more

- [Getting started](docs/getting-started.md): install, first chat, first team
- [Team mode](docs/auto-team.md): how the lead plans, assigns and verifies work
- [Runs and the workspace](docs/runs.md): files, diffs, terminals and previews
- [Automations](docs/automations.md): scheduled work and remote access
- [Team collaboration](docs/team-collaboration.md) and [SSH projects](docs/ssh-projects.md)
- [Full documentation](docs/README.md): also built into the app under **Help & documentation**

## Development

```bash
git clone https://github.com/midhunxavier/code-flow.git
cd code-flow
npm ci
npm run dev        # demo agents at localhost:4318, no real provider calls
npm run dev:real   # your real, signed-in CLIs
npm run typecheck
npm test
npm run test:e2e   # browser tests, requires Chrome
```

See the [development guide](docs/architecture.md) for the source layout and contracts.

## License

[MIT](LICENSE). Bundled Inter fonts use the [SIL Open Font License 1.1](ui/fonts/OFL-1.1.txt).
