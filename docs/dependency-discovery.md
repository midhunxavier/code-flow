# Dependency discovery

Expand Getting started in the composer and select Check all dependencies. Resolve required tools first; optional Docker, terminal and snapshot capabilities can be configured when you need them.

## Check readiness

Expand **Getting started** and choose **Check all dependencies**. The report separates required tools from optional capabilities, explains missing authentication or compatibility, and provides a concrete next step. A successful run requires Node.js 22.13 or newer, Git 2.38 or newer, and at least one compatible provider CLI signed in through its own authentication flow. Unknown authentication or unverified compatibility is displayed as unknown rather than ready.

Provider and Git checks reuse the application's doctor implementation. Optional terminal inspection checks whether the configured Python can load its pseudo-terminal modules and reports the actual shell fallback. Browser snapshot inspection uses the same Chrome-compatible browser discovery as snapshots and runs a bounded version probe. Docker inspection checks the CLI version and asks its daemon for its version; a present CLI with an unavailable daemon is reported separately. Docker availability does not prove a provider image or authenticated volume has been prepared.

These are read-only checks. They do not execute repository commands, install packages, sign into accounts, pull images, or change server configuration. Optional failures do not block normal host CLI runs. A missing Python helper still permits the line-based terminal, and a missing snapshot browser does not remove the embedded app preview. Existing `CODEFLOW_PYTHON` and `CODEFLOW_CHROME` choices are inspected without being changed.

`GET /api/doctor/dependencies` returns `{checkedAt,node,git,providers,optional}`. Optional entries identify `terminal`, `snapshots`, and `docker`, each with installation/readiness state, detected version/path when available, details, and remediation text. Provider probes retain the existing doctor timeouts; optional browser/Docker probes are bounded to five seconds and pseudo-terminal discovery retains its ten-second limit. Probe commands use executable argument arrays, never a shell command assembled from browser input.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
