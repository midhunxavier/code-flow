import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SharedAccounts, SharedAccountError, SHARED_ROLES, roleAtLeast, type SharedRole } from "../src/shared-accounts.js";
import { SHARED_ROLES as UI_SHARED_ROLES, roleAtLeast as uiRoleAtLeast } from "../ui/shared-roles.js";

const password = "a sufficiently long password 🦉";
const input = { revision: 0, username: "Alice.Reviewer", displayName: "Alice", password, roles: { "p-one": "reviewer" } };
const login = (store: SharedAccounts, overrides = {}) => store.login({ username: input.username, password, address: "127.0.0.1", secure: false, loopback: true, ...overrides });
async function fixture(fn: (store: SharedAccounts, file: string, dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), "codeflow-shared-")); const file = join(dir, "shared-accounts.json"); const store = new SharedAccounts(file); try { await store.load(); await fn(store, file, dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test("shared accounts persist only versioned scrypt hashes and opaque session hashes with private modes", async () => fixture(async (store, file) => {
  const state = await store.create(input); assert.equal(state.revision, 1); assert.equal(state.users[0]!.username, "alice.reviewer"); assert.equal("password" in state.users[0]!, false);
  const signed = await login(store); const source = await readFile(file, "utf8"); assert.equal(source.includes(password), false); assert.equal(source.includes(signed.token), false);
  const stored = JSON.parse(source); assert.deepEqual({ ...stored.users[0].password, salt: "salt", hash: "hash" }, { algorithm: "scrypt", N: 131072, r: 8, p: 1, salt: "salt", hash: "hash" }); assert.match(stored.users[0].password.salt, /^[a-f0-9]{32}$/); assert.match(stored.users[0].password.hash, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  const loaded = new SharedAccounts(file); await loaded.load(); const identity = loaded.authenticate(signed.token)!; assert.equal(identity.kind, "shared"); assert.equal(identity.roles["p-one"], "reviewer"); identity.roles["p-two"] = "reviewer"; assert.equal(loaded.authenticate(signed.token)!.roles["p-two"], undefined, "callers cannot mutate authoritative roles");
}));

test("management uses exact revisions and rejects unsafe role escalation or malformed identities", async () => fixture(async (store) => {
  await store.create(input);
  await assert.rejects(store.create(input), (error: unknown) => error instanceof SharedAccountError && error.status === 409);
  const user = store.snapshot().users[0]!;
  await assert.rejects(store.update(user.id, { revision: 1, roles: { "p-one": "owner" } }), /viewer, reviewer, contributor and maintainer/);
  await assert.rejects(store.update(user.id, { revision: 1, roles: JSON.parse('{"__proto__":"reviewer"}') }), /viewer, reviewer, contributor and maintainer/);
  await assert.rejects(store.create({ ...input, revision: 1, username: "ab" }), /3–64/);
  await assert.rejects(store.create({ ...input, revision: 1, username: "Owner" }), /The username owner is reserved for the server owner/);
  await assert.rejects(store.update(user.id, { revision: 1, password: "too short" }), /15 characters/);
  assert.equal(store.snapshot().revision, 1); assert.deepEqual(store.snapshot().users[0]!.roles, { "p-one": "reviewer" });
}));

test("permission edits, password resets, logout and owner revocation invalidate durable sessions", async () => fixture(async (store, file) => {
  await store.create(input); const first = await login(store); let changes = 0; store.onChange(() => changes++);
  const id = first.user.id; await store.update(id, { revision: 1, roles: { "p-one": "viewer" } }); assert.equal(store.authenticate(first.token), undefined); assert.equal(changes, 1);
  const second = await login(store); assert.equal(store.authenticate(second.token)!.roles["p-one"], "viewer");
  await store.logout(second.token); assert.equal(store.authenticate(second.token), undefined);
  const third = await login(store); await store.revokeSessions(id, { revision: 2 }); assert.equal(store.authenticate(third.token), undefined);
  const fourth = await login(store); await store.update(id, { revision: 3, password: "a replacement long password" }); assert.equal(store.authenticate(fourth.token), undefined);
  await assert.rejects(login(store), /Invalid username or password/);
  const fifth = await login(store, { password: "a replacement long password" }); await store.update(id, { revision: 4, enabled: false }); assert.equal(store.authenticate(fifth.token), undefined);
  const reloaded = new SharedAccounts(file); await reloaded.load(); assert.equal(reloaded.authenticate(fifth.token), undefined); await assert.rejects(login(reloaded, { password: "a replacement long password" }), /Invalid username or password/);
}));

test("sessions enforce idle and absolute expiry; remote plaintext sign-in is refused", async () => fixture(async (store, file) => {
  await store.create(input); await assert.rejects(login(store, { loopback: false, address: "192.0.2.20" }), (error: unknown) => error instanceof SharedAccountError && error.status === 403);
  const first = await login(store), second = await login(store); const sessions = JSON.parse(await readFile(file, "utf8")).sessions as { createdAt: number }[]; const created = Math.max(...sessions.map((session) => session.createdAt));
  assert.ok(store.authenticate(first.token, { now: created + 20 * 60_000, touch: false }), "stream validation can check an active session without extending idle time");
  assert.equal(store.authenticate(first.token, created + 30 * 60_000), undefined);
  assert.equal(store.authenticate(second.token, second.expiresAt), undefined);
  assert.equal(store.authenticate("invalid"), undefined);
}));

test("login uses generic failures and bounded per-user attempts without an unbounded expensive queue", async () => fixture(async (store) => {
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(login(store, { username: "unknown-user" }), (error: unknown) => error instanceof SharedAccountError && error.status === 401 && error.message === "Invalid username or password");
  await assert.rejects(login(store, { username: "unknown-user", address: "192.0.2.44" }), (error: unknown) => error instanceof SharedAccountError && error.status === 429);
  const results = await Promise.allSettled(["one", "two", "three"].map((username, index) => login(store, { username, address: `192.0.2.${index}` })));
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof SharedAccountError && result.reason.status === 429).length, 1);
}));

test("account corruption and symbolic storage fail closed without being reset; failed writes recover", async () => fixture(async (store, file, dir) => {
  await mkdir(file); await assert.rejects(store.create(input), /non-regular/); assert.equal(store.snapshot().revision, 0);
  await rm(file, { recursive: true }); await store.create(input); const source = await readFile(file, "utf8");
  await writeFile(file, "{broken"); const broken = new SharedAccounts(file); await assert.rejects(broken.load(), /left untouched/); assert.equal(broken.available, false); assert.equal(broken.authenticate("a".repeat(43)), undefined); assert.equal(await readFile(file, "utf8"), "{broken");
  await writeFile(file, source); await symlink(file, join(dir, "linked.json")); await assert.rejects(new SharedAccounts(join(dir, "linked.json")).load(), /left untouched/);
  const extra = JSON.parse(source); extra.users[0].privateCapability = "unexpected credential field"; await writeFile(file, JSON.stringify(extra)); await assert.rejects(new SharedAccounts(file).load(), /left untouched/, "unknown persisted fields cannot silently enter public account responses");
}));

test("contributor and maintainer rank above reviewer, are accepted and persisted, and the browser mirror of the role table agrees", async () => fixture(async (store, file) => {
  assert.deepEqual([...SHARED_ROLES], ["viewer", "reviewer", "contributor", "maintainer"]); assert.deepEqual([...UI_SHARED_ROLES], [...SHARED_ROLES], "ui/shared-roles.ts mirrors src/shared-accounts.ts");
  for (const [rank, role] of SHARED_ROLES.entries()) for (const [floor, needed] of SHARED_ROLES.entries()) { assert.equal(roleAtLeast(role, needed), rank >= floor, `${role} at least ${needed}`); assert.equal(uiRoleAtLeast(role, needed), rank >= floor, `ui/shared-roles.ts: ${role} at least ${needed}`); }
  for (const needed of SHARED_ROLES) { assert.equal(roleAtLeast(undefined, needed), false); assert.equal(roleAtLeast("owner" as SharedRole, needed), false); assert.equal(uiRoleAtLeast(undefined, needed), false); }
  const roles = { "p-one": "contributor", "p-two": "maintainer" }; const state = await store.create({ ...input, roles }); assert.deepEqual(state.users[0]!.roles, roles);
  await assert.rejects(store.update(state.users[0]!.id, { revision: 1, roles: { "p-one": "admin" } }), /viewer, reviewer, contributor and maintainer/); assert.deepEqual(store.snapshot().users[0]!.roles, roles);
  const reloaded = new SharedAccounts(file); await reloaded.load(); assert.deepEqual(reloaded.snapshot().users[0]!.roles, roles, "persisted roles reload");
  const signed = await login(reloaded); assert.equal(reloaded.authenticate(signed.token)!.roles["p-two"], "maintainer");
}));

test("verifyCredentials proves a password under the sign-in transport rule and limiter without creating a session", async () => fixture(async (store, file) => {
  await store.create(input); const sessions = async () => (JSON.parse(await readFile(file, "utf8")).sessions as unknown[]).length;
  const signed = await login(store); assert.equal(await sessions(), 1);
  const verify = (overrides = {}) => store.verifyCredentials({ username: input.username, password, address: "127.0.0.1", secure: false, loopback: true, ...overrides });
  const user = await verify(); assert.deepEqual(user, signed.user); assert.equal("password" in user, false);
  await assert.rejects(verify({ password: "a wrong but long enough password" }), (error: unknown) => error instanceof SharedAccountError && error.status === 401 && error.message === "Invalid username or password");
  await assert.rejects(verify({ loopback: false, address: "192.0.2.20" }), (error: unknown) => error instanceof SharedAccountError && error.status === 403);
  assert.equal((await verify({ loopback: false, secure: true, address: "192.0.2.20" })).id, signed.user.id, "HTTPS satisfies the transport rule away from this computer");
  assert.equal(await sessions(), 1, "verification never mints a session"); assert.ok(store.authenticate(signed.token), "and leaves existing sessions alone");
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(verify({ username: "unknown-user" }), /Invalid username or password/);
  await assert.rejects(login(store, { username: "unknown-user", address: "192.0.2.44" }), (error: unknown) => error instanceof SharedAccountError && error.status === 429, "sign-in and verification share one limiter");
  await store.update(signed.user.id, { revision: 1, enabled: false }); await assert.rejects(verify(), /Invalid username or password/);
}));
