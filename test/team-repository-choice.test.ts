import test from "node:test";
import assert from "node:assert/strict";
import { repositoryChoice } from "../ui/team-repository-choice.js";

test("repository choices produce portable keys without publishing host paths", () => {
  assert.deepEqual(repositoryChoice("/home/user/PHASES/", []), { key: "phases", label: "PHASES" });
  assert.deepEqual(repositoryChoice("C:\\work\\2026 App", []), { key: "repo-2026-app", label: "2026 App" });
  assert.deepEqual(repositoryChoice("/work/PHASES", ["phases", "phases-2"]), { key: "phases-3", label: "PHASES" });
  const long = repositoryChoice("/work/" + "x".repeat(100), ["x".repeat(64)]);
  assert.equal(long.key.length, 64);
  assert.ok(long.key.endsWith("-2"));
  assert.equal(long.label.length, 80);
  assert.match(repositoryChoice("/work/日本語", []).key, /^[a-z][a-z0-9-]{0,63}$/);
});
