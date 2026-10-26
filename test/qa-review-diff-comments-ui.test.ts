// The Review page's diff logic, without a browser: what a diff with no lines says instead, where a
// draft comment goes after the branch moves (and what the agent is told), and who an Agent chat's
// comments go to. The UI is bundled the way build-ui does it and loaded with a stand-in window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import type { DiffFile } from "../src/ship.js";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const storage = new Map<string, string>();
let m: any;

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    innerWidth: 1400,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/" },
  });
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export { commentsMessage, diffNote, parsePatch, placeComments } from "./review.tsx";`,
        `export { chatProvider, resultAgent } from "./run-experience.ts";`,
      ].join("\n"),
      resolveDir: ui,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    loader: { ".png": "dataurl", ".svg": "dataurl" },
    logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-qa-review-ui-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
});

const diff = (patch: string, extra: Partial<DiffFile> = {}): DiffFile => ({ path: "README.md", status: "modified", additions: 0, deletions: 0, binary: false, patch, truncated: false, ...extra });
const note = (file: DiffFile) => m.diffNote(file, m.parsePatch(file.patch));

test("a diff with no lines to show says why instead of showing nothing", () => {
  assert.equal(note(diff("similarity index 100%\nrename from a.md\nrename to b.md\n", { path: "b.md", oldPath: "a.md", status: "renamed" })), "Renamed from a.md with no content changes.");
  assert.equal(note(diff("new file mode 100644\nindex 0000000..e69de29\n", { status: "added" })), "Empty file added.");
  assert.equal(note(diff("deleted file mode 100644\nindex e69de29..0000000\n", { status: "deleted" })), "Empty file deleted.");
  assert.equal(note(diff("old mode 100644\nnew mode 100755\n")), "No content changes; its mode changed from 100644 to 100755.");
  assert.match(note(diff("old mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from a.sh\nrename to b.sh\n", { status: "renamed", oldPath: "a.sh" })), /^Renamed from a\.sh with no content changes; its mode changed from 100644 to 100755\.$/);
  assert.equal(note(diff("", { binary: true })), "Binary file — no text diff.");
  assert.equal(note(diff("", { status: "added", additions: 1 })), "No text diff available for this file.");
  assert.equal(note(diff("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n")), undefined);
});

test("a file that changes type shows its deletion and its creation, not header lines as code", () => {
  const rows = m.parsePatch("deleted file mode 100644\nindex 1..0\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-plain\ndiff --git a/link b/link\nnew file mode 120000\nindex 0..2\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+base.txt\n\\ No newline at end of file\n");
  assert.deepEqual(rows.map((row: any) => [row.type, row.text]), [["hunk", "@@ -1 +0,0 @@"], ["del", "plain"], ["hunk", "@@ -0,0 +1 @@"], ["add", "base.txt"], ["note", "\\ No newline at end of file"]]);
});

const BEFORE = "--- a/README.md\n+++ b/README.md\n@@ -1,5 +1,5 @@\n # MQTT-MCP\n > from npm (requires uv)\n Usage\n Notes\n-old line\n+new line\n";
// Three lines inserted at the top: the commented line moves from 2 to 5, "inserted B" takes line 2.
const AFTER = "--- a/README.md\n+++ b/README.md\n@@ -1,5 +1,8 @@\n+inserted A\n+inserted B\n+inserted C\n # MQTT-MCP\n > from npm (requires uv)\n Usage\n Notes\n-old line\n+new line\n";
const GONE = "--- a/README.md\n+++ b/README.md\n@@ -1,5 +1,5 @@\n # MQTT-MCP\n-> from npm (requires uv)\n+> from PyPI\n Usage\n Notes\n-old line\n+new line\n";
const draft = { file: "README.md", side: "new" as const, line: 2, code: "> from npm (requires uv)", text: "Mention pip here" };

test("a draft comment follows its code when the branch moves, and is never put on the line that took its number", () => {
  const placedBefore = m.placeComments(m.parsePatch(BEFORE), [draft]);
  const rowBefore = m.parsePatch(BEFORE)[[...placedBefore.at.keys()][0]];
  assert.equal(rowBefore.new, 2);

  const after = m.parsePatch(AFTER);
  const placed = m.placeComments(after, [draft]);
  assert.deepEqual(placed.elsewhere, []);
  const [index] = [...placed.at.keys()];
  assert.equal(after[index].text, "> from npm (requires uv)");
  assert.equal(after[index].new, 5);
  assert.notEqual(after[index].text, "inserted B");
  assert.match(m.commentsMessage([draft], "", [diff(AFTER)]), /^1\. README\.md:5 — `> from npm \(requires uv\)`\n {3}Mention pip here$/);

  // Its code is gone: listed apart, and the agent is told where it was rather than pointed at line 2.
  const gone = m.placeComments(m.parsePatch(GONE), [draft]);
  assert.equal(gone.at.size, 0);
  assert.deepEqual(gone.elsewhere, [draft]);
  const message = m.commentsMessage([draft], "Also update docs", [diff(GONE)]);
  assert.doesNotMatch(message, /README\.md:2/);
  assert.match(message, /README\.md \(was line 2; that code has changed or is no longer in the diff\)/);
  assert.match(message, /General: Also update docs$/);
  // On a file the branch no longer changes, too.
  assert.match(m.commentsMessage([draft], "", []), /README\.md \(was line 2;/);
  // Without the diff (it couldn't load), the line the comment was written on.
  assert.match(m.commentsMessage([draft]), /^1\. README\.md:2 — /);
  // The Changes tab's "Last step" view and the whole branch's diff list the file once each: a draft
  // on a line only one of them shows still names that line.
  const lastStep = "@@ -7,2 +7,3 @@\n More\n+Step line\n End\n";
  const onStep = { file: "README.md", side: "new" as const, line: 8, code: "Step line", text: "Explain" };
  assert.match(m.commentsMessage([onStep], "", [diff(AFTER), diff(lastStep)]), /^1\. README\.md:8 — `Step line`/);
});

test("a removed-line draft stays on its removed line, nearest first when the code repeats", () => {
  const patch = "@@ -1,4 +1,2 @@\n-}\n a\n-}\n b\n";
  const removed = { file: "README.md", side: "old" as const, line: 3, code: "}", text: "Keep this brace" };
  const rows = m.parsePatch(patch);
  const [index] = [...m.placeComments(rows, [removed]).at.keys()];
  assert.equal(rows[index].type, "del");
  assert.equal(rows[index].old, 3);
});

test("an Agent chat's comments go to its provider, known from the run summary alone", () => {
  assert.equal(m.chatProvider({ pattern: "solo", roles: { agent: ["codex"] } }), "codex");
  assert.equal(m.chatProvider({ pattern: "solo", conversationAgent: "agy", roles: { agent: ["codex"] } }), "agy");
  assert.equal(m.chatProvider({ pattern: "council", roles: { reviewer: ["claude"] } }), undefined);
  assert.equal(m.chatProvider(undefined), undefined);
  // A team run's recipient waits for its steps: a review council has no writer, so nobody is chosen for you.
  assert.equal(m.resultAgent({ pattern: "council", roles: {}, steps: [{ kind: "agent", agent: "claude", worktree: "review", mode: "read" }] }, "review"), undefined);
});
