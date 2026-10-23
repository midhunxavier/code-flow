# Windows desktop with WSL2

The Windows desktop preview opens Code Flow in an Electron window and runs the backend
and coding agents in your WSL2 Linux distribution. **Docker Desktop is not required.**
Node.js and npm are bundled. Git and agent CLIs must be installed and signed in inside
WSL; no separate Windows installations of those tools are needed. Existing WSL CLI
logins are reused.

This is an **unsigned portable preview**. CI builds x64 and ARM64 packages on Windows
and tests the Windows-produced x64 Linux payload on Ubuntu. Physical Windows startup,
WSL localhost forwarding and real provider authentication still require acceptance testing.

## Download the preview

- [Windows x64 ZIP](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.5/code-flow-0.1.0-preview.5-windows-x64-unsigned.zip)
- [Windows ARM64 ZIP](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.5/code-flow-0.1.0-preview.5-windows-arm64-unsigned.zip)
- [Release notes and SHA-256 checksums](https://github.com/midhunxavier/code-flow/releases/tag/v0.1.0-preview.5)

Extract the entire ZIP before opening **Code Flow.exe**. Set up WSL2 as described below.

## Build the app

With Node.js 22.13+ installed in the source checkout:

```sh
npm ci
npm run package:windows -- x64
```

Use `arm64` for Windows ARM. The ZIP and SHA-256 checksum are written to `output/releases/`.
Packaging works on Windows, macOS and Linux; macOS and Linux also need `zip`.
The package includes the official Node.js Linux archive with a pinned SHA-256 checksum.
The first launch copies the backend and Node into the Linux filesystem; it does not
install packages or download executable code at startup.

## Set up WSL2

In PowerShell, install WSL if needed:

```powershell
wsl --install
```

Restart if prompted, open Ubuntu, and complete Linux username and password setup.
Check the distribution version and default selection:

```powershell
wsl --list --verbose
wsl --set-default Ubuntu
```

Use an initialized Ubuntu or Debian distribution running **version 2**. Code Flow uses
the default distribution, or the distribution named by `CODEFLOW_WSL_DISTRO` in its
launch environment. It checks WSL2 and the Linux architecture before starting.
See Microsoft's [WSL installation guide](https://learn.microsoft.com/windows/wsl/install).

## First launch and agent setup

1. Extract the **entire ZIP** and open **Code Flow.exe**. Windows may show an
   unknown-publisher prompt because the preview is unsigned.
2. Wait for the bundled runtime to be copied into WSL. Later launches reuse that version.
3. Open **Code Flow → Set up agents…** and paste the copied command into **PowerShell**.
   It opens a terminal in the selected distribution with the bundled Node and npm on PATH.
4. If needed, install Git, Python and supported CLIs in that terminal:

   ```sh
   sudo apt-get update
   sudo apt-get install -y git python3
   npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@2.1.302 @openai/codex@0.162.1
   claude auth login
   codex login --device-auth
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

   Existing installations and logins can be used. Open any printed login URL in your
   Windows browser and follow the vendor's flow. The app delegates authentication to
   those CLIs and does not copy credentials between Windows and Linux.
5. Choose a repository in the app using its **Linux path**, such as `/home/you/projects/demo`.
   Windows drives can also be accessed through WSL paths such as `/mnt/c/Projects/demo`.
   Prefer repositories in the Linux filesystem for Git, dependency and build performance.

Repositories, checks, shells and agents all run in the selected WSL distribution. Install
project dependencies there; Windows `node_modules` and other native build output may
need to be rebuilt for Linux. Additional language tools and private Git authentication
are managed through the distribution's normal tools.

## Closing, updating and storage

Closing the window keeps agents running. Reopen it from the notification-area icon or
launch the app again. **Code Flow → Quit** saves progress and stops this app's backend.
If agents are working, the app asks before quitting. It does not shut down the WSL
virtual machine or terminate the distribution, so other WSL programs keep running.

Settings and history live in `~/.codeflow-desktop/<installation-id>/state` inside WSL.
CLI logins stay in their usual Linux locations, such as `~/.claude` and `~/.codex`.
The installation ID derives from the Windows desktop preferences directory and stays
stable when the portable app is replaced. Changing distributions uses that distribution's
separate filesystem and logins; it does not migrate history between distributions.

Versioned application runtimes live under
`~/.local/share/code-flow/desktop/<installation-id>/versions/`. A new bundle installs a
new version and preserves application state. Removing the Windows ZIP does not delete
Linux history, CLI logins or cached runtimes. Back up state before deleting it.

After an interrupted session, the launcher checks its own saved Linux process record
and command line before stopping an old backend. Stale PID records cannot authorize
termination of unrelated Linux processes. Updates open the matching Windows ZIP; quit,
extract the new copy, and launch it. Automatic installer replacement is disabled for
this unsigned preview.

## Runtime boundaries and validation

The backend uses a loopback listener. Windows reaches it through
[WSL localhost forwarding](https://learn.microsoft.com/windows/wsl/networking).
No LAN listener or firewall exception is added. The owner token is passed through a
private stdin pipe and redacted from backend output; it is not placed in process arguments.

The backend and agents have the filesystem and network permissions of your WSL user,
including Windows drives exposed by WSL. WSL does not replace the app's agent permission
and approval rules. Native Windows desktop computer tools are unavailable. Shared browser
features require a compatible browser installed inside the Linux distribution.

The Windows desktop workflow builds both packages, verifies executable and archive
contents and checksums, then extracts the x64 artifact on Ubuntu. `npm run test:desktop:wsl`
checks the actual bundled Node and bootstrap, UI assets, semantic analysis, a deterministic
fixture agent run, history recovery, log redaction and shutdown. It never signs in or calls
a provider. Windows unit tests cover WSL2 detection, architecture checks, command arguments
and the private control channel. The hosted Ubuntu test exercises the Linux payload;
it does not emulate WSL networking or prove a real Windows login flow.

[Documentation library](README.md) · [Installation](installation.md)
