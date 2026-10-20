# Provider and workflow extensions

Inspect the extension bundle and its declared API version before enabling it. Pin the version you intend to run; an extension is trusted executable code, not a sandboxed configuration file.

## Connect a trusted extension

For OpenCode or another CLI that speaks Agent Client Protocol, use [ACP connections in Settings](acp-agents.md). No JavaScript extension bundle is needed for a compatible stdio agent.

The owner can register additional provider adapters and workflow patterns with an explicit server environment configuration. There is no repository discovery, remote download, HTTP plugin installation or shared-user administration. Settings → Extensions reports loaded/rejected bundles and negotiated API versions. Restart to apply configuration changes.

An extension is trusted JavaScript server code, with the server owner's filesystem, network and process permissions. Review its source and bundle dependencies before enabling it. Hash pinning detects changed bundle bytes; it does not make malicious code safe or sandbox its behavior. Use self-contained `.mjs` bundles; relative imports resolve from the private captured-bundle cache, not the original module directory. Provider authors must honor abort signals, timeouts, trust modes and the normalized event/result contracts. Built-in compatibility probes, container isolation and SSH workers do not certify or execute additional plugin providers.

Set `CODEFLOW_EXTENSIONS_FILE` to an absolute regular JSON file:

```json
{
  "version": 1,
  "extensions": [{
    "id": "example",
    "version": "1.0.0",
    "module": "/absolute/path/example.mjs",
    "sha256": "replace-with-the-64-character-sha256-of-the-reviewed-bundle",
    "api": { "major": 1, "minimumMinor": 0 },
    "requires": ["provider-adapter", "workflow-pattern"]
  }]
}
```

`CODEFLOW_EXTENSIONS_JSON` accepts the same object; choose one source. The host supports API 1.0 and rejects a newer major/minimum minor or unknown required capability before importing the bundle. Up to 16 extensions can each supply up to eight providers and eight workflows. Configuration is bounded to 128 KiB and bundles to 512 KiB; symlink files and changed hashes are refused. Captured bytes are copied to a private hash-named cache before import, so a change to the original file between review and import cannot substitute unpinned content.

The default export has this shape:

```js
export default {
  api: { major: 1, minor: 0 },
  providers: [/* AgentAdapter objects from src/adapters/types.ts */],
  workflows: [/* Pattern objects from src/engine.ts */]
};
```

Each ID must be `plugin:example/name`. Provider adapters implement `available()`, `catalog()` and `run(options, onEvent)` and return normalized `AgentEvent`/`RunResult` data. Workflows declare names, descriptions, bounded role/default-provider and option schemas, then execute through `TeamContext` for worktrees, agent turns, commits, checks, artifacts and replayable remembered operations. New providers appear in agent selection and workflows in the normal composer. Built-in IDs cannot be replaced, duplicate registrations are refused and workflow default roles must refer to registered providers. Plugin capabilities remain unknown until independently established; built-in tool bridges and live approval prompts are unavailable.

Runs pin every selected extension's version and SHA-256. Resume or further dispatch refuses a missing or changed pin; restore the exact reviewed bundle or create a fresh run. A restrictive filesystem policy also blocks plugin execution. The fixture acceptance test loads a real captured bundle, registers a new provider/workflow, runs it through the actual engine, commits its result and executes its real check without provider quota or external requests.

`GET /api/extensions` is owner-only and returns status, hashes, negotiated versions and registered IDs, with bounded redacted error details. It does not return module source or the configuration document. Extension caches are executable code, not portable project data; restore does not enable plugins without an explicit environment configuration.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
