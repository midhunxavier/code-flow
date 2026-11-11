# Connect services to a project

Open your project’s **Connections** tab, choose its local repository, and connect the services you already use: GitHub for issues and pull requests, Slack or webhooks for project updates. Code Flow suggests GitHub when the repository’s Git remote points there. Coding-agent accounts stay in **Settings → Agents**.

## Connect once, then start work

1. Choose **Connect** on GitHub.
2. Authenticate. GitHub reuses the server computer’s existing `gh auth login`; no new Code Flow provider account is required.
3. Choose the project and local repository.
4. **Test connection**, then **Connect**. Failed authentication does not create a connection.
5. Choose an issue or PR. An issue opens a task draft with the project, repository and source attached. Select agents and send when ready.

**Settings → Integrations** shows the same services across the server. A connection created there can be assigned using **Use in this project**. **Reconnect** tests replacement settings before saving; leave a secret field empty to keep the saved value. **Disconnect** first names the affected projects and asks for confirmation. Confirming deletes the saved connection and its credential, removes every project association, and cancels pending deliveries for a notification destination. It does not sign out the GitHub CLI or revoke a token at the provider. **Remove from project** keeps the connection for other projects. Failed connection tests show beside the affected account; **Retry** repeats that test.

## Supported actions

| Service | Issues | PR reviews | CI diagnosis | Publishing |
| --- | --- | --- | --- | --- |
| GitHub | Yes | Yes | Failed-check logs | Explicit verified-result actions |

GitHub’s PR preview shows checks and offers **Fix failing checks** when a check has failed. Review and CI actions prepare a task draft; they do not automatically send it. Imported source descriptions remain untrusted data.

**Create pull request from completed work** shows passing results in the selected project and repository. Choosing a result does not publish it. **Review result and create PR** opens that exact branch in Review with the PR controls visible and focused. Refreshing the page returns to the ordinary review view; **Push & open PR** remains a separate action. The existing review/publish workflow validates the exact result and requires a separate explicit action before a push, PR creation, comment or merge. Provider permissions and policy can still refuse an action. See [GitHub workflows](github.md).

## Project updates

Connect **Slack** with an incoming webhook URL, or **Webhooks** with an HTTPS destination and optional bearer token. Setup validates the URL without sending a message. Use **Send test notification** to verify delivery explicitly.

Automatic notifications start off. Select the projects and events—completed, failed or needs attention—and save before enabling delivery. The current project is preselected when setting up a new destination from its Connections tab. Delivery history and retries are in the same screen and in **Settings → Notifications**. See [notifications](notifications.md) for payload and delivery behavior.

Native Microsoft Teams and external MCP/documentation connections are separate future work.

## Credentials and existing server configuration

Only the server owner manages these connections; shared project members cannot read or change the owner’s integration credentials. Webhook URLs and tokens are held by server-side secret references, not agent environments or browser storage. App-managed connection state is encrypted with AES-256-GCM in `CODEFLOW_HOME/integration-secrets`, with a private directory and private key/data files. The server user can decrypt its own credentials; this does not protect against a compromised server account. Keep the matching key and data together if migrating the server. Normal application backups exclude both files. Damaged or missing keys fail closed and preserve the original data. Connections saved by earlier versions for services that are no longer offered stay in that file, unused and hidden.

Existing `CODEFLOW_NOTIFICATIONS_FILE` / `CODEFLOW_NOTIFICATIONS_JSON` destinations keep working and appear as **Administrator-managed**. They can be tested and associated with projects. Change or remove them in the server configuration and restart; the browser does not overwrite them. App-managed connections need no restart. Invalid administrator JSON/file configuration shows a warning while healthy app-managed connections remain available. Damaged notification delivery storage disables notification setup and delivery without hiding GitHub connections; the original file is preserved for repair. Custom filesystem policies block owner integration management.

Automated coverage uses a fake `gh`, controlled notification transports, fake agent CLIs and real temporary Git repositories. It checks guided setup, authentication errors, reconnect/disconnect, encrypted storage, project imports, reviews and explicit publication, notifications, permissions and redaction. These fixtures do not establish live provider account compatibility; live smoke tests must be reported separately.

---

[Documentation library](README.md) · [GitHub workflows](github.md)
