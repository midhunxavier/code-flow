import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationConnections, describeGitRemote } from "../src/integration-connections.js";
import { Integrations } from "../src/integrations.js";
import { Notifications } from "../src/notifications.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "connection-store-")), calls: { url: string; headers: Headers; body?: string }[] = [];
  const fetcher = (async (input, options) => {
    const url = String(input), headers = new Headers(options?.headers); calls.push({ url, headers, body: options?.body as string });
    if (headers.get("PRIVATE-TOKEN") === "bad-secret-token") return new Response("bad-secret-token must never be shown", { status: 401 });
    if (url.includes("hooks.example.test")) return new Response("ok");
    const item = { iid: 7, title: "Issue fixture", description: `Untrusted source with reflected credential: ${headers.get("PRIVATE-TOKEN")}`, state: "opened", web_url: "https://gitlab.example.test/org/repo/issues/7" };
    return Response.json(/\/issues\/7$/.test(url) ? item : [item]);
  }) as typeof fetch;
  const environment = { ADMIN_TOKEN: "administrator-original-token" };
  const integrations = new Integrations({ environment, fetch: fetcher });
  await integrations.load([{ id: "admin-gitlab", provider: "gitlab", project: "org/admin", credentialEnv: "ADMIN_TOKEN" }]);
  const notifications = new Notifications({ file: join(directory, "notifications.json"), environment: {}, fetch: fetcher }); await notifications.load([]);
  const create = () => new IntegrationConnections({ integrations, notifications, directory: join(directory, "private"), fetch: fetcher });
  const store = create(); await store.load();
  return { directory, calls, environment, integrations, notifications, store, create, clean: async () => { await notifications.stop(); await rm(directory, { recursive: true, force: true }); } };
}
const draft = { provider: "gitlab" as const, name: "Work GitLab", scope: "org/repo", credential: "private-managed-token", baseUrl: "https://gitlab.example.test/api/v4/" };

test("tested connection keeps secrets encrypted, retains project scope, reconnects and preserves administrator configuration", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.testDraft({ ...draft, credential: "bad-secret-token" }), error => /HTTP 401/.test(String(error)) && !String(error).includes("bad-secret-token"));
    assert.equal(f.store.list().length, 1);
    const test = await f.store.testDraft(draft);
    const { id } = await f.store.connect(test.testId, { projectId: "p-first", repository: "/local/repo" });
    assert.deepEqual(f.store.bindings("p-first"), [{ projectId: "p-first", repository: "/local/repo", connectionId: id }]);
    assert.equal(f.store.list().find(c => c.id === id)?.administratorManaged, false);
    assert.equal(f.store.list().find(c => c.id === "admin-gitlab")?.administratorManaged, true);
    const source = await f.integrations.importSource(id, "issue", "7", { project: "p-first", repository: "/local/repo" });
    assert.doesNotMatch(JSON.stringify(source), /private-managed-token/); assert.match(source.body, /\[REDACTED\]/);
    assert.deepEqual(f.integrations.resolveSource(source.id).projectContext, { project: "p-first", repository: "/local/repo" });
    assert.doesNotMatch(JSON.stringify(f.store.list()), /private-managed-token|credentialRef|usernameRef|TOKEN/);
    assert.doesNotMatch(await readFile(join(f.directory, "private/connections.enc"), "utf8"), /private-managed-token|org\/repo/);
    assert.equal((await stat(join(f.directory, "private/master.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, "private/connections.enc"))).mode & 0o777, 0o600);
    assert.deepEqual(f.environment, { ADMIN_TOKEN: "administrator-original-token" }, "managed secrets do not enter process or caller environments");
    const restored = f.create(); await restored.load(); assert.equal(restored.get(id).scope, "org/repo");
    await assert.rejects(restored.testDraft({ ...draft, id, credential: "bad-secret-token" }), /401/);
    await f.integrations.items(id, "issue"); assert.equal(f.calls.at(-1)?.headers.get("PRIVATE-TOKEN"), draft.credential, "failed reconnect preserves working credentials");
    const second = await restored.testDraft({ ...draft, id, credential: "rotated-managed-token" }); await restored.connect(second.testId);
    assert.throws(() => f.integrations.resolveSource(source.id), /expired or is unknown/);
    await f.integrations.items(id, "issue"); assert.equal(f.calls.at(-1)?.headers.get("PRIVATE-TOKEN"), "rotated-managed-token");
    await assert.rejects(restored.disconnect("admin-gitlab"), /Administrator-managed/);
    await restored.disconnect(id); assert.equal(restored.bindings("p-first").length, 0);
    await assert.rejects(f.integrations.items(id, "issue"), /not found/);
    await f.integrations.items("admin-gitlab", "issue"); assert.equal(f.calls.at(-1)?.headers.get("PRIVATE-TOKEN"), "administrator-original-token");
  } finally { await f.clean(); }
});

test("connection tests are single-use and stale reconnect tests cannot replace newer credentials", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.connect("untrusted-test-id"), /Test this connection/);
    const checked = await f.store.testDraft(draft), { id } = await f.store.connect(checked.testId);
    await assert.rejects(f.store.connect(checked.testId), /Test this connection/);
    const a = await f.store.testDraft({ ...draft, id, credential: "first-replacement-token" });
    const b = await f.store.testDraft({ ...draft, id, credential: "stale-replacement-token" });
    await f.store.connect(a.testId); await assert.rejects(f.store.connect(b.testId), /Connection changed/);
    await f.integrations.items(id, "issue"); assert.equal(f.calls.at(-1)?.headers.get("PRIVATE-TOKEN"), "first-replacement-token");
    await assert.rejects(f.store.testDraft({ ...draft, baseUrl: "http://insecure.test" }), /HTTPS/);
    await assert.rejects(f.store.testDraft({ ...draft, baseUrl: "https://user:password@host.test" }), /credentials/);
  } finally { await f.clean(); }
});

test("notification connections start off, send only explicit tests, persist preferences, and disconnect pending deliveries", async () => {
  const f = await fixture();
  try {
    const before = f.calls.length;
    const checked = await f.store.testDraft({ provider: "webhook", name: "Team updates", url: "https://hooks.example.test/private?key=hidden-webhook-token", credential: "webhook-bearer-secret" });
    assert.match(checked.message, /use Send test notification/);
    const { id } = await f.store.connect(checked.testId, { projectId: "p-first", repository: "/local/repo" });
    assert.equal(f.calls.length, before); assert.equal(f.notifications.list().find(c => c.id === id)?.settings.enabled, false);
    await f.notifications.update(id, { enabled: true, events: ["done"], projects: ["p-first"] });
    const restored = f.create(); await restored.load(); assert.equal(f.notifications.list().find(c => c.id === id)?.settings.enabled, true);
    await f.notifications.test(id); await f.notifications.drain();
    assert.equal(f.calls.at(-1)?.headers.get("authorization"), "Bearer webhook-bearer-secret");
    assert.equal(f.notifications.deliveries()[0]?.state, "delivered");
    assert.doesNotMatch(JSON.stringify([f.store.list(), f.notifications.list(), f.notifications.deliveries()]), /hidden-webhook-token|webhook-bearer-secret|private\?/);
    await restored.disconnect(id); assert.equal(f.notifications.list().length, 0);
    // A disconnected destination's historical receipts must not break startup.
    await f.notifications.load([]); await f.create().load(); assert.equal(f.notifications.deliveries()[0]?.state, "delivered");
  } finally { await f.clean(); }
});

test("corrupt credential storage fails closed and is preserved", async () => {
  const f = await fixture();
  try {
    const checked = await f.store.testDraft(draft); await f.store.connect(checked.testId);
    const file = join(f.directory, "private/connections.enc"); await writeFile(file, "corrupt bytes");
    const next = f.create(); await assert.rejects(next.load(), /could not be opened/); assert.throws(() => next.list(), /unavailable/);
    assert.equal(await readFile(file, "utf8"), "corrupt bytes");
  } finally { await f.clean(); }
});

test("Git remote suggestions identify code hosts without disclosing embedded credentials", () => {
  assert.deepEqual(describeGitRemote("git@github.com:org/repo.git"), { provider: "github", scope: "org/repo", host: "github.com" });
  assert.deepEqual(describeGitRemote("https://user:token@gitlab.example.test/group/repo.git?private=value"), { provider: "gitlab", scope: "group/repo", host: "gitlab.example.test" });
  assert.equal(describeGitRemote("/local/private/repository"), undefined);
  assert.equal(describeGitRemote("javascript:alert(1)"), undefined);
});
