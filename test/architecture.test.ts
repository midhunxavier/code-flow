import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inspectArchitecture } from "../src/architecture.js";

function fixture(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "cf-architecture-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); }
  execFileSync("git", ["add", "."], { cwd: repo }); return repo;
}
test("architecture resolves multiple language boundaries, package manifests, cycles and computed imports without executing code", async () => {
  const repo = fixture({
    "a.ts": 'import { b } from "./b.js"; import("./lazy"); require(variable); // import "./ghost"\n',
    "b.ts": 'export { a } from "./a.js"; import x from "external-lib";', "lazy.ts": "export const x = 1;",
    "package.json": JSON.stringify({ scripts: { postinstall: "touch SHOULD_NOT_EXIST" }, dependencies: { "external-lib": "^2", "private-lib": "https://alice:private-password@git.example.invalid/repo" }, devDependencies: { typescript: "~5" } }),
    "pkg/main.py": "from . import helper\nimport os\nimportlib.import_module(name)\n", "pkg/helper.py": "from .main import x\n",
    "go.mod": "module example.invalid/project\nrequire example.invalid/external v1.2.3\n", "cmd/main.go": 'package main\nimport (\n "example.invalid/project/internal"\n "fmt"\n)\n', "internal/api.go": "package internal\n",
    "src/lib.rs": "mod model;\nuse serde::Serialize;", "src/model.rs": "pub struct Model;", "Cargo.toml": '[dependencies]\nserde = "1"\n',
    "java/App.java": "package app;\nimport app.Model;\n", "java/Model.java": "package app;\nclass Model {}",
    "requirements.txt": "requests>=2\n", "pyproject.toml": '[project]\ndependencies = ["httpx>=1"]\n',
    ".env.py": 'import "SECRETS"', "node_modules/injected.ts": 'import "do-not-scan"', "untracked.py": "import omitted\n",
  });
  execFileSync("git", ["reset", "--", "untracked.py"], { cwd: repo });
  try {
    const graph = await inspectArchitecture(repo);
    for (const [from, to] of [["a.ts", "b.ts"], ["a.ts", "lazy.ts"], ["pkg/main.py", "pkg/helper.py"], ["cmd/main.go", "internal/api.go"], ["src/lib.rs", "src/model.rs"], ["java/App.java", "java/Model.java"]]) assert.ok(graph.edges.some((edge) => edge.from === from && edge.to === to), `${from} -> ${to}`);
    assert.deepEqual(graph.cycles.find((cycle) => cycle.includes("a.ts")), ["a.ts", "b.ts"]);
    assert.ok(graph.cycles.some((cycle) => cycle.includes("pkg/helper.py") && cycle.includes("pkg/main.py")));
    assert.equal(graph.dynamic.length, 2); assert.ok(graph.unresolved.some((item) => item.specifier === "external-lib"));
    assert.equal(graph.languages.length, 5); assert.ok(graph.packages.some((item) => item.name === "serde")); assert.ok(graph.packages.some((item) => item.name === "requests"));
    assert.ok(graph.components.some((item) => item.directory === "internal" && item.incoming === 1));
    assert.ok(!JSON.stringify(graph).includes("SECRETS")); assert.ok(!graph.nodes.includes("untracked.py")); assert.ok(!graph.nodes.includes("node_modules/injected.ts"));
    assert.ok(!JSON.stringify(graph).includes("private-password")); assert.ok(graph.packages.some((item) => item.version.includes("[REDACTED]@")));
    assert.ok(!graph.unresolved.some((item) => item.specifier === "./ghost"));
    const { existsSync } = await import("node:fs"); assert.equal(existsSync(join(repo, "SHOULD_NOT_EXIST")), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("architecture excludes symlink contents, caps source sets and honors cancellation", async () => {
  const files = Object.fromEntries(Array.from({ length: 620 }, (_, n) => [`file-${n}.ts`, "export const value = 1;\n"]));
  const repo = fixture(files), outside = mkdtempSync(join(tmpdir(), "cf-architecture-outside-"));
  writeFileSync(join(outside, "private.ts"), 'import "outside-secret";'); symlinkSync(join(outside, "private.ts"), join(repo, "linked.ts")); execFileSync("git", ["add", "linked.ts"], { cwd: repo });
  try {
    const graph = await inspectArchitecture(repo); assert.equal(graph.truncated, true); assert.ok(graph.nodes.length <= 600); assert.ok(!JSON.stringify(graph).includes("outside-secret"));
    await assert.rejects(inspectArchitecture(repo, AbortSignal.abort()), /abort/i);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
