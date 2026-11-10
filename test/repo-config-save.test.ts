import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, readRepoConfig, saveRepoCommands } from "../src/repo-config.js";

const fixture = async () => realpath(await mkdtemp(join(tmpdir(), "codeflow-config-save-")));

test("saving commands creates .codeflow/config.json and every reader sees them", async () => {
  const repo = await fixture();
  const saved = await saveRepoCommands(repo, { check: "  npm test  ", setup: "npm ci" });
  assert.deepEqual(saved.config.check, "npm test");
  assert.deepEqual(JSON.parse(await readFile(join(repo, CONFIG_PATH), "utf8")), { setup: "npm ci", check: "npm test" });
  assert.equal((await readRepoConfig(repo)).config.setup, "npm ci");
});

test("saving keeps the file's other settings and an empty command removes its key", async () => {
  const repo = await fixture();
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, CONFIG_PATH), JSON.stringify({ check: "old", copy: [".env"], limits: { maxSteps: 9 }, custom: { kept: true } }));
  await saveRepoCommands(repo, { check: "new" });
  assert.deepEqual(JSON.parse(await readFile(join(repo, CONFIG_PATH), "utf8")), { check: "new", copy: [".env"], limits: { maxSteps: 9 }, custom: { kept: true } });
  await saveRepoCommands(repo, { check: "   " });
  const raw = JSON.parse(await readFile(join(repo, CONFIG_PATH), "utf8"));
  assert.equal("check" in raw, false);
  assert.deepEqual(raw.custom, { kept: true });
});

test("a command left out is not touched, and nothing is written when there is nothing to save", async () => {
  const repo = await fixture();
  assert.deepEqual(await saveRepoCommands(repo, { check: "", setup: "" }), { config: {}, found: false });
  assert.equal(existsSync(join(repo, ".codeflow")), false);
  await saveRepoCommands(repo, { check: "make test" });
  await saveRepoCommands(repo, { setup: "make deps" });
  assert.deepEqual((await readRepoConfig(repo)).config.check, "make test");
});

test("saving refuses a broken file and a symbolic link instead of overwriting them", async () => {
  const repo = await fixture();
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, CONFIG_PATH), "{ not json");
  await assert.rejects(saveRepoCommands(repo, { check: "npm test" }), /not valid JSON/);
  assert.equal(await readFile(join(repo, CONFIG_PATH), "utf8"), "{ not json");
  const linked = await fixture(), outside = await fixture();
  await symlink(outside, join(linked, ".codeflow"));
  await assert.rejects(saveRepoCommands(linked, { check: "npm test" }), /symbolic link/);
  assert.equal(existsSync(join(outside, "config.json")), false);
});
