import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fakeBin = fileURLToPath(new URL("./fake-bin", import.meta.url));
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-ctx-home-"));

const { RunManager } = await import("../src/engine.js");
const { findPattern } = await import("../src/patterns/index.js");
const { listTree, searchFiles } = await import("../src/repo-tree.js");
const { agentCatalog, validateAgentSettings } = await import("../src/adapters/index.js");

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();

before(() => {
  repo = mkdtempSync(join(tmpdir(), "codeflow-ctx-repo-"));
  git("init", "-q");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, "src", "edited.ts"), "original\n");
  writeFileSync(join(repo, "src", "lib", "util.ts"), "export {};\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  // Working-copy state the user sees but the base commit doesn't have:
  writeFileSync(join(repo, "src", "edited.ts"), "user's local edit\n");
  writeFileSync(join(repo, "notes.md"), "uncommitted spec\n");
  writeFileSync(join(repo, "debug.log"), "ignored\n");
  mkdirSync(join(repo, "drafts"));
  writeFileSync(join(repo, "drafts", "idea.md"), "untracked folder\n");
});

test("tree lists folders first, hides .git and ignored files, marks changes", async () => {
  const root = await listTree(repo);
  assert.deepEqual(
    root.entries.map((e) => [e.name, e.type, e.status ?? ""]),
    [
      ["drafts", "dir", "U"],
      ["src", "dir", "M"],
      [".gitignore", "file", ""],
      ["notes.md", "file", "U"],
      ["README.md", "file", ""],
    ],
  );
  const src = await listTree(repo, "src");
  assert.deepEqual(src.entries.map((e) => [e.path, e.status ?? ""]), [["src/lib", ""], ["src/app.ts", ""], ["src/edited.ts", "M"]]);
});

test("tree refuses paths that leave the repo", async () => {
  await assert.rejects(listTree(repo, "../"), /inside the repository/);
  const outside = mkdtempSync(join(tmpdir(), "codeflow-outside-"));
  symlinkSync(outside, join(repo, "escape"));
  try {
    await assert.rejects(listTree(repo, "escape"), /outside the repository/);
  } finally {
    execFileSync("rm", [join(repo, "escape")]);
  }
});

test("search finds tracked and untracked files, filename matches first", async () => {
  const hits = (await searchFiles(repo, "app")).map((h) => h.path);
  assert.deepEqual(hits, ["src/app.ts"]);
  assert.ok((await searchFiles(repo, "notes")).some((h) => h.path === "notes.md"));
  assert.deepEqual(await searchFiles(repo, "debug"), [], "ignored files are not searchable");
});

async function startRun(extra: Record<string, unknown>) {
  const manager = new RunManager();
  const run = await manager.start({
    pattern: findPattern("pipeline")!,
    task: "Use the context",
    repo,
    roles: { planner: ["claude"], builder: ["codex"], reviewer: ["agy"] },
    options: {},
    ...extra,
  });
  await new Promise<void>((resolve) => {
    const check = () => run.status !== "running" && resolve();
    manager.subscribe(run.id, check);
    check();
  });
  return run;
}

test("context reaches every agent; working copies and attachments are copied, never committed", async () => {
  const recordDir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = recordDir;
  try {
    const run = await startRun({
      context: {
        paths: [{ path: "src/app.ts" }, { path: "./src/lib/" }, { path: "src/edited.ts" }, { path: "notes.md" }, { path: "src/app.ts" }],
        attachments: [
          { name: "spec.md", data: Buffer.from("# Spec\n").toString("base64") },
          { name: "../../evil/spec.md", data: Buffer.from("second").toString("base64") },
        ],
      },
    });
    assert.equal(run.status, "done", run.error);

    assert.deepEqual(run.context.paths, [
      { path: "src/app.ts", type: "file" },
      { path: "src/lib", type: "dir" },
      { path: "src/edited.ts", type: "file", workingCopy: ".codeflow-context/repo/src/edited.ts", note: "modified" },
      { path: "notes.md", type: "file", workingCopy: ".codeflow-context/repo/notes.md", note: "uncommitted" },
    ]);
    assert.deepEqual(run.context.attachments.map((a) => a.name), ["spec.md", "spec (2).md"], "names are sanitized and de-duplicated");

    const wt = join(run.worktreeDir, "build");
    assert.equal(readFileSync(join(wt, ".codeflow-context", "repo", "src", "edited.ts"), "utf8"), "user's local edit\n");
    assert.equal(readFileSync(join(wt, ".codeflow-context", "attachments", "spec.md"), "utf8"), "# Spec\n");

    const branchFiles = git("ls-tree", "-r", "--name-only", run.artifacts[0]!.branch);
    assert.ok(!branchFiles.includes(".codeflow-context"), "context is never committed");
    assert.equal(git("status", "--porcelain").includes(".codeflow-context"), false);

    const prompts = readdirSync(recordDir).map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
    const firstTurns = prompts.filter((p) => !p.args.includes("--resume") && !p.args.includes("resume") && !p.args.includes("--conversation"));
    assert.ok(firstTurns.length >= 3);
    for (const p of firstTurns) {
      assert.match(p.prompt, /## Context from the user/);
      assert.match(p.prompt, /- `src\/lib\/` \(folder\)/);
      assert.match(p.prompt, /`src\/edited.ts` — the user has local changes; their version is at `\.codeflow-context\/repo\/src\/edited.ts`/);
      assert.match(p.prompt, /`\.codeflow-context\/attachments\/spec.md` \(7 B\)/);
    }
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("bad context is rejected before anything is created", async () => {
  const before = git("worktree", "list");
  await assert.rejects(startRun({ context: { paths: [{ path: "drafts" }] } }), /Folder "drafts" isn't in the base branch/);
  await assert.rejects(startRun({ context: { paths: [{ path: "missing.ts" }] } }), /was not found/);
  await assert.rejects(startRun({ context: { paths: [{ path: "../etc/passwd" }] } }), /inside the repository/);
  assert.equal(git("worktree", "list"), before);
  const worktreeRuns = existsSync(join(repo, ".worktrees")) ? readdirSync(join(repo, ".worktrees")) : [];
  for (const dir of worktreeRuns) assert.ok(readdirSync(join(repo, ".worktrees", dir)).length > 0, "no empty leftovers");
});

test("model and effort reach each CLI in its own flag format", async () => {
  const recordDir = mkdtempSync(join(tmpdir(), "codeflow-record-"));
  process.env.FAKE_RECORD_DIR = recordDir;
  try {
    const run = await startRun({
      agentSettings: validateAgentSettings({
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-a", effort: "low" },
        agy: { model: "model-one", effort: "max" },
      }),
    });
    assert.equal(run.status, "done", run.error);
    const calls = readdirSync(recordDir).map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
    const argsOf = (vendor: string) => calls.find((c) => c.vendor === vendor)!.args.join(" ");
    assert.match(argsOf("claude"), /--model opus --effort high/);
    assert.match(argsOf("codex"), /-m gpt-a -c model_reasoning_effort="low"/);
    assert.match(argsOf("agy"), /--model model-one --effort max/);
  } finally {
    delete process.env.FAKE_RECORD_DIR;
  }
});

test("model settings are validated", () => {
  assert.deepEqual(validateAgentSettings({ claude: { model: " sonnet ", effort: "" }, codex: {}, nope: { model: "x" } }), {
    claude: { model: "sonnet" },
  });
  assert.throws(() => validateAgentSettings({ claude: { model: "--dangerously-skip-permissions" } }), /Invalid model/);
  assert.throws(() => validateAgentSettings({ codex: { effort: 'high" -c x="y' } }), /Invalid effort/);
});

test("model catalogs are read from each CLI", async () => {
  const codex = await agentCatalog("codex");
  assert.deepEqual(codex.models.map((m) => [m.id, m.efforts]), [["gpt-a", ["low", "medium", "high", "ultra"]], ["gpt-b", ["low", "medium"]]]);
  assert.deepEqual(codex.efforts, ["low", "medium", "high", "ultra"]);
  const agy = await agentCatalog("agy");
  assert.deepEqual(agy.models, [{ id: "model-one", label: "Model One (High)" }, { id: "model-two", label: "Model Two" }]);
  const claude = await agentCatalog("claude");
  assert.ok(claude.allowCustom && claude.models.some((m) => m.id === "opus"));
});
