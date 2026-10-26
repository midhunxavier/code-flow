import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IntegrationConnections } from "../src/integration-connections.js";
import { Integrations } from "../src/integrations.js";
import { Notifications } from "../src/notifications.js";

const fetcher = (async () => Response.json([])) as typeof fetch;
const draft = { provider: "gitlab" as const, name: "Saved GitLab", scope: "org/repo", credential: "fixture-secret", baseUrl: "https://fixture.invalid/api/v4/" };
async function fixture() {
  const directory = await mkdtemp("/private/tmp/cf-qa-connections-"), file = join(directory, "notifications.json");
  const sources = new Integrations({ environment: {}, fetch: fetcher }); await sources.load([]);
  const notifications = new Notifications({ file, environment: {}, fetch: fetcher }); await notifications.load([]);
  const store = new IntegrationConnections({ directory: join(directory, "secrets"), integrations: sources, notifications, fetch: fetcher, githubTest: async () => {} }); await store.load();
  return { directory, file, sources, notifications, store, cleanup: async () => { await notifications.stop(); await rm(directory, { recursive: true, force: true }); } };
}
test("connection summaries expose all affected projects without credentials and disconnect removes every binding", async () => {
  const f = await fixture(); try {
    const { testId } = await f.store.testDraft(draft), { id } = await f.store.connect(testId, { projectId: "p-a", repository: "/scratch/a" });
    await f.store.associate({ connectionId: id, projectId: "p-a", repository: "/scratch/a2" });
    await f.store.associate({ connectionId: id, projectId: "p-b", repository: "/scratch/b" });
    assert.deepEqual(f.store.get(id).projectIds, ["p-a", "p-b"]);
    assert.doesNotMatch(JSON.stringify(f.store.list()), /fixture-secret|credentialRef/);
    await f.store.disconnect(id); assert.deepEqual(f.store.bindings("p-a"), []); assert.deepEqual(f.store.bindings("p-b"), []);
  } finally { await f.cleanup(); }
});
test("invalid administrator sources cannot hide or disable stored source connections", async () => {
  const f = await fixture(); try {
    const { id } = await f.store.connect((await f.store.testDraft(draft)).testId);
    const sources = new Integrations({ environment: { CODEFLOW_INTEGRATIONS_JSON: "[{bad" }, fetch: fetcher }); await assert.rejects(sources.load(), /not valid JSON/);
    const store = new IntegrationConnections({ integrations: sources, notifications: f.notifications, directory: join(f.directory, "secrets"), warnings: ["Administrator configuration unavailable"], fetch: fetcher }); await store.load();
    assert.equal(store.get(id).configured, true); await store.testExisting(id); assert.deepEqual(store.warnings(), ["Administrator configuration unavailable"]);
    assert.deepEqual(await sources.items(id, "issue"), { items: [], truncated: false, nextCursor: undefined });
  } finally { await f.cleanup(); }
});
test("tolerant startup loads saved notification preferences when only administrator configuration is broken", async () => {
  const f = await fixture(); try {
    const { id } = await f.store.connect((await f.store.testDraft({ provider: "webhook", name: "Saved updates", url: "https://fixture.invalid/updates" })).testId);
    await f.notifications.update(id, { enabled: true, events: ["done"], projects: ["p-a"] });
    const notifications = new Notifications({ file: f.file, environment: { CODEFLOW_NOTIFICATIONS_JSON: "[{bad" }, fetch: fetcher });
    await assert.rejects(notifications.load(), /not valid JSON/);
    await notifications.load(undefined, { allowInvalidAdministratorConfig: true }); assert.match(notifications.configurationWarning!, /Administrator notification configuration/);
    const store = new IntegrationConnections({ integrations: f.sources, notifications, directory: join(f.directory, "secrets") }); await store.load();
    assert.equal(store.get(id).configured, true); assert.equal(notifications.list().find(value => value.id === id)?.settings.enabled, true);
    await notifications.stop();
  } finally { await f.cleanup(); }
});
test("damaged delivery state stays untouched while unrelated connections remain usable", async () => {
  const f = await fixture(); try {
    const { id } = await f.store.connect((await f.store.testDraft(draft)).testId);
    const webhook = await f.store.connect((await f.store.testDraft({ provider: "webhook", name: "Saved updates", url: "https://fixture.invalid/updates" })).testId);
    await writeFile(f.file, "damaged-delivery-bytes");
    const notifications = new Notifications({ file: f.file, environment: { CODEFLOW_NOTIFICATIONS_JSON: "[{bad" } });
    await assert.rejects(notifications.load(undefined, { allowInvalidAdministratorConfig: true }), /state is damaged/);
    const store = new IntegrationConnections({ integrations: f.sources, notifications, notificationsAvailable: false, directory: join(f.directory, "secrets"), fetch: fetcher }); await store.load();
    assert.equal(store.get(id).unavailable, undefined); await store.testExisting(id); assert.match(store.get(webhook.id).unavailable!, /delivery storage/);
    await assert.rejects(store.testDraft({ provider: "webhook", url: "https://fixture.invalid/new" }), /storage is unavailable/);
    await store.disconnect(id); assert.equal(await readFile(f.file, "utf8"), "damaged-delivery-bytes");
  } finally { await f.cleanup(); }
});
test("Jira validation names the visible site field and credential errors name the connection", async () => {
  const f = await fixture(); try {
    await assert.rejects(f.store.testDraft({ provider: "jira", name: "QA Jira", scope: "APP", credential: "fixture", username: "qa@example.test" }), /Jira site URL/);
    await f.sources.load([{ id: "hidden-internal-id", name: "Team tracker", provider: "linear", project: "ENG", credentialEnv: "ABSENT_TOKEN" }]);
    await assert.rejects(f.sources.items("hidden-internal-id", "issue"), error => /Team tracker/.test(String(error)) && !/hidden-internal-id/.test(String(error)));
  } finally { await f.cleanup(); }
});
