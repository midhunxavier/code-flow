import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JourneyStore } from "../src/journey-store.js";
const draft = { repo: "/qa/a", title: "Greeting", url: "http://localhost:54321/", width: 800, actions: [{ kind: "click", selector: "#go" }], expected: { selector: "#result", text: "Hello" } };
test("a corrupt or concurrently removed scenario does not hide another repository's records", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-journeys-isolation-")), store = new JourneyStore(root); const a = await store.create(draft), b = await store.create({ ...draft, repo: "/qa/b" });
  await writeFile(join(root, "00000000-0000-0000-0000-000000000000.json"), "{not json"); await writeFile(join(root, "11111111-1111-1111-1111-111111111111.json"), "null");
  assert.deepEqual((await store.list("/qa/a")).map(j => j.id), [a.id]); assert.deepEqual((await store.list("/qa/b")).map(j => j.id), [b.id]);
  assert.equal((await readdir(root)).filter(name => name.includes(".corrupt-")).length, 2);
  const readings = Array.from({ length: 15 }, () => store.list("/qa/b")); await store.delete(a.id); for (const values of await Promise.all(readings)) assert.deepEqual(values.map(j => j.id), [b.id]);
});
test("the host-wide cap names other repositories and all records remain discoverable without repository folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-journeys-cap-")), store = new JourneyStore(root); await store.create(draft);
  for (let i = 0; i < 99; i++) await store.create({ ...draft, repo: "/qa/moved-b", title: `B ${i}` });
  await assert.rejects(store.create(draft), /99.*\/qa\/moved-b|\/qa\/moved-b.*99/);
  assert.equal((await store.listAll()).length, 100);
});
test("missing and damaged scenarios have friendly typed errors and damaged files can be deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-journeys-errors-")), store = new JourneyStore(root), item = await store.create(draft); await store.delete(item.id);
  const missing = (e: any) => e.status === 404 && /not found|deleted/i.test(e.message) && !/ENOENT|\/private\/|\/tmp\//.test(e.message);
  await assert.rejects(store.get(item.id), missing); await assert.rejects(store.replays(item.id), missing); await assert.rejects(store.record(item.id, {} as never), missing);
  const id = "22222222-2222-2222-2222-222222222222"; await writeFile(join(root, `${id}.json`), "[]"); await assert.rejects(store.get(id), (e: any) => e.status === 409 && /unreadable/.test(e.message)); await store.delete(id); await assert.rejects(store.get(id), missing);
});

test("an external deletion between enumeration and read is isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa-journeys-delete-race-")), store = new JourneyStore(root), a = await store.create(draft), b = await store.create({ ...draft, repo: "/qa/b" });
  const get = store.get.bind(store); store.get = async id => { if (id === a.id) await rm(join(root, `${id}.json`), { force: true }); return get(id); };
  assert.deepEqual((await store.listAll()).map(item => item.id), [b.id]);
});
