import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_NOTE_REVISIONS, Notes, NotesConflictError } from "../src/notes.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codeflow-notes-"));
  const file = join(directory, "notes.json");
  return { directory, file, notes: new Notes(file) };
}

test("simultaneous first writes and separate store instances preserve each repository", async () => {
  const { file, notes } = await fixture();
  const another = new Notes(file);
  await Promise.all([notes.set("/repo-a", "first", 0), notes.set("/repo-b", "second", 0), another.set("general", "scratch", 0)]);
  const reconstructed = new Notes(file);
  assert.equal((await reconstructed.get("/repo-a")).text, "first");
  assert.equal((await reconstructed.get("/repo-b/")).text, "second");
  assert.equal((await reconstructed.get("")).text, "scratch");
  assert.deepEqual((await reconstructed.keys()).map((note) => note.key).sort(), ["/repo-a", "/repo-b", "general"]);
});

test("concurrent stale writers cannot overwrite the winning revision", async () => {
  const { file, notes } = await fixture();
  const first = await notes.set("/repo", "initial", 0);
  const writes = await Promise.allSettled([notes.set("/repo", "one", first.revision), new Notes(file).set("/repo", "two", first.revision)]);
  const accepted = writes.filter((result) => result.status === "fulfilled");
  const rejected = writes.find((result) => result.status === "rejected");
  assert.equal(accepted.length, 1);
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof NotesConflictError);
  assert.equal(rejected.reason.current.revision, 2);
  assert.deepEqual(rejected.reason.current, await notes.get("/repo"));
  assert.equal((await notes.history("/repo")).length, 2);
});

test("save failures do not publish unsaved state or poison subsequent saves", { skip: process.getuid?.() === 0 }, async () => {
  const { directory, file, notes } = await fixture();
  const first = await notes.set("/repo", "saved", 0);
  await chmod(directory, 0o500);
  try {
    await assert.rejects(notes.set("/repo", "failed draft", first.revision));
    assert.deepEqual(await notes.get("/repo"), first);
  } finally { await chmod(directory, 0o700); }
  const saved = await notes.set("/repo", "retried", first.revision);
  assert.equal(saved.revision, 2);
  assert.deepEqual((await notes.history("/repo")).map((note) => note.text), ["retried", "saved"]);
  assert.deepEqual(await readdir(directory), ["notes.json"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("failed reads recover without silently replacing damaged notes", async () => {
  const { file, notes } = await fixture();
  await writeFile(file, "{broken");
  await assert.rejects(notes.set("/repo", "would destroy data"), /Notes store cannot be read/);
  assert.equal(await readFile(file, "utf8"), "{broken");
  await rm(file);
  assert.equal((await notes.set("/repo", "recovered", 0)).revision, 1);
});

test("note search finds current repository text and does not reveal erased historical text", async () => {
  const { notes } = await fixture();
  await notes.set("/project", "deployment procedure", 0);
  await notes.set("/other", "obsolete secret context", 0);
  await notes.set("/other", "", 1);
  assert.equal((await notes.search("deployment")).hits[0]?.key, "/project");
  assert.equal((await notes.search("project")).hits[0]?.revision, 1);
  assert.equal((await notes.search("obsolete")).hits.length, 0);
  assert.equal((await notes.history("/other")).length, 2, "history remains an explicitly separate feature");
});

test("legacy notes migrate while retaining their previous version for restore", async () => {
  const { file, notes } = await fixture();
  await writeFile(file, JSON.stringify({ "/repo": { text: "legacy", updatedAt: 100 } }));
  assert.deepEqual(await notes.get("/repo"), { text: "legacy", updatedAt: 100, revision: 1 });
  const next = await notes.set("/repo", "new", 1);
  const restored = await new Notes(file).restore("/repo", 1, next.revision);
  assert.equal(restored.text, "legacy");
  assert.equal(restored.revision, 3);
  assert.equal(restored.restoredFrom, 1);
  assert.deepEqual((await notes.history("/repo")).map((note) => note.revision), [3, 2, 1]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
});

test("deletion keeps a tombstone and revision history without exposing it as a live note", async () => {
  const { notes } = await fixture();
  await notes.set("/repo", "before deletion", 0);
  const deleted = await notes.set("/repo", "", 1);
  assert.equal(deleted.revision, 2);
  assert.deepEqual(await notes.keys(), []);
  await assert.rejects(notes.set("/repo", "stale client", 1), NotesConflictError);
  await assert.rejects(notes.restore("/repo", 1, 1), NotesConflictError);
  assert.equal((await notes.restore("/repo", 1, 2)).revision, 3);
  assert.equal((await notes.get("/repo")).text, "before deletion");
});

test("history is bounded, snapshots are independent, and old clients can still save", async () => {
  const { notes } = await fixture();
  for (let i = 1; i <= MAX_NOTE_REVISIONS + 3; i++) await notes.set("/repo", `version ${i}`);
  const history = await notes.history("/repo");
  assert.equal(history.length, MAX_NOTE_REVISIONS);
  assert.equal(history.at(-1)!.revision, 4);
  history[0]!.text = "mutated outside the store";
  assert.equal((await notes.get("/repo")).text, `version ${MAX_NOTE_REVISIONS + 3}`);
  await assert.rejects(notes.restore("/repo", 1, MAX_NOTE_REVISIONS + 3), /no longer available/);
  await assert.rejects(notes.set("/repo", "bad", -1), /revision/);
  await assert.rejects(notes.restore("/repo", 1, undefined as any), /current revision/);
});
