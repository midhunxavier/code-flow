import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedAccounts } from "../src/shared-accounts.js";
import { parseTeamAddress, teamConnectionLink } from "../ui/team-join-link.js";

const credentials = { username: "teammate", displayName: "Team mate", password: "my own strong passphrase", secure: true, loopback: false, address: "192.0.2.1" };
async function fixture(fn: (store: SharedAccounts, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-invitation-")), file = join(dir, "accounts.json");
  try { const store = new SharedAccounts(file); await store.load(); await fn(store, file); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("an invitation survives restart, accepts once, grants only its project and never persists either token", async () => fixture(async (store, file) => {
  const invite = await store.invite({ projectId: "p-design", role: "contributor" });
  assert.equal(store.hasUsers, false); assert.equal(store.hasInvitations, true);
  assert.equal(JSON.stringify(store.invitations()).includes(invite.token), false);
  const loaded = new SharedAccounts(file); await loaded.load();
  assert.equal(loaded.previewInvitation(invite.token).role, "contributor");
  const accepted = await loaded.acceptInvitation({ ...credentials, token: invite.token });
  assert.deepEqual(accepted.user.roles, { "p-design": "contributor" });
  assert.deepEqual(loaded.authenticate(accepted.token)?.roles, accepted.user.roles);
  assert.ok(loaded.invitations()[0]?.acceptedAt);
  for (const secret of [invite.token, accepted.token, credentials.password]) assert.equal((await readFile(file, "utf8")).includes(secret), false);
  await assert.rejects(loaded.acceptInvitation({ ...credentials, username: "another", token: invite.token }), /expired, was used, or was revoked/);
  assert.equal(loaded.snapshot().users.length, 1);
}));

test("concurrent acceptance is atomic and failed validation leaves the invitation usable", async () => fixture(async (store) => {
  const { token } = await store.invite({ projectId: "p-one", role: "reviewer" });
  await assert.rejects(store.acceptInvitation({ ...credentials, token, password: "short" }), /15 characters/);
  const attempts = await Promise.allSettled(["alice", "bob"].map(username => store.acceptInvitation({ ...credentials, token, username })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(store.snapshot().users.length, 1);
}));

test("existing members prove their password, preserve other projects and never downgrade access", async () => fixture(async (store) => {
  const user = await store.create({ ...credentials, revision: 0, roles: { "p-one": "maintainer", "p-two": "reviewer" } });
  const signed = await store.login(credentials);
  const { token } = await store.invite({ projectId: "p-one", role: "contributor" });
  await assert.rejects(store.acceptInvitation({ ...credentials, token, existing: true, password: "wrong" }), /Invalid username or password/);
  await assert.rejects(store.acceptInvitation({ ...credentials, token }), /already in use/);
  const result = await store.acceptInvitation({ ...credentials, token, existing: true });
  assert.equal(result.user.id, user.users[0]!.id);
  assert.deepEqual(result.user.roles, { "p-one": "maintainer", "p-two": "reviewer" });
  assert.equal(store.authenticate(signed.token), undefined, "membership changes revoke old sessions");
  const next = await store.invite({ projectId: "p-three", role: "contributor" });
  const added = await store.acceptInvitation({ ...credentials, token: next.token, existing: true });
  assert.deepEqual(added.user.roles, { "p-one": "maintainer", "p-two": "reviewer", "p-three": "contributor" });
}));

test("expiry, revocation, plaintext, invalid roles and corrupt invitation storage fail closed", async () => fixture(async (store, file) => {
  await assert.rejects(store.invite({ projectId: "p-one", role: "owner" }), /viewer, reviewer/);
  const first = await store.invite({ projectId: "p-one", role: "viewer" });
  await assert.rejects(store.acceptInvitation({ ...credentials, token: first.token, secure: false }), /HTTPS/);
  await store.revokeInvitation(first.invitation.id);
  await assert.rejects(store.acceptInvitation({ ...credentials, token: first.token }), /revoked/);
  const second = await store.invite({ projectId: "p-one", role: "viewer" });
  const state = JSON.parse(await readFile(file, "utf8"));
  const record = state.invitations.find((entry: { id: string }) => entry.id === second.invitation.id);
  record.createdAt = Date.now() - 25 * 60 * 60_000; record.expiresAt = record.createdAt + 24 * 60 * 60_000;
  await writeFile(file, JSON.stringify(state));
  const expired = new SharedAccounts(file); await expired.load(); assert.throws(() => expired.previewInvitation(second.token), /expired/);
  record.role = "owner"; await writeFile(file, JSON.stringify(state));
  await assert.rejects(new SharedAccounts(file).load(), /left untouched/);
}));

test("old account documents remain readable and connection hints reject credential and pairing links", async () => fixture(async (store, file) => {
  await store.create({ ...credentials, revision: 0, roles: {} });
  const old = JSON.parse(await readFile(file, "utf8")); delete old.invitations; await writeFile(file, JSON.stringify(old));
  const loaded = new SharedAccounts(file); await loaded.load(); assert.equal(loaded.snapshot().users.length, 1);
  assert.deepEqual(parseTeamAddress(teamConnectionLink("https://hub.example:4318", "alice")), { url: "https://hub.example:4318", username: "alice" });
  const link = `https://hub.example/#/join/${"x".repeat(43)}`; assert.equal(parseTeamAddress(link).invitation, link);
  assert.equal(parseTeamAddress("http://localhost:4317").url, "http://localhost:4317");
  for (const value of ["javascript:alert(1)", "http://hub.example", "https://user:pass@hub.example", "https://hub.example/r/secret", "https://hub.example/?token=owner", "https://hub.example/#/join/short"]) assert.throws(() => parseTeamAddress(value));
}));
