# Preparing a preview release

The source repository stays private to npm publishing (`private: true`). The release builder creates a separate, publishable package in `dist/npm` with compiled JavaScript, UI, local docs, workers, SSH helpers and licenses. It has no install scripts or runtime npm dependencies. The npm package and macOS app use that same runtime.

## Build and validate

Update the root package version and lockfile to a new `x.y.z-preview.N` value, then run:

```sh
npm ci
npm run typecheck
npm test
npm run release:prepare
npm run test:package
```

`release:prepare` writes the npm tarball, SHA-256 checksum, generated Homebrew formula and draft release notes to `output/releases`. The packaging acceptance test installs that actual tarball in a temporary directory outside the checkout, starts the server, checks the browser opener and bundled docs/assets, exercises the semantic worker, then verifies graceful shutdown and headless startup. It uses fake agent CLIs and never spends provider quota.

Inspect the package before publishing:

```sh
npm pack ./dist/npm --dry-run
node dist/npm/bin/codeflow.mjs --help
```

The **Preview release** GitHub workflow builds and tests the tarball on macOS and Linux, builds both macOS architectures, and creates a **draft prerelease** with the exact artifacts. It accepts an existing Git ref and checks that its version matches the requested tag. It does not publish npm or create a Homebrew tap. Run it against a committed, reviewed release ref.

## npm preview channel

The published package is scoped as `@midhunxavier/code-flow` because npm rejected the unscoped name as too similar to the existing `codeflow` package. The installed commands remain `codeflow` and `code-flow`.

Authenticate to the npm account that owns `@midhunxavier/code-flow`. On first publication, confirm the package name is available and that you are publishing from the intended account. Then publish the tested tarball:

```sh
npm whoami
npm publish output/releases/midhunxavier-code-flow-0.1.0-preview.3.tgz --tag preview --access public
npm view @midhunxavier/code-flow@preview version
```

Use the actual version's filename when publishing subsequent previews. Never publish this preview with the `latest` tag. The staged package also sets `publishConfig.tag` to `preview`. Test `npx @midhunxavier/code-flow@preview` from a clean directory after registry publication.

## macOS DMG

Build on macOS with Xcode Command Line Tools installed:

```sh
npm run package:macos -- arm64
npm run package:macos -- x64
npm run test:macos
```

The builder downloads an official Node runtime with a pinned SHA-256, packages a pinned Electron runtime with the prepared backend and Node license, compiles the native computer-use helper, and creates a drag-to-Applications DMG. The app requires macOS 13+. Its sandboxed renderer has no Node access, and the separate local backend survives window reloads and closing. Lifecycle tests launch the actual packaged app, verify renderer isolation and backend continuity, and check normal quit and crash cleanup. Both architectures are tested on matching GitHub runners. Git and the agent CLIs remain user-installed. The launcher reads the login shell's PATH to find common CLI and version-manager installations.

Without signing credentials the output is explicitly named `-unnotarized.dmg`. These builds are for developer testing; do not describe them as signed, notarized or Gatekeeper approved.

For distributable DMGs, install a **Developer ID Application** identity in the build keychain and save notarization credentials with `xcrun notarytool store-credentials`. Set:

```sh
export CODEFLOW_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export CODEFLOW_NOTARY_PROFILE='code-flow-notary'
npm run package:macos -- arm64
npm run package:macos -- x64
```

The builder signs Node with its JIT entitlements, signs the app and DMG, submits to Apple's notarization service, staples the ticket, and verifies the result. Never commit certificates, credentials or keychain files.

### Desktop updates

Signed and notarized builds also produce `code-flow-VERSION-macos-ARCH.zip`, its SHA-256 file, and `releases-ARCH.json`. The ZIP contains the notarized, stapled app; the feed uses Electron's [Squirrel JSON format](https://www.electronjs.org/docs/latest/tutorial/updates) with a version, exact asset URL, checksum and size. The release workflow attaches these automatically. Publish the DMG, ZIP and feed together under the matching `vVERSION` GitHub release, and keep the same Developer ID signing identity across updates. Unnotarized builds never produce a native update feed.

The desktop main process checks public GitHub releases on launch, every six hours, and on demand. It compares stable/preview versions numerically, skips drafts and missing architecture assets, and never selects an older version. It downloads through Electron's native updater only after the user chooses **Download update**. Restarting uses the normal active-agent confirmation and backend shutdown. Unnotarized installations offer the matching DMG instead. No GitHub token is needed, and browser/npm clients have no desktop update controls.

Before publishing the first signed updater release, install it in Applications and test updating to a second signed version on both architectures. Unit and lifecycle tests cover release selection, failure/retry states, bridge isolation and restart cancellation; only this two-version acceptance check validates Apple's signing/notarization and Squirrel's actual app replacement. Existing desktop previews without the updater need a manual upgrade to acquire it.

The GitHub workflow can import the following repository secrets into a temporary build keychain: `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD`. Supply all six for signed and notarized builds; with none set, it produces clearly labeled unnotarized developer builds. Partial credential configuration fails instead of silently dropping signing.

## Homebrew

`release:prepare` generates `output/releases/Formula/code-flow.rb` from the actual npm tarball's SHA-256. After the GitHub prerelease assets are published, copy this formula into `Formula/code-flow.rb` in the `midhunxavier/homebrew-code-flow` repository, then test:

```sh
brew install --build-from-source midhunxavier/code-flow/code-flow
brew test midhunxavier/code-flow/code-flow
codeflow --version
```

The tap must exist and contain the generated formula before advertising the Homebrew command as available. Regenerate the formula whenever the tarball changes; it references the GitHub release asset, so npm registry availability is independent.

## Publish the GitHub prerelease

Review the draft notes and attached checksums. Verify each DMG's signing status and label it accurately. Publish the draft as a **prerelease**, leaving the stable latest release unchanged. The draft notes include an exact GitHub tarball command so the preview can be tried even before the npm channel is available.

Keep platform claims precise: macOS and Linux are supported; Windows users use WSL2. Native Windows execution is not supported. On a real Windows machine, confirm WSL networking and the Windows browser opener before claiming end-to-end Windows validation.

[Documentation library](README.md) · [Installation](installation.md)
