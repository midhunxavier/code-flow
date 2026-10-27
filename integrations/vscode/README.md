# Code Flow for VS Code

Use the local VS Code integration to create tasks and inspect Code Flow results without leaving your editor. The Code Flow server must be running and authenticated before the extension can connect.

Connect a local VS Code window to a running Code Flow server. Start a Safe solo task
from the current saved file and selected text, inspect recent run states, open the
full review in Code Flow, stop a running task, or open a result worktree in a new window.

1. Start Code Flow and read its local URL and token from the server startup output.
2. Install the locally built VSIX through **Extensions → Install from VSIX**.
3. Run **Code Flow: Connect to Local Server**, enter the loopback URL and token.
4. Open a trusted local Git folder, then run **Code Flow: Start Task from Editor**.

Tokens use [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage).
They are not put in workspace settings, URLs or logs. Use **Forget Server Token**
to remove a connection. Server URL configuration is application-wide so a repository
cannot silently redirect the extension to another service. The client refuses
redirects, non-loopback endpoints, unsupported API versions and oversized responses.
An SSH tunnel can expose another Code Flow instance as a local endpoint when its
forwarded port matches the server's Host validation.

Task creation requires workspace trust and local `file:` folders. Remote VS Code
workspaces and virtual files are unsupported in this first integration. The task
uses detected verification, Auto provider selection, bounded execution, no copied
ignored files and interactive tool approval requests. Current-file context excludes
credential filenames and paths outside the selected folder. Unsaved files require
an explicit save before dispatch. Review code and verification in Code Flow before
shipping a result.

The Explorer view shows the recent 100 server runs, filtered to local workspace
folders, and refreshes every ten seconds while visible. It displays verification
and approval state but does not approve permissions from the editor. Open the full
run for those decisions. Stopping a task asks for confirmation. Creating a task can
consume the configured provider's quota; the extension never starts one on activation.

Forgetting the server token immediately updates the view to disconnected. Start Task checks the connection before asking for task text; if submission later fails, the Code Flow output channel keeps that text for retry.

From the Code Flow repository:

```sh
python3 scripts/package-vscode.py
node scripts/test-vscode.mjs
```

The package is written to `output/vscode/`. Packaging uses Python 3's standard
library. Host acceptance uses an installed `code` executable (or
`CODEFLOW_VSCODE_BIN`), an isolated temporary profile and extension directory, and a
real Code Flow server with fake agents. It packages and installs the VSIX first,
then exercises that installed artifact's activation, command registration, token
storage, task execution, refresh, token deletion and delayed connection responses.
See [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
No marketplace publishing or changes to the user's installed extensions are performed.

[Documentation library](../../docs/README.md) · [API and CLI](../../docs/api.md) · [Getting started](../../docs/getting-started.md)
