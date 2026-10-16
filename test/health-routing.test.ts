// Health (doctor): the flags each CLI must accept, sign-in that's really unknown, and git's
// version. Auto routing around a CLI that isn't signed in. Fake CLIs only (test/fake-bin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-health-home-"));

const { exhausted, resolveAuto } = await import("../src/routing.js");
const { checkGit, doctor } = await import("../src/doctor.js");
const { gitAtLeast } = await import("../src/git.js");
type AgentId = import("../src/adapters/types.js").AgentId;
type Quota = import("../src/routing.js").Quota;

/** Run `fn` with these environment variables set (the fake CLIs read them when they start). */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("Auto passes over a CLI that isn't signed in for 15 minutes", () => {
  const now = Date.now();
  const quota: Quota = { claude: { status: "signed_out", windows: {}, at: now - 5 * 60_000 } };
  assert.equal(exhausted("claude", quota, now), "isn't signed in");
  assert.equal(exhausted("claude", quota, now + 11 * 60_000), undefined, "tried again later: you may have signed in");
  const { roles, notes } = resolveAuto({ builder: ["auto"] }, quota, new Set<AgentId>(["claude", "codex"]));
  assert.deepEqual(roles.builder, ["codex"]);
  assert.match(notes[0]!, /Claude Code isn't signed in/);
});

// Failures first: a successful model listing is cached for 10 minutes.
test("doctor: the flags each CLI must accept, Codex's 'Not logged in', and agy offline as unknown", async () => {
  // agy can't reach Google: that says nothing about sign-in.
  const offline = await withEnv({ FAKE_AGY_MODELS_FAIL: "network" }, () => doctor({}));
  const agyOffline = offline.find((h) => h.id === "agy")!;
  assert.equal(agyOffline.signedIn, null);
  assert.match(agyOffline.fix!, /Couldn't tell whether agy is signed in/);
  const agySignedOut = (await withEnv({ FAKE_AGY_MODELS_FAIL: "signed-out" }, () => doctor({}))).find((h) => h.id === "agy")!;
  assert.equal(agySignedOut.signedIn, false);

  // "Not logged in" contains "logged in", even with exit code 0.
  const codexOut = (await withEnv({ FAKE_SIGNED_OUT: "codex-exit0" }, () => doctor({}))).find((h) => h.id === "codex")!;
  assert.equal(codexOut.signedIn, false);
  assert.match(codexOut.fix!, /codex login/);

  const healthy = await doctor({});
  for (const h of healthy) {
    assert.equal(h.compatible, true, `${h.id}: ${h.warnings?.join(" ")}`);
    assert.equal(h.warnings, undefined, h.id);
    assert.ok(h.version, h.id);
  }
  assert.equal(healthy.find((h) => h.id === "codex")!.account, "ChatGPT");

  // An install that lacks a flag code-flow passes is flagged, not reported healthy.
  const old = await withEnv({ FAKE_UNKNOWN_FLAG: "--json-schema", FAKE_NO_APP_SERVER: "1" }, () => doctor({}));
  const claude = old.find((h) => h.id === "claude")!;
  assert.deepEqual([claude.compatible, claude.missing], [false, ["--json-schema"]]);
  assert.match(claude.warnings![0]!, /doesn't list --json-schema .*structured answers.*unknown option/);
  assert.match(claude.fix!, /Update Claude Code/);
  const codex = old.find((h) => h.id === "codex")!;
  assert.equal(codex.compatible, true, "app-server is optional: exec still works");
  assert.deepEqual(codex.missing, ["app-server"]);
  assert.match(codex.warnings![0]!, /No `codex app-server`/);
});

test("doctor: git must be 2.38 or newer for merges", async () => {
  const git = await checkGit();
  assert.equal(git.installed, true);
  assert.match(git.version!, /^\d+\.\d+\.\d+$/);
  assert.equal(git.ok, await gitAtLeast(2, 38));
  assert.equal(!!git.warning, !git.ok);
});
