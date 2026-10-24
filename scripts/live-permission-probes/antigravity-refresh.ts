import "./environment.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAgyIsolationRuntime, prepareAgyIsolation, AGY_VERIFIED_CLI_VERSIONS, AGY_ISOLATION_VERSION } from "../../src/adapters/agy-isolation.js";
import { agyCredentialFailure, inspectAgyAuthLog } from "../../src/adapters/agy-auth.js";
import { startJsonlProcess } from "../../src/adapters/process.js";

// Normal native authentication only. No logout, clock/expiry changes, credential export,
// proxy/interception, alternate token endpoint or Keychain mutation by this probe.
const workspace = await mkdtemp(join(tmpdir(), "codeflow-agy-refresh-probe-"));
let isolated: Awaited<ReturnType<typeof prepareAgyIsolation>> | undefined;
try {
  isolated = await prepareAgyIsolation(workspace, "read", await inspectAgyIsolationRuntime());
  const logPath = join(isolated.paths.scratch, "native-auth.log");
  let models = 0;
  const proc = startJsonlProcess({ command: isolated.command, args: [...isolated.args, "--log-file", logPath, "models"], cwd: isolated.paths.workspace, env: isolated.env, timeoutMs: 20000,
    onJson: () => {}, onText: line => { if (/^[a-z0-9][a-z0-9._-]*\t[^\t]+$/i.test(line)) models++; },
  });
  const outcome = await proc.outcome;
  // Do not emit log lines, timestamps from credentials, URLs, accounts or diagnostic values.
  const auth = await inspectAgyAuthLog(logPath);
  const authFailure = auth.credentialFailure || auth.interactiveAuthObserved || agyCredentialFailure(outcome.stderr);
  const discoverySucceeded = outcome.exitCode === 0 && !outcome.timedOut && !outcome.aborted && models > 0 && !authFailure;
  const refreshVerified = discoverySucceeded && auth.log === "read" && auth.refreshObserved;
  console.log(JSON.stringify({ supportedCliVersions: AGY_VERIFIED_CLI_VERSIONS, isolation: AGY_ISOLATION_VERSION,
    discoverySucceeded, modelCount: models, refreshVerified,
    expiredTokenRefreshVerified: refreshVerified && auth.loadedTokenExpired === true,
    nativeLog: auth.log, loadedTokenExpired: auth.loadedTokenExpired,
    nativeRefresh: authFailure ? "failure-observed" : auth.refreshObserved ? "success-observed" : "not-observed",
    credentialPersistence: auth.credentialFailure ? "failure-observed" : "not-attested",
    interactiveAuthObserved: auth.interactiveAuthObserved,
    timeout: outcome.timedOut, credentialValuesExported: false, forcedExpiry: false,
  }, null, 2));
  // A successful ordinary request must not make a refresh verification job go green.
  process.exitCode = !discoverySucceeded ? 1 : refreshVerified ? 0 : 2;
} catch {
  console.log(JSON.stringify({ discoverySucceeded: false, nativeRefresh: "unverified", error: "Isolated probe failed; native diagnostics withheld" }));
  process.exitCode = 1;
} finally {
  await isolated?.cleanup();
  await rm(workspace, { recursive: true, force: true });
}
