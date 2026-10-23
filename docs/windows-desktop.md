# Windows desktop with Docker

The Windows desktop preview opens Code Flow in an Electron window and runs its backend,
Git and coding agents in a Linux container managed by Docker Desktop. You do not need
Node.js or agent CLIs installed on Windows to run the packaged app. Docker Desktop must
be installed, running and using **Linux containers**. Its default backend uses WSL2;
you do not need to manage a separate WSL distribution for Code Flow.

This is an **unsigned portable preview**, built from source or downloaded as a Windows
workflow artifact. It has not yet been validated on a physical Windows machine.

## Build the app

With Node.js 22.13+ installed in the source checkout:

```sh
npm ci
npm run package:windows -- x64
```

The ZIP and its SHA-256 checksum are written to `output/releases/`. Use `arm64` instead
of `x64` for a Windows ARM package. Packaging works on Windows, macOS and Linux; running
the resulting `.exe` requires Windows. macOS and Linux packaging also require `zip`.
Run `npm run desktop:docker` to try the same Docker
backend in a desktop window on your development machine.

## First launch

1. Install and start [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/).
   Use its local Linux-container context.
2. Extract the **entire ZIP** and open **Code Flow.exe**. Windows may show an
   unknown-publisher prompt because this preview is unsigned.
3. Choose a folder containing your projects. Inside Code Flow, that folder appears as
   **`/workspace`**. For example, `C:\Projects\demo` appears as `/workspace/demo` when you
   select `C:\Projects`. Select only the folder you intend the app and its agents to use.
4. Wait for the first launch to build the bundled runtime. It downloads the pinned Node,
   Claude Code and Codex versions, requires internet access, and can take several minutes.
   Subsequent launches reuse the local image. A changed runtime builds a new image.
5. Open **Code Flow → Set up agents…** and copy the terminal command into PowerShell.
   It opens Bash inside this app's container. Sign in using each vendor's own CLI flow:

   ```sh
   claude auth login
   codex login --device-auth
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

   Open any printed login URL in your Windows browser. Use the vendor's manual-code or
   device flow when prompted; a callback to an unpublished container port will not reach
   the CLI. Provider login flows and real inference still require Windows acceptance testing.
6. Add `/workspace/your-repository` in Code Flow and start a run. Agent tools execute on
   Linux, so install your project's Linux dependencies inside the container. Windows
   `node_modules` and other platform-specific build output may need to be rebuilt.

The runtime includes Bash, Git, SSH, Python 3, ripgrep, Node.js, Claude Code and Codex.
Install additional Linux tools in a derived image for repeatable use. Executables placed
in `~/.local/bin` persist in the home volume and are on the runtime's PATH. Host-installed
CLIs, SSH keys and Git credential helpers are not shared automatically. Configure private
repository access inside the container using your normal Git authentication flow.

## Closing, updating and storage

Closing the window keeps agents running. Reopen it from the notification-area icon or
launch the app again. **Code Flow → Quit** saves progress and stops the app's container.
If agents are working, the app asks before quitting. Reopening after an interrupted session
removes only the previous container labeled for this desktop installation and reuses its
saved data. Other Docker containers remain running.

The selected folder is a writable bind mount at `/workspace`. Your Git repositories keep
their host files; Code Flow worktrees and history live in the container's persistent home.
Linked Git worktrees created outside the chosen folder may reference unavailable host
paths. Use a regular clone in the chosen folder. The container trusts Git ownership for
its mounted repositories; Windows bind mounts do not preserve Linux UID ownership.

Settings, conversations, CLI logins and Git configuration live in the named volume
`codeflow-desktop-home-<installation-id>-<folder-id>` under `/home/node`. Its IDs derive
from the desktop preferences directory and selected folder, so replacing the app preserves the same volume.
Uninstalling the portable app does not delete it. Back up this volume before deleting it
or resetting Docker Desktop. Image updates preserve this home volume, but tools installed
only in the container's writable layer are discarded when the container stops.

Use **Choose projects folder…**, then quit and reopen the app, to change the mounted folder.
Each selected folder has its own home volume, settings and logins. Returning to a previous
folder restores its saved data. This prevents saved `/workspace` paths from referring to
different repositories after a folder change.
Update checks open the matching Windows ZIP; quit, extract the new copy, and launch it.
Automatic installer replacement is not enabled for this unsigned preview.

## Runtime boundaries

Only the selected folder and the app's named home volume are mounted. The backend port
is published on `127.0.0.1` and uses the app's owner token. The Docker client receives the
token through its environment; it is not placed in command arguments or container logs.
The runtime uses a non-root Linux user with Linux capabilities dropped and privilege
escalation disabled. It has outbound network access for Git, package installs and providers.

The Docker socket and host home are not mounted. Nested Docker execution, additional
agent-container isolation, the shared Chrome browser and native desktop computer tools
are unavailable in this initial runtime. Antigravity is not bundled. The normal Linux
team-tool bridges remain available because the backend and agents share the same container.
This container is a boundary around the application; it does not grant each agent a
separate container. Existing per-agent permission and approval rules still apply.

`npm run test:desktop:docker` builds the real runtime, checks the bundled CLI versions and
exercises a deterministic fixture run, history persistence, log redaction, crash recovery
and shutdown against a real Docker daemon. It never authenticates or calls a provider.
CI builds the Windows ZIP separately on a Windows runner. Real Windows startup, Docker
file sharing, provider login and inference remain a release acceptance gate.

[Documentation library](README.md) · [Installation](installation.md)
