// The UI's chat views, without a browser: the comment drafts the Review page and the Changes tab
// share, the steps a run's timeline and conversation show (not side chats'), a Single-agent
// thread's line for a side chat's change, and which snapshot a side chat is shown from while its
// stream replays. The UI is bundled the way build-ui does it and loaded with a stand-in window.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const storage = new Map<string, string>();
const listeners: Record<string, ((e: unknown) => void)[]> = {};
let m: any;

before(async () => {
  Object.assign(globalThis, {
    window: globalThis,
    innerWidth: 1400,
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, String(v)), removeItem: (k: string) => storage.delete(k) },
    location: { hostname: "localhost", hash: "", origin: "http://localhost", pathname: "/" },
  });
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export { changeCommentDrafts, commentDrafts } from "./review.tsx";`,
        `export { ChatThread, teamSteps } from "./run.tsx";`,
        `export { sideChatIn } from "./side-chat.tsx";`,
        `export { effect } from "@preact/signals";`,
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
    loader: { ".png": "dataurl" },
    logLevel: "error",
  });
  const file = join(mkdtempSync(join(tmpdir(), "codeflow-chat-views-")), "ui.mjs");
  writeFileSync(file, out.outputFiles[0]!.text);
  m = await import(pathToFileURL(file).href);
});

/** Another window (a popped-out panel) wrote to localStorage. */
const fromAnotherWindow = (key: string | null, value?: string) => {
  if (key === null) storage.clear();
  else if (value !== undefined) storage.set(key, value);
  for (const fn of listeners.storage ?? []) fn({ key, newValue: value ?? null });
};

const comment = (line: number, text: string) => ({ file: "src/a.ts", side: "new" as const, line, code: `line ${line}`, text });

test("comment drafts: the Review page and the Changes tab show one copy, so a sent comment isn't sent again and none is lost", () => {
  const key = "comments:r1:codeflow/r1/claude";
  storage.set(key, JSON.stringify([comment(1, "c1")]));
  // The two views, each re-reading the drafts when they change, as a component does.
  let review: any[] = [];
  let changes: any[] = [];
  const stopReview = m.effect(() => (review = m.commentDrafts(key)));
  const stopChanges = m.effect(() => (changes = m.commentDrafts(key)));
  try {
    assert.deepEqual(review.map((c) => c.text), ["c1"]);
    assert.deepEqual(changes.map((c) => c.text), ["c1"]);

    // Added in one, shown in both, and kept across visits.
    m.changeCommentDrafts(key, (now: any[]) => [...now, comment(2, "c2")]);
    assert.deepEqual(changes.map((c) => c.text), ["c1", "c2"]);
    assert.deepEqual(review.map((c) => c.text), ["c1", "c2"]);
    assert.deepEqual(JSON.parse(storage.get(key)!).map((c: any) => c.text), ["c1", "c2"]);

    // Sent from the Review page: the Changes tab has nothing left to send.
    m.changeCommentDrafts(key, () => []);
    assert.equal(changes.length, 0);

    // Added in the Review page, then in the Changes tab: both are there.
    m.changeCommentDrafts(key, (now: any[]) => [...now, comment(3, "c3")]);
    m.changeCommentDrafts(key, (now: any[]) => [...now, comment(4, "c4")]);
    assert.deepEqual(review.map((c) => c.text), ["c3", "c4"]);

    // A popped-out panel added one: it comes in, and what's added here afterwards goes on top of it.
    fromAnotherWindow(key, JSON.stringify([comment(3, "c3"), comment(4, "c4"), comment(5, "c5")]));
    assert.deepEqual(changes.map((c) => c.text), ["c3", "c4", "c5"]);
    m.changeCommentDrafts(key, (now: any[]) => [...now, comment(6, "c6")]);
    assert.deepEqual(review.map((c) => c.text), ["c3", "c4", "c5", "c6"]);

    // Remove takes the comment a view shows, also after the drafts were read again.
    const shown = changes[0];
    m.changeCommentDrafts(key, (now: any[]) => now.filter((x) => x !== shown));
    assert.deepEqual(review.map((c) => c.text), ["c4", "c5", "c6"]);

    // Another branch's drafts are their own.
    assert.deepEqual(m.commentDrafts("comments:r1:other"), []);

    // Storage cleared in another window: nothing left here either.
    fromAnotherWindow(null);
    assert.equal(review.length, 0);
  } finally {
    stopReview();
    stopChanges();
  }
});

const step = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "agent",
  title: `Turn ${id}`,
  role: "agent",
  agent: "claude",
  mode: "write",
  worktree: "agent-1",
  status: "done",
  startedAt: 1000,
  endedAt: 1500,
  ...extra,
});
const sideTurn = (id: string, mode: "ask" | "change", extra: Record<string, unknown> = {}) => ({
  id,
  kind: "side",
  side: { chat: "c1", mode, title: "Edge cases" },
  worktree: "agent-1",
  agent: "codex",
  message: "and the empty list?",
  status: "done",
  at: 2000,
  ...extra,
});
const chatRun = (followUps: unknown[]) => ({
  id: "r1",
  status: "done",
  roles: { agent: ["claude"] },
  followUps,
  notes: [],
  worktrees: [{ name: "agent-1", branch: "codeflow/r1/claude", path: "/tmp/r1" }],
  lastCheck: { ok: true, command: "npm test", worktree: "agent-1", at: 1600 },
});
const runData = (steps: any[]) => ({ steps: new Map(steps.map((s) => [s.id, s])), events: new Map(), built: new Map(), logs: [], seen: new Set(), runSeq: 0, stepSeq: new Map(), epoch: "" });

test("teamSteps leaves out side chats' turns, also before the run says whose they are, and the checks after them", () => {
  const run = chatRun([sideTurn("f1", "change", { stepId: "s2" })]);
  const steps = [
    step("s1"),
    step("s2", { role: "side chat", title: "Side chat: Edge cases", agent: "codex" }),
    // A turn that just started: its step is here before the snapshot that links it to its follow-up.
    step("s3", { role: "side chat", title: "Side chat: Another" }),
    step("s4", { kind: "check", role: "check", title: "Check after side chat f1" }),
    step("s5", { kind: "check", role: "check", title: "Check after follow-up f2" }),
  ];
  assert.deepEqual(
    m.teamSteps(run, steps).map((s: any) => s.id),
    ["s1", "s5"],
  );
});

/** The keyed items of a ChatThread, and every element in it, without rendering components. */
function thread(run: any, steps: any[]) {
  const tree = m.ChatThread({ run, steps: m.teamSteps(run, steps), data: runData(steps) });
  const items: any[] = tree.props.children[0];
  const all: any[] = [];
  const walk = (node: any) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "props" in node) {
      all.push(node);
      walk(node.props.children);
    }
  };
  walk(tree);
  return { keys: items.map((v) => v.key), all };
}
const badge = (all: any[]) => all.find((v) => v.type === "span" && /check (passes|fails)/.test(String(v.props.children)))?.props.children;

test("ChatThread: a side chat's change gets a line where its turn ran; a side Ask keeps the turn's check badge", () => {
  // A side Ask: nothing about it in the thread, and the turn still says how the check went.
  const ask = thread(chatRun([sideTurn("f1", "ask", { stepId: "s2" })]), [step("s1"), step("s2", { role: "side chat", startedAt: 2100 })]);
  assert.deepEqual(ask.keys, ["s1"]);
  assert.equal(badge(ask.all), "check passes");

  // A side Change that finished, then a reply in the main thread: the change's line sits between them.
  const change = sideTurn("f1", "change", { stepId: "s2", checkPassed: false });
  const reply = { id: "f2", kind: "reply", worktree: "agent-1", agent: "claude", message: "thanks, now the docs", status: "done", stepId: "s3", at: 4000 };
  const run = { ...chatRun([change, reply]), lastCheck: { ok: false, command: "npm test", worktree: "agent-1", at: 3500 } };
  const done = thread(run, [step("s1"), step("s2", { role: "side chat", startedAt: 2100 }), step("s4", { kind: "check", role: "check", title: "Check after side chat f1", startedAt: 3000 }), step("s3", { startedAt: 4100 })]);
  assert.deepEqual(done.keys, ["s1", "f1", "s3"]);
  assert.ok(done.all.some((v) => typeof v.type === "function" && v.props.f === change), "the change's line links back to its side chat");

  // A side Change that hasn't run yet: no line, and the run's check is still the turn's.
  const queued = thread(chatRun([sideTurn("f1", "change", { status: "pending" })]), [step("s1")]);
  assert.deepEqual(queued.keys, ["s1"]);
  assert.equal(badge(queued.all), "check passes");

  // One that's working: the run's check is about to be the change's, so the turn's badge steps aside.
  const working = thread(chatRun([sideTurn("f1", "change", { status: "pending", stepId: "s2" })]), [step("s1"), step("s2", { role: "side chat", startedAt: 2100, status: "running" })]);
  assert.equal(badge(working.all), undefined);

  // One that ended before its turn started (the run was stopped while it waited): the branch is the turn's.
  const never = thread(chatRun([sideTurn("f1", "change", { status: "failed" })]), [step("s1")]);
  assert.equal(badge(never.all), "check passes");

  // Once it ran, the run's last check is about the change, not the turn.
  const after = thread(chatRun([sideTurn("f1", "change", { stepId: "s2" })]), [step("s1"), step("s2", { role: "side chat", startedAt: 2100 })]);
  assert.deepEqual(after.keys, ["s1", "f1"]);
  assert.equal(badge(after.all), undefined);
});

test("sideChatIn: while the run's stream replays snapshots older than the chat, the feed's snapshot stands in", () => {
  const summary = chatRun([sideTurn("f1", "change"), sideTurn("f2", "ask", { at: 3000 })]);
  const replayed = chatRun([]); // the snapshot taken when the run was created
  const shown = m.sideChatIn(replayed, summary, "c1");
  assert.equal(shown.run, summary);
  assert.deepEqual(shown.chat.turns.map((t: any) => t.id), ["f1", "f2"]);
  assert.equal(m.sideChatIn(null, summary, "c1").run, summary, "before the stream's first snapshot");

  // Once the stream has the chat, it's shown from the stream (with its steps).
  const live = chatRun([sideTurn("f1", "change"), sideTurn("f2", "ask", { at: 3000 }), sideTurn("f3", "ask", { at: 4000, status: "pending" })]);
  const caught = m.sideChatIn(live, summary, "c1");
  assert.equal(caught.run, live);
  assert.equal(caught.chat.turns.length, 3);
  assert.equal(caught.chat.mode, "ask");

  assert.equal(m.sideChatIn(live, summary, "nope"), undefined);
});
