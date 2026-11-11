import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationConnections, describeGitRemote } from "../src/integration-connections.js";
import { Notifications } from "../src/notifications.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "connection-store-")), calls: { url: string; headers: Headers; body?: string }[] = [];
  const fetcher = (async (input, options) => {
    const url = String(input), headers = new Headers(options?.headers); calls.push({ url, headers, body: options?.body as string });
    if (url.includes("hooks.example.test")) return new Response("ok");
    return Response.json([{ number: 7, title: "Issue fixture", body: "Untrusted source" }]);
  }) as typeof fetch;
  const notifications = new Notifications({ file: join(directory, "notifications.json"), environment: {}, fetch: fetcher }); await notifications.load([]);
  const create = () => new IntegrationConnections({ notifications, directory: join(directory, "private") });
  const store = create(); await store.load();
  return { directory, calls, notifications, store, create, clean: async () => { await notifications.stop(); await rm(directory, { recursive: true, force: true }); } };
}
const draft = { provider: "webhook" as const, name: "Team updates", url: "https://hooks.example.test/private?key=hidden-webhook-token", credential: "webhook-bearer-secret" };
const AAD = Buffer.from("code-flow-integrations-v1");
async function readState(directory: string) {
  const key = await readFile(join(directory, "private/master.key")), sealed = JSON.parse(await readFile(join(directory, "private/connections.enc"), "utf8"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64")); decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
}
async function writeState(directory: string, state: unknown) {
  const key = await readFile(join(directory, "private/master.key")), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  await writeFile(join(directory, "private/connections.enc"), JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
}

test("tested connection keeps secrets encrypted, retains project scope and reconnects", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.testDraft({ ...draft, url: "http://hooks.example.test/insecure" }), /HTTPS/);
    await assert.rejects(f.store.testDraft({ provider: "gitlab" as any, name: "Removed", scope: "org/repo" }), /supported service/);
    assert.equal(f.store.list().length, 0);
    const test = await f.store.testDraft(draft);
    const { id } = await f.store.connect(test.testId, { projectId: "p-first", repository: "/local/repo" });
    assert.deepEqual(f.store.bindings("p-first"), [{ projectId: "p-first", repository: "/local/repo", connectionId: id }]);
    assert.equal(f.store.list().find(c => c.id === id)?.administratorManaged, false);
    assert.doesNotMatch(JSON.stringify(f.store.list()), /hidden-webhook-token|webhook-bearer-secret|credentialRef|urlRef|TOKEN/);
    assert.doesNotMatch(await readFile(join(f.directory, "private/connections.enc"), "utf8"), /hidden-webhook-token|Team updates/);
    assert.equal((await stat(join(f.directory, "private/master.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, "private/connections.enc"))).mode & 0o777, 0o600);
    const restored = f.create(); await restored.load(); assert.equal(restored.get(id).scope, "hooks.example.test");
    await assert.rejects(restored.testDraft({ ...draft, id, url: "https://hooks.slack.com.example.test/" , provider: "slack" }), /same service/);
    const second = await restored.testDraft({ ...draft, id, url: undefined, credential: "rotated-bearer-secret" }); await restored.connect(second.testId);
    await f.notifications.test(id); await f.notifications.drain();
    assert.equal(f.calls.at(-1)?.headers.get("authorization"), "Bearer rotated-bearer-secret", "an empty URL keeps the saved destination while the token rotates");
    assert.match(f.calls.at(-1)!.url, /hidden-webhook-token/);
    await restored.disconnect(id); assert.equal(restored.bindings("p-first").length, 0);
    assert.equal(f.notifications.list().length, 0);
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
    await f.notifications.test(id); await f.notifications.drain();
    assert.equal(f.calls.at(-1)?.headers.get("authorization"), "Bearer first-replacement-token");
    await assert.rejects(f.store.testDraft({ ...draft, url: "https://user:password@hooks.example.test/" }), /credentials/);
    await assert.rejects(f.store.testDraft({ provider: "slack", name: "Slack", url: "https://hooks.example.test/not-slack" }), /Slack incoming webhook/);
  } finally { await f.clean(); }
});

test("notification connections start off, send only explicit tests, persist preferences, and disconnect pending deliveries", async () => {
  const f = await fixture();
  try {
    const before = f.calls.length;
    const checked = await f.store.testDraft(draft);
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

test("saved connections for removed services stay on disk, hidden and unused", async () => {
  const f = await fixture();
  try {
    const checked = await f.store.testDraft(draft); await f.store.connect(checked.testId);
    const state = await readState(f.directory);
    state.connections.push({ id: "connection-removed", name: "Old GitLab", provider: "gitlab", scope: "org/repo", baseUrl: "https://gitlab.example.test/api/v4/", auth: "private-token", credentialRef: "secret-old", usernameRef: "secret-old-user", updatedAt: 1 });
    state.bindings.push({ projectId: "p-first", repository: "/local/repo", connectionId: "connection-removed" });
    Object.assign(state.secrets, { "secret-old": "old-gitlab-token", "secret-old-user": "old-user" });
    await writeState(f.directory, state);
    const next = f.create(); await next.load();
    assert.ok(!next.list().some(c => c.id === "connection-removed"));
    assert.throws(() => next.get("connection-removed"), /not found/);
    const another = await next.testDraft({ ...draft, name: "Second destination" }); await next.connect(another.testId);
    const saved = await readState(f.directory);
    assert.ok(saved.connections.some((c: any) => c.id === "connection-removed"), "the saved record is preserved");
    assert.equal(saved.secrets["secret-old"], "old-gitlab-token"); assert.equal(saved.secrets["secret-old-user"], "old-user");
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

test("Git remote suggestions identify GitHub without disclosing embedded credentials", () => {
  assert.deepEqual(describeGitRemote("git@github.com:org/repo.git"), { provider: "github", scope: "org/repo", host: "github.com" });
  assert.deepEqual(describeGitRemote("https://user:token@gitlab.example.test/group/repo.git?private=value"), { provider: undefined, scope: "group/repo", host: "gitlab.example.test" });
  assert.equal(describeGitRemote("/local/private/repository"), undefined);
  assert.equal(describeGitRemote("javascript:alert(1)"), undefined);
});
