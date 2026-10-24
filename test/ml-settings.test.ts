import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MlService } from "../src/ml/service.js";
import { MlStore } from "../src/ml/store.js";
import { searchSettings } from "../ui/settings-sections.js";

const original = process.env.CODEFLOW_ML_ENABLED;
const services: MlService[] = [], homes: string[] = [];
async function create(home?: string) {
  home ??= await mkdtemp(join(tmpdir(), "codeflow-ml-settings-"));
  if (!homes.includes(home)) homes.push(home);
  const service = new MlService({ home, authorize: async (_project, repo) => ({ repo, commit: "a".repeat(40) }) });
  services.push(service); await service.load(); return { service, home };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  if (original === undefined) delete process.env.CODEFLOW_ML_ENABLED; else process.env.CODEFLOW_ML_ENABLED = original;
});

test("ML defaults off, persists the owner's choice across restart, and never installs a worker when toggled", async () => {
  delete process.env.CODEFLOW_ML_ENABLED;
  const { service, home } = await create();
  assert.deepEqual(service.settings(), { enabled: false, revision: 0 });
  await assert.rejects(service.startJob({}), /Enable model training in Settings/);
  assert.deepEqual(await service.setSettings({ enabled: true, revision: 0 }), { enabled: true, revision: 1 });
  const restarted = (await create(home)).service;
  assert.equal(restarted.enabled(), true);
  assert.equal(restarted.summary("new-project").enabled, true);
  assert.deepEqual(await restarted.setSettings({ enabled: false, revision: 1 }), { enabled: false, revision: 2 });
  process.env.CODEFLOW_ML_ENABLED = "true";
  const disabled = (await create(home)).service;
  assert.deepEqual(disabled.settings(), { enabled: false, revision: 2 });
  await assert.rejects(disabled.register({}), /Enable model training in Settings/);
  await assert.rejects(stat(join(home, "ml", "worker")), { code: "ENOENT" });
});

test("legacy environment activation is a fallback until Settings saves an explicit choice", async () => {
  process.env.CODEFLOW_ML_ENABLED = "true";
  const { service, home } = await create();
  assert.deepEqual(service.settings(), { enabled: true, revision: 0 });
  await service.setSettings({ enabled: false, revision: 0 });
  assert.equal((await create(home)).service.enabled(), false);
});

test("settings reject stale and concurrent edits without conflicting with job metadata writes", async () => {
  delete process.env.CODEFLOW_ML_ENABLED;
  const { service } = await create();
  await service.store.change(state => { state.targets[0]!.name = "My computer"; });
  const results = await Promise.allSettled([
    service.setSettings({ enabled: true, revision: 0 }),
    service.setSettings({ enabled: false, revision: 0 }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert.equal(results[1].reason.status, 409);
  assert.deepEqual(service.settings(), { enabled: true, revision: 1 });
  for (const body of [{}, { enabled: "true", revision: 1 }, { enabled: false, revision: -1 }, { enabled: false, revision: 1, command: "anything" }]) await assert.rejects(service.setSettings(body));
  assert.deepEqual(service.settings(), { enabled: true, revision: 1 });
});

test("corrupt saved activation fails closed and ML settings are discoverable by training terms", async () => {
  const { home } = await create();
  const path = join(home, "ml/state.json"), state = JSON.parse(await readFile(path, "utf8"));
  state.activation = { enabled: "false", revision: 1 };
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(new MlStore(join(home, "ml")).load(), /Invalid saved ML activation/);
  for (const query of ["ML", "model training", "fine tuning", "GPU", "machine learning"]) assert.ok(searchSettings(query).some(s => s.id === "general"), query);
});
