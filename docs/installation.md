# Install Code Flow preview

Open the macOS or Windows WSL2 desktop app, or start the local browser app with one command. You do not need to clone Code Flow or add it to your project. The preview uses your installed coding CLIs and their existing logins.

**Desktop preview 0.1.0-preview.7.** Download a desktop app or use the exact release package below. Each published app release automatically updates the npm `latest` and `preview` channels after npm processing completes. See the [preview release notes and checksums](https://github.com/midhunxavier/code-flow/releases/tag/v0.1.0-preview.7).

## Choose an installation method

<div class="install-picker" data-install-picker>
<div class="install-tabs" role="tablist" aria-label="Installation method">
<button type="button" id="install-tab-unix" role="tab" aria-controls="install-unix" aria-selected="true">macOS / Linux</button>
<button type="button" id="install-tab-windows" role="tab" aria-controls="install-windows" aria-selected="false" tabindex="-1">Windows</button>
<button type="button" id="install-tab-npm" role="tab" aria-controls="install-npm" aria-selected="false" tabindex="-1">npm</button>
<button type="button" id="install-tab-homebrew" role="tab" aria-controls="install-homebrew" aria-selected="false" tabindex="-1">Homebrew</button>
</div>
<section id="install-unix" role="tabpanel" aria-labelledby="install-tab-unix" tabindex="0">
<h3>Try it with one command</h3>
<p>Install Node.js 22.13+ and Git 2.38+, then run:</p>
<pre><code class="language-sh">npx --yes --package=https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.7/midhunxavier-code-flow-0.1.0-preview.7.tgz codeflow</code></pre>
<p>Code Flow starts locally and opens its sign-in link in your default browser. Keep the terminal open while you work. Press <strong>Ctrl+C</strong> to stop the server.</p>
</section>
<section id="install-windows" role="tabpanel" aria-labelledby="install-tab-windows" tabindex="0">
<h3>Windows desktop with WSL2</h3>
<p>The Windows desktop preview runs its backend and agents in your WSL2 distribution. Node is bundled; Git and agent CLIs are installed inside WSL. Docker is not required. Download the <a href="https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.7/code-flow-0.1.0-preview.7-windows-x64-unsigned.zip">x64 ZIP</a> or <a href="https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.7/code-flow-0.1.0-preview.7-windows-arm64-unsigned.zip">ARM64 ZIP</a>, extract the entire ZIP, and open <strong>Code Flow.exe</strong>. See the <a href="windows-desktop.md">Windows desktop guide</a> for setup and validation status. This portable preview is unsigned.</p>
<h3>Use Windows Subsystem for Linux</h3>
<p>This preview runs inside <strong>WSL2</strong>. Install Node.js 22.13+, Git 2.38+ and your agent CLIs inside WSL, sign in there, and keep your repository in the Linux filesystem. In your WSL terminal, run:</p>
<pre><code class="language-sh">npx @midhunxavier/code-flow@preview</code></pre>
<p>The launcher tries to open your Windows browser. If it cannot, copy the local sign-in link from the terminal. Native PowerShell and Command Prompt execution are not supported in this preview.</p>
</section>
<section id="install-npm" role="tabpanel" aria-labelledby="install-tab-npm" tabindex="0">
<h3>Install for regular use</h3>
<p>With Node.js 22.13+ and Git 2.38+ installed on macOS, Linux or inside WSL2:</p>
<pre><code class="language-sh">npm install -g @midhunxavier/code-flow@preview
codeflow</code></pre>
<p>To update, run the same install command again. To remove the launcher:</p>
<pre><code class="language-sh">npm uninstall -g @midhunxavier/code-flow</code></pre>
</section>
<section id="install-homebrew" role="tabpanel" aria-labelledby="install-tab-homebrew" tabindex="0">
<h3>Install with Homebrew</h3>
<p>The preview release includes a Homebrew formula. Once the maintainer has published the <code>midhunxavier/code-flow</code> tap, install it on macOS or Linux:</p>
<pre><code class="language-sh">brew install midhunxavier/code-flow/code-flow
codeflow</code></pre>
<p>Homebrew installs Node and Git as dependencies. Update with <code>brew update &amp;&amp; brew upgrade code-flow</code>. If the tap is unavailable, use npm.</p>
</section>
</div>

## macOS app download

Prefer an app you can open from Applications? Download **0.1.0-preview.7** for your Mac:

- [Download Apple Silicon DMG (M1 or later)](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.7/code-flow-0.1.0-preview.7-macos-arm64-unnotarized.dmg)
- [Download Intel DMG](https://github.com/midhunxavier/code-flow/releases/download/v0.1.0-preview.7/code-flow-0.1.0-preview.7-macos-x64-unnotarized.dmg)

1. Choose **arm64** for Apple Silicon, or **x64** for an Intel Mac. macOS 13 or later is required.
2. Open the DMG and drag **Code Flow** to **Applications**.
3. Open Code Flow in its own desktop window. Closing or reloading the window keeps agents running.
4. Click its Dock icon or use **Code Flow → Show Code Flow** to return. Use **Code Flow → Quit** to stop; it asks before interrupting active agents.

Node is included in the app. You still need Git 2.38+, a signed-in supported agent CLI and Chrome or Edge for the shared browser. Install those before your first run. Quit Code Flow before replacing the app with a newer download. Do not run the npm and macOS launchers together against the same data directory.

Files named **unnotarized** are developer preview builds. macOS may block them. For ordinary installation, use npm until a signed and notarized DMG is available.

## Connect an agent and start

Install at least one supported CLI: `claude`, `codex` or `agy`. Run it interactively and sign in before starting a task. Open **Settings → Agents & models** in Code Flow to inspect availability. Additional ACP agents can be configured in Settings.

Choose a Git repository, describe your task, pick a workflow, and start your first run. Follow the [getting started guide](getting-started.md) for permissions and review.

## Startup options

```sh
codeflow --no-open           # start without opening a browser
codeflow --port 5320         # use another local port
codeflow --version
codeflow --help
codeflow client --help       # authenticated API client
```

If the browser does not open, use the **Open http://localhost:…/?token=…** link printed in the terminal. Keep that link private. A restart creates a new session; use the new link if your browser asks you to sign in.

If another instance is already running, use its browser tab or stop it before starting again. A busy port can be changed with `--port`; an existing server using the same data directory must be stopped first.

## Settings, updates and removal

In desktop versions with the updater, open **Settings → General → App updates** or **Code Flow → Check for Updates…**. The app also checks on launch and every six hours, and shows **Update available** in the sidebar. Preview installs receive newer previews and stable releases; stable installs receive stable releases only.

Click **Download update**, then **Restart to update** when ready. If agents are working, Code Flow asks whether to keep running or save progress and restart. In-app installation requires a signed, notarized app and a release containing the matching update package. Developer previews show **Download installer** instead: download the DMG, quit Code Flow, and replace the app in Applications. Older versions without this button need one manual upgrade first.

Settings and history live in `~/.codeflow`, outside the installation. Reinstalling, upgrading or removing the launcher preserves that folder. Set `CODEFLOW_HOME` to an absolute path to use a separate data directory. Avoid switching an existing data directory back to an older preview; back it up before trying new versions.

The preview does not install or sign in to agent CLIs for you. Provider access and usage limits depend on your account. See [security](security.md), [configuration](configuration.md) and [preview release preparation](releasing.md).

[Documentation library](README.md) · [Getting started](getting-started.md)
