# Side-browser frozen-suite diagnosis and fixture repair

The five frozen-suite failures reproduced unchanged and were traced to the fixture discarding the supplied QA Chrome launcher. A sample of its owned Chrome process showed a native macOS Keychain authorization wait. Preserving the approved launcher makes all five cases pass without changing app source, test actions, waits, or assertions.

## Exact inputs and results

| Run | Input | Result | Evidence |
| --- | --- | --- | --- |
| Frozen full unit suite | `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c` | Whole suite2158:2140 passed,5 failed,13 skipped. Side-browser cases1579–1583 all failed. | `final-unit-complete.log`; copied artifacts `final-side-browser-frozen-evidence/` with SHA256 manifest |
| One unchanged isolated whole-file replay | Exact frozen archive `/private/tmp/codeflow-qa-final-side-browser-kp83Yr` | 0/5 passed,5 failed;257.849s; exit1. | `final-side-browser-unchanged.log`, `final-side-browser-unchanged-manifest.json`, `final-side-browser-unchanged/` |
| Modified whole-file replay | Same production/test actions; launcher delegation repair | 5/5 passed,39.032s; exit0; console errors `[]`. | `final-side-browser-fixed.log`, `final-side-browser-fixed/`, `final-side-browser-fixed-processes.txt` |
| Full unit suite after repair | Commit `0129dac6cc4d81d39d5c862df0e52b74724b3994`, branch `codex/qa-final-side-browser-fix` | Running; no final result claimed. | `final-unit-keychain-complete.log`, `final-unit-keychain-validation-pin.json` |

## Failure and causal evidence

The original screenshot shows `Chrome Emulation.setDeviceMetricsOverride timed out`, a blank retained canvas and an about:blank tab while the address field contains `/manual-one`. The next cases also time out in `Page.getFrameTree` and `Page.navigate`; frame counters do not progress. This is not merely a selector mismatch.

The unchanged replay reproduces all five failures. A two-second sample of ONLY the owned internal Chrome PID76468 recorded323 samples in `SecItemAdd → defaultKeychainUI → makeLoginAuthUI → AuthorizationCopyRights → synchronous XPC wait`; other Chrome workers were blocked in Keychain locks in `SecItemCopyMatching` and `SecItemDelete`. See `final-side-browser-unchanged-chrome-sample.txt`. No Keychain data was inspected, no native prompt was operated, and no native settings were changed.

The test generated canonical and legacy wrappers that always executed raw Chrome and overwrote inherited `CODEFLOW_CHROME`. Actual unchanged process arguments lacked `--use-mock-keychain`. The approved outer wrapper is `/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome`, which executes installed Chrome with that flag. The repaired fixture delegates to that inherited executable while retaining its own canonical/legacy marker logs; if no nonempty inherited executable is set, its existing macOS fallback adds the same flag. Paths are POSIX shell quoted. The actual passing internal Chrome arguments include `--use-mock-keychain`.

The only committed path is `test/qa-side-browser-ui.test.ts`. Canonical precedence and all browser assertions remain unchanged. Final commit also normalizes empty `CODEFLOW_CHROME` to unset after independent review; that is behavior-identical for the targeted replay's truthy wrapper. The full suite runs the final committed input. No production fix was made or inferred from these harness failures.

## Isolation and exact launch

Both4355/4357 were free before the single unchanged replay. Its normal teardown released ports and left zero owned browser processes; no kill was needed. Original artifacts were copied before using distinct evidence roots. The baseline archive remains unregistered and unchanged.

The modified targeted command, from `/private/tmp/codeflow-qa-final-side-browser-fix`, was:

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/final-side-browser-fixed-home HOME=/private/tmp/codeflow-qa-continue/final-side-browser-fixed-os-home ZDOTDIR=/private/tmp/codeflow-qa-continue/final-side-browser-fixed-os-home CODEFLOW_CHROME=/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome QA_SIDE_BROWSER_EVIDENCE=/private/tmp/codeflow-qa-continue/final-side-browser-fixed node --import tsx --test --test-concurrency=1 test/qa-side-browser-ui.test.ts
```

The full suite uses fresh private homes and evidence root, recorded verbatim in `final-unit-keychain-validation-pin.json`. All `src`, `ui`, `scripts`, `training`, `integrations`, and package tree hashes equal the frozen9e4 input; only the one unit fixture differs. Real local Chrome/UI runs use a fake provider for setup. No paid provider calls, user repositories, live4317/4318 server, or live checkout build occurred.
