import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeProviderContract, providerVersionMatches } from "../src/doctor.js";

test("provider versions reject containing releases, prereleases and misleading extra versions", () => {
  for (const text of ["codex-cli 0.162.0", "v0.162.0", "0.162.0 (official CLI)"]) assert.equal(providerVersionMatches(text, "0.162.0"), true, text);
  for (const text of [undefined, "codex-cli 10.162.0", "0.162.01", "0.162.0-beta", "0.162.0+local", "0.162.1 (wanted 0.162.0)", "release0.162.0"]) assert.equal(providerVersionMatches(text, "0.162.0"), false, text);
});

test("contract probes use the explicit installed executable for version and every help command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-contract-binary-")), executable = join(directory, "installed-codex");
  try {
    await writeFile(executable, `#!/usr/bin/env node\nprocess.stdout.write(process.argv.includes('--version') ? 'codex-cli 0.162.0\\n' : '\\n  exec Execute\\n  app-server Server\\n  resume Resume\\n  --json --skip-git-repo-check --config --cd --output-schema --model\\n');\n`, { mode: 0o700 });
    const report = await probeProviderContract("codex", executable);
    assert.equal(report.installed, true); assert.equal(report.version, "codex-cli 0.162.0"); assert.equal(report.compatible, true); assert.deepEqual(report.missing, []);
    const missing = await probeProviderContract("codex", join(directory, "not-installed"));
    assert.equal(missing.installed, false, "an absent installed executable must never fall back to a host CLI");
    assert.equal(missing.compatible, null, "unavailable evidence remains explicitly unknown");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
