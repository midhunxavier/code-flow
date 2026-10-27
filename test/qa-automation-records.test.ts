import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Automations } from "../src/automation.js";
import { parseRouteHash } from "../ui/navigation.js";
import type { RunManager } from "../src/engine.js";

const input = { name: "Record QA", enabled: true, webhook: false, isolate: false, schedule: { every: 30 }, run: { repo: "/scratch/repo", pattern: "solo", task: "QA" } };
async function fixture(raw?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "qa-auto-records-")), file = join(dir, "triggers.json");
  if (raw !== undefined) await writeFile(file, typeof raw === "string" ? raw : JSON.stringify(raw));
  const auto = new Automations({} as RunManager, async () => { throw new Error("not used"); }, undefined, file);
  await auto.load(); return { auto, file, dir };
}

test("record updates validate the merged trigger before mutating revision, schedule or token", async () => {
  const { auto, file } = await fixture(), original = await auto.create(input);
  const saved = await readFile(file, "utf8");
  await assert.rejects(auto.update(original.id, { schedule: undefined, rotateToken: true }), /schedule.*webhook/i);
  assert.deepEqual(auto.get(original.id), original); assert.equal(await readFile(file, "utf8"), saved);
  const hook = await auto.update(original.id, { schedule: undefined, webhook: true, revision: original.revision });
  assert.equal(hook.schedule, undefined); assert.equal(hook.webhook, true);
  await assert.rejects(auto.update(original.id, { webhook: false }), /schedule.*webhook/i);
});

test("repair clears a load-time schedule note but keeps real start failures", async () => {
  const raw = { ...input, id: "t-fixture", token: "1234567890123456", schedule: { every: -2 } };
  const { auto, file } = await fixture([raw]);
  assert.match(auto.get(raw.id)!.lastError!, /Turned off/);
  const repaired = await auto.update(raw.id, { schedule: { every: 20 }, enabled: true });
  assert.equal(repaired.lastError, undefined); assert.equal(repaired.enabled, true);
  await auto.load(); assert.equal(auto.get(raw.id)!.lastError, undefined);
  await writeFile(file, JSON.stringify([{ ...repaired, lastError: "Provider unavailable" }]));
  await auto.load(); assert.equal((await auto.update(raw.id, { name: "Renamed" })).lastError, "Provider unavailable");
  assert.equal((await auto.update(raw.id, { schedule: { every: 25 }, enabled: true })).lastError, "Provider unavailable");
});

test("storage exposes recovered backup or unavailable state and refuses unavailable changes as 503", async () => {
  const recovered = await fixture('{"secret":"must-not-appear",');
  const status = (recovered.auto as any).storageStatus();
  assert.equal(status.state, "recovered"); assert.ok(status.backup); assert.doesNotMatch(JSON.stringify(status), /must-not-appear/);
  assert.equal(await readFile(join(recovered.dir, status.backup), "utf8"), '{"secret":"must-not-appear",');
  const unavailable = await fixture(); await mkdir(unavailable.file); await unavailable.auto.load();
  assert.equal((unavailable.auto as any).storageStatus().state, "unavailable");
  await assert.rejects(unavailable.auto.create(input), (e: any) => e.status === 503 && /storage/i.test(e.message));
});

test("mission-owned records refuse generic edits and deletion as actionable 409", async () => {
  const raw = { ...input, id: "t-mission", token: "1234567890123456", target: { kind: "project-team", teamId: "pt-" + "a".repeat(24) } };
  const { auto, file } = await fixture([raw]), saved = await readFile(file, "utf8");
  await assert.rejects(auto.update(raw.id, { name: "Unsafe" }), (e: any) => e.status === 409 && /project mission/.test(e.message));
  await assert.rejects(auto.remove(raw.id), (e: any) => e.status === 409 && /project mission/.test(e.message));
  assert.equal(await readFile(file, "utf8"), saved); assert.equal(auto.get(raw.id)?.name, input.name);
});

test("global and project automation links validate the same purpose and reject extra segments", () => {
  for (const kind of ["once", "repeat", "backlog", "missions"]) {
    assert.equal(parseRouteHash(`#/automations/${kind}`).view, "automations");
    assert.equal(parseRouteHash(`#/project/p-a/automation/${kind}`).view, "project");
  }
  for (const suffix of ["bogus", "repeat/extra", "repeat/", "once/ignored/extra"]) {
    assert.equal(parseRouteHash(`#/automations/${suffix}`).view, "invalid");
    assert.equal(parseRouteHash(`#/project/p-a/automation/${suffix}`).view, "invalid");
  }
  assert.deepEqual(parseRouteHash("#/automations"), { view: "automations" });
  assert.deepEqual(parseRouteHash("#/settings/automations/repeat"), { view: "automations" });
  assert.deepEqual(parseRouteHash("#/foo"), { view: "composer" });
  assert.deepEqual(parseRouteHash("#/settings/bogus"), { view: "settings", section: "general" });
});
