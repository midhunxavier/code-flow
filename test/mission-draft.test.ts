import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { detectMissionDefaults, missionDraftInstructions, validateMissionDraft } from "../src/mission-draft.js";
const draft = { name: "Better onboarding", mission: "Make device connection understandable", users: "Operators", priorities: ["Connection feedback"], exclusions: [], questions: [] };

test("AI mission drafts contain bounded prose and cannot supply executable settings", () => {
  assert.deepEqual(validateMissionDraft(draft), draft);
  for (const invalid of [{ ...draft, check: "echo bypass" }, { ...draft, mode: "build-within-scope" }, { ...draft, scheduleEnabled: true }, { ...draft, name: " " }, { ...draft, mission: "x".repeat(6001) }, { ...draft, priorities: Array(13).fill("item") }, { ...draft, questions: ["a", "b", "c", "d"] }, { ...draft, users: "a\0b" }]) assert.throws(() => validateMissionDraft(invalid));
  const prompt = missionDraftInstructions("Improve OPC UA onboarding");
  assert.match(prompt, /Do not execute the mission/);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /Never include commands, schedules/);
  assert.ok(prompt.endsWith("Improve OPC UA onboarding"));
});

test("mission defaults prefer repository configuration, detect scripts and handle non-main branches", async t => {
  const repo = await mkdtemp(join(tmpdir(), "mission-defaults-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "trunk");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  assert.deepEqual(await detectMissionDefaults(repo), { check: "npm test", setup: "", baseBranch: "trunk", source: "package.json", warning: undefined });
  await mkdir(join(repo, ".codeflow"));
  await writeFile(join(repo, ".codeflow/config.json"), JSON.stringify({ check: "make verify", setup: "make install" }));
  const configured = await detectMissionDefaults(repo);
  assert.equal(configured.check, "make verify"); assert.equal(configured.setup, "make install"); assert.equal(configured.source, ".codeflow/config.json");
  await writeFile(join(repo, ".codeflow/config.json"), "{}");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal((await detectMissionDefaults(repo)).check, "");
  await writeFile(join(repo, ".codeflow/config.json"), "{");
  await assert.rejects(detectMissionDefaults(repo), /config.json/);
});
