# Final Antigravity URL-denial boundary

2026-10-26, source base `544674d`, dedicated branch `codex/qa-final-agy-denial`. SOLO-GAP-03 remains **partial**. The final fake-adapter attempt was made through actual Chrome and API, but it stops at verified-runtime admission before the requested URL tool can run. No real provider, native desktop action, external URL or permissive fallback was used.

The task entered in the composer asks isolated Antigravity to open the owned CodeFlow server's `/api/projects` URL and report a refusal without workarounds. This is an intended prohibited application-origin target. The test does not count the ordinary application API reads used by the page as an agent tool call.

## Observed result

- The stock fake Antigravity CLI reports `1.3.6`. Doctor reports installed and signed in under the fixture, but `managedCompatible=false`.
- Composer displays `Antigravity 1.3.6 can't run isolated on this computer…`; Send is disabled and the browser sends zero run-start requests.
- A direct explicit `antigravityExecution: isolated` API request receives **400** with `Isolated Antigravity requires macOS, CLI 1.4.4 or 1.4.5 or 1.4.6 or 1.4.7, and an existing native Keychain login/security cache. Code Flow never switches to unrestricted execution automatically.`
- The owned application's run list stays empty. Instrumentation added only to the private copy of `test/fake-agent.mjs`, immediately before prompt execution, records no worker start. There is no native fallback, no worktree, and source HEAD/status/README bytes stay unchanged.
- Screenshot inspected; browser page errors, console errors and failed requests are all empty. The deliberate direct API400 is recorded in the receipt. All owned processes are stopped and the temporary app/home/repository are removed after evidence is saved.

## Exact blocking path

1. `ui/composer.tsx` reads Doctor's managed compatibility and blocks isolated Antigravity with the visible guidance above.
2. `src/server.ts::validateRoles` independently calls the adapter's `managedAvailability` for explicit isolated execution before creating a run. It excludes the incompatible provider and returns its reason.
3. `src/adapters/agy.ts` supplies `agyIsolationProblem`; `src/adapters/agy-isolation.ts::inspectAgyIsolationRuntime` performs sandboxed executable verification before preparing the isolated profile. Accepted versions are explicitly 1.4.4–1.4.7. The stock fake reports 1.3.6 and is a shell-to-Node wrapper; the version sandbox deliberately does not grant that interpreter chain execution. Rejection occurs before reading native Keychain runtime paths.
4. `prepareAgyIsolation` has therefore not exposed a tool connection for this run. Its policy would deny native `read_url(*)`/`execute_url(*)` and permit only the scoped shared tool interface when configured. Those source facts and existing policy tests do not establish that a URL request actually occurred here.

Existing `createAgyAdapter` unit fixtures inject a synthetic process at construction time. They can exercise denial/result parsing and fail-closed tool names, but using that bypass here would manufacture a reachable isolated adapter instead of testing the stock fixture's real admission path. Neither the fake nor real URL refusal is promoted to a pass. A future genuine URL-denial replay needs a supported isolated fixture/provider exposing the scoped browser request; a real provider replay additionally needs the separately authorized call budget. No additional provider call was made for this investigation.

## Validation and evidence

- New durable regression: `test/e2e/qa-final-agy-url-boundary.e2e.ts`, **1/1 Chrome pass**, `/private/tmp/codeflow-qa-continue/final-agy-url.log`.
- Receipt: `/private/tmp/codeflow-qa-continue/final-agy-url/boundary-receipt.json`, including `requestedUrlToolReached:false`, `workerStarted:false`, `nativeFallback:false` and `realProviderInvoked:false`.
- Visual and logs: `isolated-agy-prohibited-url-preflight.png`, matching page text, `browser.json` and `server.log` in that same evidence directory.
- Related policy/recovery/shared-tool checks pass **17/17** and typecheck passes; recorded in `/private/tmp/codeflow-qa-continue/final-agy-related.log` and `final-agy-tsc.log`.

Every test/build/application command used an outer scratch `CODEFLOW_HOME`, `HOME` and `ZDOTDIR`. The UI build ran in a private copied app with reserved ports. The live checkout/listeners, user application home, real provider credentials and configured SSH hosts were untouched.
