# Frozen auth browser failure diagnosis

Frozen source/test base: `9e4a7f1`. Independent checkout: `/private/tmp/codeflow-qa-final-auth-navigation`, branch `codex/qa-final-auth-navigation`. No tracked source or test edits. Only one unchanged full-file replay was run.

## Raw frozen failure

The full run reports `not ok 139`, “two local owner cookies survive sign-in, invitations and logout on the other port”, after 7.41 seconds. At test line 85, `pagePost('/api/auth/logout')` completed and `self(p, b)` called `page.goto` at helper line 58:

> Navigation to `http://127.0.0.1:65494/` is interrupted by another navigation to `http://127.0.0.1:65492/`.

This happened before the subsequent B owner-identity assertion. It was not a failed cookie or principal assertion. Bounded unchanged excerpt: `auth-navigation-frozen-failure.txt`; original log lines 702–717 in `final-e2e-complete.log`.

## Single unchanged replay

Executed from the fresh checkout with:

```sh
CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/auth-navigation-replay-home \
HOME=/private/tmp/codeflow-qa-continue/auth-navigation-replay-os-home \
TMPDIR=/private/tmp/codeflow-qa-continue/auth-navigation-replay-tmp \
DEBUG=pw:api \
node --import tsx --test --test-concurrency=1 --test-timeout=180000 \
  test/e2e/qa-auth-session-accounts.e2e.ts
```

Result: **8/8 passed**, zero failed/cancelled/skipped, 43.23 seconds. The original failing first case passed in 8.76 seconds. The fixture reserved its own ports 50332–50335 and ran fake providers, scratch repositories/accounts/TLS, and owned browsers/servers. Its hooks stopped those resources. Browser receipt: zero page exceptions, zero unexpected console errors, six explicitly accounted responses. Server log contains the expected SQLite experimental warning and normal fixture shutdown/restart messages. Source test SHA256: `b9ea7f03b40ca81248a3c11adea4d6c8e2ae876d05c148c9e6e185bf37b5419c`; diff against frozen test and reviewed production files is empty.

Raw replay: `auth-navigation-unchanged-replay.log`. Full copied screenshots/server/browser receipts: `auth-navigation-unchanged-evidence/`.

## Diagnosis

The fixture's `pagePost` helper waits a fixed 100 ms after a principal-changing fetch, then the test immediately drives a cross-port navigation. It does not wait for the app to finish responding to the logout. Production explicitly reloads the shared dashboard when its closed stream triggers an identity check and the cookie is no longer a shared principal (`ui/shared.tsx` checkIdentity/streamState). Logging out invalidates the shared session and closes its stream. The UI's own sign-out action likewise requests a reload. This is expected session-transition behavior.

The unchanged replay's API diagnostics directly show the competing navigation, finishing just before the fixture's next goto:

- 18:08:37.807: logout `page.evaluate` begins on A.
- 18:08:37.847: evaluate returns.
- 18:08:37.868–37.887: an unsolicited A document navigation commits and reaches load.
- 18:08:37.950: `self(p,b)` starts navigation to B.

The frozen failure contains the same destinations in the overlapping order: B's goto starts while A's reload is still able to supersede it. The observed reload and the fixed-delay helper establish a fixture synchronization gap. The exact JavaScript callback stack for the frozen run was not recorded, so the stream-identity callback is source-backed attribution, not an independently captured frozen stack. No cookie/session isolation defect was reproduced; the unchanged pass does not erase the original failure or establish universal absence of a race.

## Proposed narrow correction (not applied)

Keep the logout HTTP 200 assertion, then wait for the actual signed-out UI on A (for example the exact “Sign in to shared projects” heading or Username field) before calling `self(p,b)`. This waits on the intended transition instead of increasing the arbitrary 100 ms delay. Alternatively, exercise the actual Sign out button and wait for that same signed-out UI while asserting its logout response. Preserve all cross-port cookie and identity assertions. No production change is supported by this evidence. No repeat replay or integration edit was performed.

## Subsequently authorized fixture correction

The parent later authorized this narrow fixture correction in a new dedicated branch, `codex/qa-final-browser-timing-fixes`, based on the same frozen9e4a7f1. Commit `c1560958bd347d9d0e43127c64c4a3821c16318d` retains the logout200 assertion, waits for the exact “Sign in to shared projects” heading, and then performs the unchanged other-port owner assertion. All cookie/auth assertions and existing timeout values are preserved. No production code changes.

The complete modified auth file passed **8/8**, zero failed/cancelled/skipped, **40.93 seconds**. Its API diagnostics show the signed-out heading resolved visible at18:35:30.205 before the next cross-port goto. Browser receipt: zero page exceptions, zero unexpected console errors, six explicitly accounted responses. The modified replay used separate scratch HOME/ZDOTDIR/CODEFLOW_HOME/TMPDIR, the approved QA Chrome wrapper, and reserved ports52097–52100. It is a separate authorized modified validation, not a second unchanged replay. Evidence: `auth-navigation-fixed.log`, `auth-navigation-fixed-evidence/` (7 artifacts) and `auth-navigation-fixed-manifest.json`. The original failure and single unchanged8/8 receipt remain preserved separately.

## Authorized cleanup

After reporting the proposal, the temporary checkout was removed with ordinary `git worktree remove` at its exact path. HEAD was verified as `9e4a7f1745bd8b99d5de0d676c887bbd9f3fae1c`, tracked/untracked Git status was clean, and no process had a CWD inside it before archiving or before removal. A full recovery archive excludes only `.git` and `node_modules` path components, does not follow symlinks, and preserves source plus ignored build/browser output. All 1,460 entry types/modes/links, file sizes and SHA256 values were checked against the compressed archive; the source manifest was rechecked immediately before removal. The 17 registered worktree paths after removal exactly match the list observed before this task created its checkout.

Archive: `/private/tmp/codeflow-qa-continue/auth-navigation-recovery/checkout.tar.gz` (17,398,159 bytes). SHA256: `6955e56c2f52a56df63c94f50c382cf1c98f7d7b8e52048aa721e7620e6c3a4f`. Branch `codex/qa-final-auth-navigation` remains at the exact frozen HEAD. Full manifest, Git diff, cleanup script, registered-path receipt and JSON result remain under the central QA directory (`auth-navigation-recovery/`, `auth-navigation-cleanup.py`, `auth-navigation-worktrees-after.txt`, `auth-navigation-cleanup-results.json`). Integration and every other checkout were retained. No additional replay was run.
