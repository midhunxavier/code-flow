import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerHelp,
  parseHelpRequest,
  selectGuides,
  type Guide,
} from "../src/docs-help.js";
const directory = await mkdtemp(join(tmpdir(), "cf-docs-test-"));
process.env.PATH = `${fileURLToPath(new URL("./fake-bin", import.meta.url))}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = directory;
process.env.CODEFLOW_CODEX_TRANSPORT = "exec";
after(() => rm(directory, { recursive: true, force: true }));
const guides: Guide[] = [
  {
    id: "getting-started",
    title: "Getting started",
    group: "Get started",
    body: "Choose a repository and Start run.",
  },
  {
    id: "ssh-projects",
    title: "SSH projects",
    group: "Connect",
    body: "Open SSH connections to connect a remote host.",
  },
  {
    id: "old",
    title: "SSH projects old plan",
    group: "Engineering records",
    body: "Outdated plan",
  },
];
test("help rejects invalid providers, paths, arguments and oversized conversations before dispatch", () => {
  for (const value of [
    { question: "" },
    { repo: "/private/repo" },
    { execution: "remote" },
    { question: "a".repeat(4001) },
    { agent: "acp:kilo" },
    { page: "../../secret" },
    { settings: { model: "--evil" } },
    { history: Array(4).fill({ question: "q", answer: "a" }) },
    { history: [{ question: "q", answer: "a".repeat(12001) }] },
  ])
    assert.throws(() =>
      parseHelpRequest({ agent: "claude", question: "how?", ...value }),
    );
  assert.deepEqual(
    parseHelpRequest({
      agent: "codex",
      question: " question ",
      settings: { model: "custom", effort: "high" },
      history: [],
    }).settings,
    { model: "custom", effort: "high" },
  );
});
test("retrieval ranks relevant guides and excludes engineering history", () => {
  const selected = selectGuides(guides, "SSH projects");
  assert.equal(selected[0]!.id, "ssh-projects");
  assert.ok(!selected.some((s) => s.id === "old"));
});
for (const agent of ["claude", "codex", "agy"] as const)
  test(`${agent} answers in an isolated directory and preserves model settings`, async () => {
    const records = await mkdtemp(join(directory, "records-"));
    process.env.FAKE_RECORD_DIR = records;
    try {
      const result = await answerHelp(
        parseHelpRequest({
          agent,
          question: "SNEAKY how do I start?",
          settings: { model: "custom-model", effort: "low" },
        }),
        guides,
      );
      assert.match(result.answer, /Start run/);
      assert.ok(result.sources.some((s) => s.id === "getting-started"));
      const calls = await readdir(records);
      assert.equal(calls.length, 1);
      const call = JSON.parse(await readFile(join(records, calls[0]!), "utf8"));
      assert.notEqual(call.cwd, process.cwd());
      await assert.rejects(access(call.cwd));
      assert.ok(call.args.includes("custom-model"));
      assert.match(call.prompt, /Do not use tools/);
      assert.doesNotMatch(call.prompt, /Outdated plan/);
      if (agent === "claude") {
        assert.ok(call.args.includes("--disallowedTools"));
        assert.ok(!call.args.includes("bypassPermissions"));
      }
      if (agent === "codex")
        assert.ok(call.args.includes('sandbox_mode="read-only"'));
      if (agent === "agy") assert.ok(call.args.includes("--sandbox"));
    } finally {
      delete process.env.FAKE_RECORD_DIR;
    }
  });
test("cancellation stops a slow CLI and removes its private directory", async () => {
  const records = await mkdtemp(join(directory, "cancel-"));
  process.env.FAKE_RECORD_DIR = records;
  process.env.FAKE_SLEEP_MS = "20000";
  try {
    const stop = new AbortController();
    const promise = answerHelp(
      parseHelpRequest({ agent: "claude", question: "How?" }),
      guides,
      stop.signal,
    );
    const timer = setTimeout(() => stop.abort(), 500);
    try {
      await assert.rejects(promise);
    } finally {
      clearTimeout(timer);
    }
    for (const file of await readdir(records)) {
      const call = JSON.parse(await readFile(join(records, file), "utf8"));
      await assert.rejects(access(call.cwd));
    }
  } finally {
    delete process.env.FAKE_RECORD_DIR;
    delete process.env.FAKE_SLEEP_MS;
  }
});

test("retrieval includes relevant later sections within the excerpt budget", () => {
  const selected = selectGuides(
    [
      {
        id: "configuration",
        title: "Configuration",
        group: "Your workspace",
        body:
          "# Configuration\n" +
          "Unrelated opening. ".repeat(1000) +
          "\n## Environment variables\nCODEFLOW_HOME controls storage.",
      },
    ],
    "CODEFLOW_HOME storage",
  );
  assert.match(selected[0]!.body, /CODEFLOW_HOME controls storage/);
  assert.ok(selected[0]!.body.length <= 10000);
});

test("invalid and oversized provider answers are rejected and private context is removed", async () => {
  const { getAdapter } = await import("../src/adapters/index.js");
  const adapter = getAdapter("claude"),
    original = adapter.run;
  let workspace = "";
  try {
    for (const structured of [
      { answer: "x".repeat(12001) },
      { answer: "valid", command: "do not execute" },
      { answer: "" },
    ]) {
      adapter.run = async (options) => {
        workspace = options.cwd;
        return { ok: true, finalText: "", structured };
      };
      await assert.rejects(
        answerHelp(
          parseHelpRequest({ agent: "claude", question: "How?" }),
          guides,
        ),
        /invalid answer/,
      );
      await assert.rejects(access(workspace));
    }
  } finally {
    adapter.run = original;
  }
});

test("authentication and usage failures retain actionable CLI reasons", async () => {
  try {
    process.env.FAKE_CLAUDE_FAIL = "auth";
    await assert.rejects(
      answerHelp(
        parseHelpRequest({ agent: "claude", question: "How?" }),
        guides,
      ),
      /signed out/,
    );
    process.env.FAKE_CLAUDE_FAIL = "rejected";
    await assert.rejects(
      answerHelp(
        parseHelpRequest({ agent: "claude", question: "How?" }),
        guides,
      ),
      /usage limit/,
    );
  } finally {
    delete process.env.FAKE_CLAUDE_FAIL;
  }
});
