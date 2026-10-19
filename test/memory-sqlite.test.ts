import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type MemoryInput } from "../src/memory.js";
import { createEncryptedBackup, restoreEncryptedBackup } from "../src/maintenance.js";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "codeflow-sqlite-")); directories.push(home);
  return { home, store: new MemoryStore(join(home, "memory.sqlite")) };
}
const repo = "/project", projectId = "project";
const user = { kind: "user" as const, repo, projectId };
const query = { repo, projectId, scope: "project" as const };
const input = (patch: Partial<MemoryInput> = {}): MemoryInput => ({ ...query, title: "Authentication", body: "Validate credentials", ...patch });
function sql<T>(file: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try { return action(db); } finally { db.close(); }
}

test("legacy import verifies every record, survives restart, and retires rollback copies before edits", async () => {
  const original = await fixture(), destination = await fixture();
  const accepted = await original.store.propose(input({ paths: ["src/auth.ts"] }), user);
  const proposal = await original.store.propose(input({ title: "Untrusted observation", derivedFrom: [{ id: accepted.id, revision: 1 }] }),
    { kind: "run", repo, projectId, runId: "external", sourceTrust: "untrusted", lockedDown: true });
  const deleted = await original.store.propose(input({ title: "Old knowledge" }), user);
  await original.store.remove(deleted.id, deleted.revision, user);
  const entries = sql(original.store.file, (db) => db.prepare("SELECT document FROM memories ORDER BY rowid").all().map((row) => JSON.parse(String(row.document))));
  const body = JSON.stringify({ schemaVersion: 1, entries });
  const legacy = join(destination.home, "memory.json");
  await writeFile(legacy, body);
  const migrated = new MemoryStore(legacy);
  await migrated.load();
  assert.equal(await readFile(`${legacy}.pre-sqlite`, "utf8"), body);
  assert.deepEqual(await readdir(destination.home), ["memory.json.pre-sqlite", "memory.sqlite"]);
  assert.deepEqual(sql(migrated.file, (db) => db.prepare("SELECT document FROM memories ORDER BY rowid").all().map((row) => JSON.parse(String(row.document)))), entries);
  const restored = new MemoryStore(migrated.file);
  assert.equal((await restored.list(query, user)).find((entry) => entry.id === proposal.id)!.status, "proposed");
  assert.ok((await restored.graph(query, user)).relationships.some((edge) => edge.relation === "derived_from"));
  await restored.revise(accepted.id, accepted.revision, { body: "Updated rule" }, user);
  assert.deepEqual(await readdir(destination.home), ["memory.sqlite"]);
  assert.equal((await new MemoryStore(legacy).list(query, user)).find((entry) => entry.id === accepted.id)!.revision, 2);
});

test("interrupted import finalization resumes without duplicate records; changed legacy files fail closed", async () => {
  const { home, store } = await fixture();
  const entry = await store.propose(input(), user);
  const raw = JSON.stringify({ schemaVersion: 1, entries: [entry] });
  // Reconstruct the state after the import transaction committed, before JSON was renamed.
  const { createHash } = await import("node:crypto");
  sql(store.file, (db) => db.prepare("INSERT INTO metadata VALUES('legacy_hash', ?)").run(createHash("sha256").update(raw).digest("hex")));
  await writeFile(join(home, "memory.json"), raw);
  await store.load();
  assert.equal((await store.list(query, user)).length, 1);
  await writeFile(join(home, "memory.json"), JSON.stringify({ schemaVersion: 1, entries: [] }));
  await assert.rejects(store.load(), /differs/);
  assert.equal(sql(store.file, (db) => db.prepare("SELECT count(*) AS n FROM memories").get()!.n), 1);
});

test("unsupported and corrupt SQLite databases are never reset", async () => {
  const { store } = await fixture(); await store.load();
  sql(store.file, (db) => db.exec("PRAGMA user_version=99"));
  await assert.rejects(store.propose(input(), user), /Unsupported/);
  assert.equal(sql(store.file, (db) => db.prepare("PRAGMA user_version").get()!.user_version), 99);
  await writeFile(store.file, "broken SQLite database");
  await assert.rejects(store.load(), /cannot be read/);
  assert.equal(await readFile(store.file, "utf8"), "broken SQLite database");
});

test("graph and keyword index commit atomically with the memory revision", async () => {
  const { store } = await fixture();
  const entry = await store.propose(input({ paths: ["src/auth.ts"] }), user);
  const before = await store.graph(query, user);
  sql(store.file, (db) => db.exec("CREATE TRIGGER fail_graph BEFORE INSERT ON relationships BEGIN SELECT RAISE(ABORT, 'injected graph failure'); END"));
  await assert.rejects(store.revise(entry.id, 1, { body: "Unexpected replacement" }, user), /injected graph failure/);
  assert.deepEqual((await store.list(query, user))[0], entry);
  assert.deepEqual(await store.graph(query, user), before);
  assert.equal(sql(store.file, (db) => db.prepare("SELECT count(*) AS n FROM memory_terms WHERE term='unexpected'").get()!.n), 0);
});

test("graph ranking retrieves connected lessons without bypassing scope, approval or stale-source filters", async () => {
  const { store } = await fixture();
  const source = await store.propose(input(), user);
  const connected = await store.propose(input({ title: "Contract guard", body: "Run the regression suite", derivedFrom: [{ id: source.id, revision: 1 }] }), user);
  await store.propose(input({ title: "Unrelated", body: "Formatting guidelines" }), user);
  const outside = await store.propose(input({ title: "Forbidden path", body: "Authentication", paths: ["private"] }), user);
  const unapproved = await store.propose(input({ title: "Proposed", body: "Authentication" }), { kind: "import", repo, projectId });
  const result = await store.retrieve({ ...query, query: "authentication", maxEntries: 2 }, user);
  assert.deepEqual(result.entries.map((entry) => entry.id), [source.id, connected.id]);
  assert.match(result.manifest.included[1]!.reason, /connected/);
  assert.match(result.manifest.omitted.find((ref) => ref.id === outside.id)!.reason, /outside task paths/);
  assert.match(result.manifest.omitted.find((ref) => ref.id === unapproved.id)!.reason, /unaccepted/);
  await store.recordFeedback(source.id, 1, { rating: "stale" }, user);
  const next = await store.retrieve({ ...query, query: "authentication" }, user);
  assert.ok(!next.entries.some((entry) => entry.id === source.id));
  assert.ok(next.manifest.included.every((ref) => !ref.reason.includes("connected")));
});

test("graph never exposes private, cross-project, deleted or outdated source labels", async () => {
  const { store } = await fixture();
  const privateEntry = await store.propose(input({ scope: "private", runId: "r", memberId: "worker", title: "Private secret", paths: ["secret.txt"] }), user);
  const source = await store.propose(input({ title: "Current source", paths: ["auth.ts"], sourceRefs: [`commit:${"a".repeat(40)}`] }), user);
  await store.propose(input({ title: "Shared summary", derivedFrom: [{ id: privateEntry.id, revision: 1 }, { id: source.id, revision: 1 }] }), user);
  await store.propose(input({ projectId: "other", title: "Other project", paths: ["other.txt"] }), { kind: "user", repo, projectId: "other" });
  const graph = await store.graph(query, user);
  assert.doesNotMatch(JSON.stringify(graph), /Private secret|secret.txt|Other project|other.txt/);
  assert.ok(graph.entities.some((entity) => entity.kind === "commit"));
  assert.ok(graph.relationships.some((edge) => edge.relation === "derived_from"));
  const revision = await store.revise(source.id, 1, { title: "New source" }, user);
  assert.ok(!(await store.graph(query, user)).relationships.some((edge) => edge.relation === "derived_from"));
  await store.remove(source.id, revision.revision, user);
  assert.doesNotMatch(JSON.stringify(await store.graph(query, user)), /New source|Current source|auth.ts/);
});

test("deletion removes indexed terms and old text from the database file", async () => {
  const { home, store } = await fixture();
  const entry = await store.propose(input({ title: "UNIQUESECRETZEBRA", body: "UNIQUESECRETZEBRA ".repeat(300), paths: ["UNIQUEREDACTEDPATH.ts"] }), user);
  assert.equal(sql(store.file, (db) => db.prepare("SELECT count(*) AS n FROM memory_terms WHERE term='uniquesecretzebra'").get()!.n), 1);
  await store.remove(entry.id, entry.revision, user);
  assert.equal(sql(store.file, (db) => db.prepare("SELECT count(*) AS n FROM memory_terms").get()!.n), 0);
  assert.deepEqual(await store.graph(query, user), { entities: [], relationships: [], truncated: false });
  assert.doesNotMatch(await readFile(store.file, "utf8"), /UNIQUESECRETZEBRA|uniquesecretzebra|UNIQUEREDACTEDPATH/);
  assert.deepEqual(await readdir(home), ["memory.sqlite"]);
});

test("independent processes serialize SQLite writes without losing records", async () => {
  const { store } = await fixture();
  const imported = await store.propose(input(), user);
  await rm(store.file);
  await writeFile(store.file.replace(/\.sqlite$/, ".json"), JSON.stringify({ schemaVersion: 1, entries: [imported] }));
  const code = `import { MemoryStore } from './src/memory.ts'; const s=new MemoryStore(process.argv[1]);
    for(let i=0;i<8;i++) await s.propose(${JSON.stringify(input())},{kind:'user'});`;
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, store.file], { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject); child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run(), run(), run()]);
  assert.equal((await store.list(query, user)).length, 25, "the competing import happens exactly once");
});

test("offline encrypted backup restores SQLite memories, search and graph", async () => {
  const { home, store } = await fixture(), archive = await fixture();
  const entry = await store.propose(input({ paths: ["auth.ts"] }), user);
  const output = join(archive.home, "memory.cfb"), password = "memory backup test password";
  await createEncryptedBackup({ home, output, password });
  const destination = join(archive.home, "restored");
  await restoreEncryptedBackup({ input: output, destination, password });
  const restored = new MemoryStore(join(destination, "memory.sqlite"));
  assert.deepEqual(await restored.list(query, user), [entry]);
  assert.deepEqual(await restored.graph(query, user), await store.graph(query, user));
  assert.equal((await restored.retrieve({ ...query, paths: ["auth.ts"], query: "authentication" }, user)).entries[0]!.id, entry.id);
});

test("graph results are bounded and report omitted relationships", async () => {
  const { store } = await fixture();
  for (let index = 0; index < 17; index++) await store.propose(input({ title: `Module ${index}`, paths: Array.from({ length: 64 }, (_, path) => `module-${index}/file-${path}.ts`) }), user);
  const graph = await store.graph(query, user);
  assert.equal(graph.relationships.length, 1000);
  assert.equal(graph.truncated, true);
  const nodes = new Set(graph.entities.map((entity) => entity.id));
  assert.ok(graph.relationships.every((edge) => nodes.has(edge.from) && nodes.has(edge.to)));
});

test("Unicode keyword search is parameterized, weighted and transactionally refreshed", async () => {
  const { store } = await fixture();
  const title = await store.propose(input({ title: "Återställning", body: "Reset instructions" }), user);
  await store.propose(input({ title: "Other", body: "Återställning" }), user);
  const selected = await store.retrieve({ ...query, query: 'ÅTERSTÄLLNING "; DROP TABLE memories; --', maxEntries: 1 }, user);
  assert.equal(selected.entries[0]!.id, title.id);
  assert.equal((await store.list(query, user)).length, 2);
  await store.revise(title.id, 1, { title: "Replacement" }, user);
  assert.equal(sql(store.file, (db) => db.prepare("SELECT count(*) AS n FROM memory_terms WHERE memory_id=? AND term='återställning'").get(title.id)!.n), 0);
});
