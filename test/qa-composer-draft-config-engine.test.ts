// A run takes .codeflow/config.json from the commit it starts on: a branch you chose brings its own
// check, setup and limits, while permissions and copied files stay your checkout's. A run's provider
// settings sit on top of the repository's models, field by field.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-qa-config-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { readRepoConfig, readRepoConfigAt } = await import("../src/repo-config.js");
type Run = import("../src/engine.js").Run;

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo }).toString().trim();
const writeConfig = (config: unknown) => writeFileSync(join(repo, ".codeflow", "config.json"), JSON.stringify(config));
const manager = new RunManager(findPattern);

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-qa-config-repo-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, ".codeflow"));
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, "README.md"), "config\n");
  writeConfig({ check: "echo MAIN", setup: "true", trust: "safe", copy: [".env"], limits: { maxSteps: 7 }, models: { claude: { model: "opus", effort: "high" } } });
  git("add", "."); git("commit", "-qm", "main config");
  git("checkout", "-qb", "alt");
  writeConfig({ check: "echo ALT", setup: "echo ALT-SETUP", trust: "standard", copy: [], limits: { maxSteps: 33 } });
  git("commit", "-qam", "alt config");
  git("checkout", "-qb", "bare", "main");
  git("rm", "-q", ".codeflow/config.json"); git("commit", "-qm", "no config");
  git("checkout", "-q", "main");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
});

async function finished(input: Partial<Parameters<typeof manager.start>[0]>): Promise<Run> {
  const run = await manager.start({ pattern: findPattern("solo")!, task: "Config probe", repo, roles: { agent: ["claude"] }, options: {}, loop: {}, ...input });
  await new Promise<void>((resolve) => { const check = () => run.status !== "running" && resolve(); manager.subscribe(run.id, check); check(); });
  return run;
}

test("a branch's committed config keeps the checkout's permissions and copied files", async () => {
  const at = await readRepoConfigAt(repo, "alt");
  assert.deepEqual([at.found, at.config.check, at.config.setup, at.config.limits?.maxSteps], [true, "echo ALT", "echo ALT-SETUP", 33]);
  assert.deepEqual([at.config.trust, at.config.copy], ["safe", [".env"]], "a branch can't widen permissions or choose what is copied from this computer");
  const none = await readRepoConfigAt(repo, "bare");
  assert.deepEqual([none.found, none.config.check, none.config.trust], [false, undefined, "safe"]);
  const checkout = await readRepoConfig(repo);
  assert.deepEqual(await readRepoConfigAt(repo, "no-such-branch"), checkout, "a ref that doesn't resolve reads the checkout");
  assert.deepEqual(await readRepoConfigAt(repo, "--output=x"), checkout, "an option is never passed to git as a ref");
});

test("a run from a chosen branch takes that branch's defaults; a continuation keeps the checkout's", async () => {
  const fromAlt = await finished({ baseRef: "alt" });
  assert.equal(fromAlt.status, "done", fromAlt.error);
  assert.deepEqual([fromAlt.loop.check, fromAlt.loop.setup, fromAlt.loop.maxSteps, fromAlt.trust], ["echo ALT", "echo ALT-SETUP", 33, "safe"]);
  const fromHead = await finished({});
  assert.deepEqual([fromHead.loop.check, fromHead.loop.setup, fromHead.loop.maxSteps], ["echo MAIN", "true", 7]);
  const continued = await finished({ baseRef: "alt", parentRunId: fromHead.id });
  assert.deepEqual([continued.loop.check, continued.loop.maxSteps], ["echo MAIN", 7], "a continuation doesn't adopt the branch it continues on");
  const explicit = await finished({ baseRef: "alt", loop: { check: "echo MINE", maxSteps: 5 } });
  assert.deepEqual([explicit.loop.check, explicit.loop.maxSteps], ["echo MINE", 5], "what the request sets still wins");
});

test("a provider the request names without a model or effort keeps the repository's", async () => {
  const named = await finished({ agentSettings: { claude: { effort: "low" } } });
  assert.deepEqual(named.agentSettings.claude, { model: "opus", effort: "low" });
  const empty = await finished({ agentSettings: { claude: { model: "" } } });
  assert.deepEqual(empty.agentSettings.claude, { model: "opus", effort: "high" });
  const chosen = await finished({ agentSettings: { claude: { model: "sonnet", effort: "medium" } } });
  assert.deepEqual(chosen.agentSettings.claude, { model: "sonnet", effort: "medium" });
});
