import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationReviews } from "../src/collaboration-reviews.js";

test("human comments serialize, bind exact owned result commits and persist authenticated identity without dispatching agent notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-shared-comments-")); const store = new CollaborationReviews(dir); const head = "a".repeat(40), identity = { id: "shared:u-one", name: "Alice" };
  try {
    assert.equal((await store.list("run-one")).revision, 0);
    await assert.rejects(store.add("run-one", { branch: "result", expectedHead: head, text: "Stale comment" }, identity, async () => "b".repeat(40)), /commit changed/);
    const results = await Promise.all(["First review", "Second review"].map((text) => store.add("run-one", { branch: "result", expectedHead: head, text }, identity, async () => head)));
    assert.equal(results[1]!.revision, 2); assert.deepEqual(results[1]!.comments.map((comment) => comment.text), ["First review", "Second review"]); assert.deepEqual(results[1]!.comments[0]!.actor, identity);
    assert.equal((await new CollaborationReviews(dir).list("run-one")).comments.length, 2); assert.match(await readFile(join(dir, "shared-reviews/run-one.json"), "utf8"), /shared:u-one/);
    await store.add("run-one", { branch: "result", expectedHead: head, text: "password=private-value" }, identity, async () => head);
    const redacted = await store.add("run-one", { branch: "result", expectedHead: head, text: "A later comment" }, identity, async () => head);
    assert.equal(redacted.comments[2]!.text.includes("private-value"), false, "shared output is redacted");
    assert.equal(JSON.parse(await readFile(join(dir, "shared-reviews/run-one.json"), "utf8")).comments[2].text, "password=private-value", "later appends never rewrite an earlier comment through display redaction");
    let permissionChecks = 0;
    await assert.rejects(store.add("run-one", { branch: "result", expectedHead: head, text: "Revoked during save" }, identity, async () => head, () => { if (++permissionChecks === 2) throw new Error("Reviewer access revoked"); }), /access revoked/);
    assert.equal((await store.list("run-one")).comments.length, 4, "authorization is rechecked after fsync and before publishing a comment");
    await assert.rejects(store.add("../escape", { branch: "result", expectedHead: head, text: "Bad path" }, identity, async () => head), /run identity/);
    await assert.rejects(store.add("run-one", { branch: "result", expectedHead: head, text: "Bad identity" }, { id: "anonymous", name: "Fake" }, async () => head), /authenticated/);
    await writeFile(join(dir, "shared-reviews/run-one.json"), "not-json"); await assert.rejects(store.add("run-one", { branch: "result", expectedHead: head, text: "Keep corruption" }, identity, async () => head), /left untouched/); assert.equal(await readFile(join(dir, "shared-reviews/run-one.json"), "utf8"), "not-json");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
