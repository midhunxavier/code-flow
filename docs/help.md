# Ask code-flow

Get help with setup, workflows and troubleshooting from the documentation, using a coding CLI already installed on your machine. The assistant is available in the local app's documentation.

## Open the assistant

1. Start Code Flow and open the owner app using the link printed in the terminal.
2. Choose **Application menu → Help & documentation**, or search for it in the command palette.
3. Select **Ask code-flow** and choose an installed CLI.
4. Ask a question such as “Which workflow should I use to fix a failing test?”
5. Read the answer and open the source guides for the full details.

The assistant supports **Claude Code, Codex and Antigravity**. It uses the provider's existing CLI authentication. Model and effort preferences saved in the local app's **Settings → Agents & models** are forwarded; when unset, the CLI's defaults apply. ACP and extension providers are not offered in this help flow. ACP currently requires Full access for normal runs.

## What it receives

Each question includes excerpts from up to five relevant bundled guides, the page you are viewing as a retrieval hint, and up to three earlier question/answer pairs from the open dialog. Questions are limited to 4,000 characters; answers to 12,000. Source excerpts are capped at 10,000 characters each. Engineering records are excluded from answer retrieval so historical decisions do not substitute for current instructions.

The conversation stays in this browser tab's memory and clears when you navigate or reload. Code Flow does not add it to run history or project memory. The selected provider processes the prompt under its own account and logging behavior. Requests consume the same CLI usage allowance as other invocations.

## Execution boundaries

Help runs with read-only, Safe adapter settings in a fresh temporary Git directory. No selected repository, run transcript, attachment, secret file or project configuration is copied into it. The prompt instructs the assistant to answer from the supplied text without tools; this instruction is not an additional OS sandbox. Provider-level settings, integrations and hooks remain subject to the normal CLI trust boundary described in [Security](security.md).

Help does not expose merge, terminal, configuration or publishing actions. Source links are chosen by the server from the retrieved guides. Answers are displayed as text, not executed as HTML. Treat generated answers as guidance and check the sources before running suggested commands.

Help currently supports macOS and Linux, with absolute, nonempty PATH entries. Only an authenticated owner on the main application listener can use help. Shared-project accounts, runner credentials and the phone listener cannot invoke it. Filesystem restrictions pause help as they do other host CLI execution. Two simultaneous help requests are allowed, with a two-minute limit per turn. **Stop**, closing the dialog or leaving the page cancels the request; the disposable directory is removed after the adapter exits.

## Troubleshooting

| What you see | Next step |
| --- | --- |
| No supported CLI found | Install a supported CLI on the application host and sign in through its terminal command. |
| Not signed in | Open the owner app using its current terminal link, then reopen the docs. |
| Provider signed out | Sign in through that provider's CLI and retry. |
| Usage limit reached | Choose another installed provider or wait for your plan's limit to reset. |
| CLI took too long | Ask a smaller question, or check the CLI directly in a terminal. |
| Documentation unavailable | Run `npm run build:docs` from the Code Flow checkout. |
| Filesystem restrictions pause execution | Read the guides directly; review policy in the main app if execution is needed. |

## Hosted documentation

GitHub Pages serves the same searchable guides. It cannot launch your local CLIs. Its **Ask code-flow** dialog explains how to open the assistant from the local app; it does not connect to localhost or request credentials.

[Documentation library](README.md) · [Getting started](getting-started.md) · [Security](security.md)
