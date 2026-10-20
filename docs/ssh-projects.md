# SSH projects

Add a connection in Settings → Connections → Work on another computer, connect to the host and select a repository there. The remote workspace has its own execution environment and installed CLIs.

## Open a remote workspace

Open an existing repository on a Linux or macOS server and use the complete code-flow workspace there. File browsing and editing, Git, agent sessions, approvals, terminals, worktrees, setup, builds, verification, and development servers all run on that server. Local and connected remote projects appear together in the sidebar. Click a project to work on its computer; the top bar shows the computer name. Everything stays on the main app address, with remote projects under `/computer/<saved-host-id>/`.

## Connect

1. Install Node.js 22.13 or newer and Git on the server. Install and sign in to the agent CLIs you want to use on that server. Python 3 enables interactive terminals; Chrome/Chromium on the server enables snapshots. The server must allow SSH TCP forwarding to its loopback interface.
2. Configure keys, ports, jump hosts and hostnames in your normal `~/.ssh/config`, for example:

   ```sshconfig
   Host devbox
     HostName server.example.com
     User developer
     IdentityFile ~/.ssh/id_ed25519
     Port 22
   ```

3. Run `ssh devbox` in a terminal once to verify its host key and authentication. Check that `node --version` and `git --version` work in the remote login shell. Unlock passphrase-protected keys in your local SSH agent. Password prompts are not supported in the app.
4. Start code-flow with `npm start`. The normal `npm run build` builds both the UI and portable remote backend. For an existing development server, run `npm run build:host` after code changes.
5. Open **Settings → Connections → Work on another computer** (or **This computer → Manage connections…** in the top bar). Select an alias or enter `user@hostname` and name it. Optionally enter an **SSH port** and an **Identity file** path on your computer, such as `~/.ssh/id_ed25519`. Leave them blank to inherit your SSH config. Choose **Save connection** to keep the definition for later or **Connect and open** to start the remote workspace.
6. The folder picker now browses the server. Choose a Git repository and use the app normally. Agent availability and login status refer to the server.

Connecting installs the application backend, without npm installation or administrator privileges, into `~/.codeflow/ssh-host/releases/<version>` on the server. Its projects, runs, settings and logs live in `~/.codeflow/ssh-host/state`. Local provider credentials, repositories, SSH agents and environment variables are not copied. Credentials and tools must be set up independently on the server.

## Reconnect and stop

The remote backend is detached from SSH. Closing the page, disconnecting, removing a saved connection, or stopping the local app leaves remote work running. Reopen the saved connection to restore projects and runs. Reloading a remote project restores its connection automatically. You can also reopen it from **Settings → Connections → Work on another computer**. Reconnecting does not resubmit actions. After a connection loss during a mutation, inspect the run or files before repeating the action.

Saved connections, including optional ports and key paths, survive local app restarts. Key contents are never stored by code-flow. If opening a newly saved connection fails, it stays in the list so you can retry with **Open** after resolving SSH authentication. Remove and re-add a connection to change its definition. The backend and work survive SSH interruptions, but not a server reboot or an administrator terminating the process. On backend restart, existing code-flow recovery marks interrupted work for explicit resumption. A backend that still has a live PID but fails its authenticated health check is not automatically replaced.

**Disconnect** closes only the SSH channels and preview forwards. **Stop backend** stops an idle backend and is refused while runs, terminals or development services are active. Finish work and close these first. Scheduled work also stops with the backend. On the next connection, the current application build is installed. A running backend is reused during client upgrades so active work is not interrupted; stop it when idle to update it.

## Remote development previews

In the side panel's Browser, enter the development server's `http://localhost:<port>` URL. Code-flow forwards that remote port over SSH and shows it on an isolated local preview origin, including hot reload WebSockets. Remote app cookies are separate from code-flow's session cookies. Arbitrary external browsing and screenshots continue to use the remote backend's existing capabilities. A remote localhost URL copied directly into a separate local browser tab is not automatically forwarded; use the app's Browser preview.

## Connection boundaries

The app uses OpenSSH and your existing config, including ProxyJump. It enforces known host keys, noninteractive authentication, no agent or X11 forwarding, no configured port forwarding, and no local SSH commands. SSH command arguments never include project paths or prompts. Both the local app and remote backend bind only to loopback. Backend authentication cannot be claimed by the first browser, and its private token stays between the local gateway and the remote backend.

All projects use the local app’s owner session and trusted UI. Requests under `/computer/<saved-host-id>/api/` are routed over that computer’s SSH connection; they never fall back to the local backend. Drafts, event streams and popped-out panels are scoped to their computer. Remote API responses are sandboxed and cannot execute scripts on the app origin. Local cookies, bearer tokens and forwarding headers are removed before requests cross SSH; remote response cookies cannot overwrite local sessions. Remote previews retain the existing preview isolation and the remote filesystem-policy gate.

Only the local app owner can manage SSH connections. Shared-account and phone sessions cannot create SSH connections. Up to eight connections can be open and 32 definitions saved. Connections use the remote OS account's authority, so only connect to accounts and servers you trust.

## Troubleshooting

- **Host key or authentication failed:** run the exact alias with `ssh` in a terminal and resolve the error there. The app never accepts unknown fingerprints automatically.
- **Node not found:** put Node.js 22.13+ on the remote login shell's PATH. No Node runtime is downloaded automatically.
- **Connection refused / forwarding prohibited:** check the server's `AllowTcpForwarding`/`PermitOpen` settings and `~/.codeflow/ssh-host/host.log`.
- **Backend still running but unavailable:** inspect the log and process before stopping it. The app avoids restarting a process that might still be doing work.
- **Another host setup is running:** wait for it to finish. If setup crashed, verify no bootstrap process remains before removing `~/.codeflow/ssh-host/bootstrap.lock`.
- **Remote agent unavailable:** install and sign in to its official CLI on the server. The app's health dialog shows that server's tools.

This feature differs from [SSH workers](remote-workers.md): workers transfer individual agent turns and their commits. SSH projects keep the complete project and application backend on the server.

## Validation

`npx tsx --test test/ssh-projects.test.ts` runs the packaged backend in a separate host home using an injected SSH transport. Browser coverage is in `test/e2e/ssh-projects.e2e.ts`. Run `CODEFLOW_TEST_LOOPBACK_SSH=1 npx tsx --test test/ssh-projects-ssh.test.ts` for the real OpenSSH acceptance test. It uses temporary keys, known hosts and an unprivileged loopback SSH daemon, and never edits personal SSH configuration.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
