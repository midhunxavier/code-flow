import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effect } from "@preact/signals";

const home = mkdtempSync(join(tmpdir(), "codeflow-qa-side-unit-"));
process.env.CODEFLOW_HOME = home;
const storage = new Map<string, string>(), session = new Map<string, string>();
const memoryStore = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
Object.assign(globalThis, { window: { addEventListener() {} }, location: { hash: "", search: "" }, document: { documentElement: { dataset: {} } }, localStorage: memoryStore(storage), sessionStorage: memoryStore(session) });
const notes = await import("../ui/notes-draft.js");
const terminal = await import("../ui/terminal-memory.js");
const theme = await import("../ui/theme.js");
const git = await import("../src/git.js");
after(() => rmSync(home, { recursive: true, force: true }));

test("draft recovery distinguishes an unchanged base, changed text, legacy text, and a completed save", () => {
  const base = { text: "saved", revision: 4 };
  const draft = notes.writeNoteDraft("repo", "offline", base);
  assert.deepEqual(notes.readNoteDraft("repo"), draft);
  assert.equal(notes.noteDraftConflicts(draft, base), false);
  assert.equal(notes.noteDraftConflicts(draft, { text: "phone", revision: 5 }), true);
  assert.equal(notes.noteDraftConflicts(draft, { text: "different same revision", revision: 4 }), true);
  assert.equal(notes.noteDraftConflicts(draft, { text: "offline", revision: 5 }), false);
  for (const text of ["legacy", "", '{"some":"JSON"}']) {
    const legacy = notes.parseNoteDraft(text)!;
    assert.equal(legacy.text, text); assert.equal(notes.noteDraftConflicts(legacy, base), true);
  }
  notes.writeNoteDraft("unknown", "new text"); assert.equal(notes.readNoteDraft("unknown")?.text, "new text");
});
test("save errors keep their existing punctuation", () => {
  assert.equal(notes.sentence("Can't reach code-flow. Is the server still running?"), "Can't reach code-flow. Is the server still running?");
  assert.equal(notes.sentence("Too long"), "Too long."); assert.equal(notes.sentence("Done. "), "Done.");
});
test("line-shell history isolates worktrees, rereads concurrent writes, deduplicates and caps", () => {
  const places = [{ path: "/repo" }, { path: "/repo/worktree" }];
  const a = terminal.terminalHistoryKey("/repo/sub", places), b = terminal.terminalHistoryKey("/repo/worktree/sub", places);
  assert.notEqual(a, b); assert.equal(terminal.terminalHistoryKey("/repository", places), "termHistory:/repository");
  terminal.pushTerminalHistory(a, "one"); terminal.pushTerminalHistory(b, "other"); terminal.pushTerminalHistory(a, "two"); terminal.pushTerminalHistory(a, "one");
  assert.deepEqual(terminal.loadTerminalHistory(a), ["one", "two"]); assert.deepEqual(terminal.loadTerminalHistory(b), ["other"]);
  for (let i = 0; i < 110; i++) terminal.pushTerminalHistory(a, String(i));
  assert.equal(terminal.loadTerminalHistory(a).length, 100);
});
test("terminal session cache keeps bounded output and remembered folder then clears on close", () => {
  const shell = { id: "fixture", cwd: "/repo/sub", shell: "/bin/sh", status: "running", startedAt: 1, busy: false, interactive: true } as const;
  terminal.rememberTerminal(shell, [{ type: "output", text: "x".repeat(300000) }]);
  assert.equal(terminal.terminalMemory(shell.id)?.shell.cwd, "/repo/sub");
  assert.ok(JSON.stringify(terminal.terminalMemory(shell.id)).length < 201000);
  terminal.forgetTerminal(shell.id); assert.equal(terminal.terminalMemory(shell.id), undefined);
});
test("terminal theme subscribers observe the new stylesheet on every toggle", () => {
  const seen: string[][] = [];
  const dispose = effect(() => { seen.push([theme.theme.value, document.documentElement.dataset.theme!]); });
  theme.setTheme("dark"); theme.setTheme("light"); dispose();
  assert.ok(seen.length >= 3); for (const [signal, css] of seen) assert.equal(signal, css);
});
test("snapshot warnings name commits, tracked edits, new files and changed/deleted untracked files without undoing", async () => {
  const repo = mkdtempSync(join(home, "repo-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  run("init", "-q", "-b", "main"); run("config", "user.name", "test"); run("config", "user.email", "test@example.test");
  writeFileSync(join(repo, "README.md"), "initial\n"); run("add", "."); run("commit", "-qm", "initial");
  writeFileSync(join(repo, "kept.txt"), "before"); writeFileSync(join(repo, "deleted.txt"), "before");
  const snap = await git.snapshot(repo, repo);
  writeFileSync(join(repo, "README.md"), "changed\n"); writeFileSync(join(repo, "kept.txt"), "after"); rmSync(join(repo, "deleted.txt")); writeFileSync(join(repo, "sneaky.txt"), "left in place");
  const changes = await git.changedSince(repo, { path: repo }, snap);
  assert.deepEqual(changes, ['edits: "README.md"', '1 new file: "sneaky.txt"', '2 untracked files changed: "deleted.txt", "kept.txt"']);
  assert.equal(readFileSync(join(repo, "sneaky.txt"), "utf8"), "left in place");
  run("add", "README.md"); run("commit", "-qm", "commit");
  assert.match((await git.changedSince(repo, { path: repo }, snap))[0]!, /commits: "README.md"/);
});
test("warning path formatting quotes controls and bounds noisy changes", () => {
  const text = git.describeChangedPaths("files", ["a\nforged", 'b"quote', "c\u001bescape", ...Array.from({ length: 10 }, (_, i) => `z${i}`)]);
  assert.ok(!/[\n\x1b]/.test(text)); assert.match(text, /a\\nforged/); assert.match(text, /and 5 more/);
});
