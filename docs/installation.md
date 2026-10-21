# Install Code Flow preview

Start Code Flow with one command, then work in your browser. You do not need to clone Code Flow or add it to your project. The preview uses your installed coding CLIs and their existing logins.

**Preview availability:** the commands below target the `preview` npm channel and preview downloads. They become available when the maintainer publishes the release. If a channel is not published yet, use the [source installation](getting-started.md#install-from-source) or the exact tarball command in the [preview release notes](https://github.com/midhunxavier/code-flow/releases).

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
<pre><code class="language-sh">npx @midhunxavier/code-flow@preview</code></pre>
<p>Code Flow starts locally and opens its sign-in link in your default browser. Keep the terminal open while you work. Press <strong>Ctrl+C</strong> to stop the server.</p>
</section>
<section id="install-windows" role="tabpanel" aria-labelledby="install-tab-windows" tabindex="0">
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

Prefer an app you can open from Applications? Choose a DMG from the [preview downloads](https://github.com/midhunxavier/code-flow/releases).

1. Choose **arm64** for Apple Silicon, or **x64** for an Intel Mac. macOS 13 or later is required.
2. Open the DMG and drag **Code Flow** to **Applications**.
3. Open Code Flow. Its menu bar launcher starts the local app and opens your browser.
4. Use **Code Flow → Open Code Flow** to reopen the browser, or **Quit Code Flow** to stop it.

Node is included in the app. You still need Git 2.38+ and a signed-in supported agent CLI. Install those before your first run. Quit Code Flow before replacing the app with a newer download. Do not run the npm and macOS launchers together against the same data directory.

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

Settings and history live in `~/.codeflow`, outside the installation. Reinstalling, upgrading or removing the launcher preserves that folder. Set `CODEFLOW_HOME` to an absolute path to use a separate data directory. Avoid switching an existing data directory back to an older preview; back it up before trying new versions.

The preview does not install or sign in to agent CLIs for you. Provider access and usage limits depend on your account. See [security](security.md), [configuration](configuration.md) and [preview release preparation](releasing.md).

[Documentation library](README.md) · [Getting started](getting-started.md)
