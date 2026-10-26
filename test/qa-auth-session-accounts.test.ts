import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "codeflow-qa-auth-unit-")); process.env.CODEFLOW_HOME = root;
const { SharedAccounts, SharedAccountError } = await import("../src/shared-accounts.js");
const { sharedCoverageProjection } = await import("../src/shared-access.js");
const { computerSetupLink } = await import("../ui/team-join-link.js");
after(() => rmSync(root, { recursive: true, force: true }));
const password = "qa fixture long password only";
const credentials = { username: "bob", password, address: "127.0.0.1", secure: false, loopback: true };
async function fixture() { const file = join(root, `${randomUUID()}.json`), store = new SharedAccounts(file); await store.load(); await store.create({ revision: 0, username: "bob", displayName: "Bob", password, roles: { project: "contributor" } }); return { file, store }; }
const status = (code: number) => (error: unknown) => error instanceof SharedAccountError && error.status === code;

test("successful logins and runner verification refund all limiter reservations", async () => {
  const { store } = await fixture();
  for (let i = 0; i < 25; i++) {
    const input = { ...credentials, username: i % 2 ? "BOB" : "bob" };
    if (i % 2) assert.equal((await store.verifyCredentials(input)).username, "bob");
    else assert.equal((await store.login(input)).user.username, "bob");
  }
  for (let i = 0; i < 8; i++) await assert.rejects(store.login({ ...credentials, password: "wrong" }), status(401));
  await assert.rejects(store.login(credentials), status(429));
});
test("new-account joins with a taken name do not spend that account's password budget", async () => {
  const { store } = await fixture();
  for (let i = 0; i < 7; i++) await assert.rejects(store.login({ ...credentials, password: "wrong" }), status(401));
  const invite = await store.invite({ projectId: "project", role: "viewer" });
  await assert.rejects(store.acceptInvitation({ ...credentials, displayName: "Stranger", token: invite.token }), status(409));
  assert.equal((await store.login(credentials)).user.username, "bob");
  assert.equal((await store.acceptInvitation({ ...credentials, token: invite.token, existing: true })).granted, false);
});
test("no-op invitations keep revision and other sessions, enforce eight-session cap, and consume once", async () => {
  const { store, file } = await fixture(); const original = await store.login(credentials);
  const first = await store.invite({ projectId: "project", role: "viewer" });
  const joined = await store.acceptInvitation({ ...credentials, token: first.token, existing: true });
  assert.equal(joined.granted, false); assert.equal(joined.user.revision, original.user.revision); assert.ok(store.authenticate(original.token));
  await assert.rejects(store.acceptInvitation({ ...credentials, token: first.token, existing: true }), status(410));
  for (let i = 0; i < 8; i++) { const invite = await store.invite({ projectId: "project", role: "viewer" }); await store.acceptInvitation({ ...credentials, token: invite.token, existing: true }); }
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sessions.length, 8);
  const live = await store.login(credentials), more = await store.invite({ projectId: "other", role: "reviewer" });
  const upgraded = await store.acceptInvitation({ ...credentials, token: more.token, existing: true });
  assert.equal(upgraded.granted, true); assert.equal(upgraded.user.revision, live.user.revision + 1); assert.equal(store.authenticate(live.token), undefined);
});
test("unreadable storage explains owner recovery without exposing paths to sign-in callers", async () => {
  const { store, file } = await fixture(); await store.login(credentials);
  const state = JSON.parse(readFileSync(file, "utf8")); state.sessions[0].lastSeenAt = state.sessions[0].createdAt - 1; writeFileSync(file, JSON.stringify(state));
  const broken = new SharedAccounts(file);
  await assert.rejects(broken.load(), /Invalid shared account session/);
  assert.throws(() => broken.snapshot(), error => status(503)(error) && (error as Error).message.includes(file));
  for (const attempt of [() => broken.login(credentials), () => broken.verifyCredentials(credentials), () => broken.acceptInvitation({ ...credentials, token: "x".repeat(43) })]) await assert.rejects(attempt(), error => status(503)(error) && !(error as Error).message.includes(root) && /temporarily unavailable/.test((error as Error).message));
  assert.throws(() => broken.previewInvitation("x".repeat(43)), error => status(503)(error) && !(error as Error).message.includes(root));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), state);
});
test("disabled accounts can be removed at the cap, with CAS and retryable access cleanup", async () => {
  const { store, file } = await fixture(); const session = await store.login(credentials);
  const raw = JSON.parse(readFileSync(file, "utf8")), original = raw.users[0];
  raw.users = [original, ...Array.from({ length: 127 }, (_, i) => ({ ...original, id: `u-${randomUUID()}`, username: `fixture-${i}` }))]; writeFileSync(file, JSON.stringify(raw));
  const full = new SharedAccounts(file); await full.load();
  const create = (username = "new-user") => full.create({ revision: full.snapshot().revision, username, displayName: "Replacement", password, roles: {} });
  await assert.rejects(create(), /At most 128/); await assert.rejects(full.remove(original.id, { revision: full.snapshot().revision }), /Disable the account/);
  await full.update(original.id, { revision: full.snapshot().revision, enabled: false }); await assert.rejects(create(), /At most 128/);
  await assert.rejects(full.remove(original.id, { revision: 0 }), status(409));
  await assert.rejects(full.remove(original.id, { revision: full.snapshot().revision }, async () => { throw new Error("cleanup unavailable"); }), /cleanup unavailable/);
  assert.equal(full.snapshot().users.length, 128);
  let cleaned = false; await full.remove(original.id, { revision: full.snapshot().revision }, async () => { cleaned = true; });
  assert.equal(cleaned, true); assert.equal(full.snapshot().users.length, 127); assert.equal(full.authenticate(session.token), undefined);
  await create("bob"); assert.equal(full.snapshot().users.length, 128); assert.notEqual(full.snapshot().users.find(user => user.username === "bob")!.id, original.id);
  const reloaded = new SharedAccounts(file); await reloaded.load(); assert.equal(reloaded.snapshot().users.some(user => user.id === original.id), false);
});
test("coverage preserves the uncommitted flag without exposing omitted file names", () => {
  const result = sharedCoverageProjection({ head: "a".repeat(40), files: [".env", "README.md"], reviewed: [], workingChanges: true });
  assert.equal(result.workingChanges, true); assert.deepEqual(result.files, ["README.md"]); assert.equal(result.omittedCount, 1);
});
test("computer handoff targets the narrow local interstitial and carries only connection hints", () => {
  const url = new URL(computerSetupLink("http://127.0.0.1:4359", "https://hub.example/#/connect?username=bob&project=project"));
  assert.equal(url.pathname, "/team-handoff"); assert.equal(url.search, ""); assert.match(url.hash, /^#\/settings\/connections\/join\?connection=/);
  assert.throws(() => computerSetupLink("https://evil.example", "https://hub.example/"));
});
