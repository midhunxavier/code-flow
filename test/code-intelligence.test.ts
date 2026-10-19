import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.js";
import { closeCodeIntelligence, codeIntelligenceHealth, findCodeReferences, searchSemanticSymbols } from "../src/code-intelligence.js";

test("language service resolves imported references and aliases rather than matching text", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeflow-language-service-"));
  try {
    assert.equal((await git(["init", "-q", "-b", "main"], repo)).code, 0);
    const reused = codeIntelligenceHealth.reused;
    await writeFile(join(repo, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    await writeFile(join(repo, "consumer.ts"), "import { add as sum } from './math.js';\nconst unrelated = 'add';\nexport const result = sum(1, 2);\n");
    const symbols = await searchSemanticSymbols(repo, "add");
    const symbol = symbols.hits.find((hit) => hit.path === "math.ts" && hit.symbol === "add")!;
    assert.ok(symbol); assert.match(symbols.engine, /TypeScript language service/);
    const refs = await findCodeReferences(repo, { path: symbol.path, line: symbol.line, column: symbol.column });
    assert.ok(refs.hits.some((hit) => hit.path === "consumer.ts" && hit.line === 3));
    assert.equal(refs.hits.some((hit) => hit.path === "consumer.ts" && hit.line === 2), false, "a string mention is not a reference");
    await writeFile(join(repo, "consumer.ts"), "export const result = 3;\n");
    const refreshed = await findCodeReferences(repo, { path: symbol.path, line: symbol.line, column: symbol.column });
    assert.equal(refreshed.hits.some((hit) => hit.path === "consumer.ts"), false, "each request sees current saved content");
    assert.ok(codeIntelligenceHealth.reused >= reused + 2, "repeated lookups reuse the isolated language service");
    await rm(join(repo, "math.ts"));
    assert.equal((await searchSemanticSymbols(repo, "add")).hits.length, 0, "removed sources disappear from a reused worker");
  } finally { await closeCodeIntelligence(); await rm(repo, { recursive: true, force: true }); }
});
test("language service cannot read symlinks, credential selections or project compiler plugins", async () => {
  const repo = await mkdtemp(join(tmpdir(), "codeflow-language-boundary-"));
  const external = await mkdtemp(join(tmpdir(), "codeflow-language-external-"));
  try {
    await git(["init", "-q", "-b", "main"], repo);
    await writeFile(join(repo, "source.ts"), "export const VisibleSymbol = 1;\n");
    await writeFile(join(repo, ".env.ts"), "export const SecretSymbol = 2;\n");
    await writeFile(join(external, "secret.ts"), "export const ExternalSymbol = 3;\n");
    await symlink(join(external, "secret.ts"), join(repo, "link.ts"));
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { plugins: [{ name: "./malicious-plugin.cjs" }] } }));
    await writeFile(join(repo, "malicious-plugin.cjs"), "throw new Error('plugin must never execute');");
    assert.equal((await searchSemanticSymbols(repo, "VisibleSymbol")).hits.length, 1);
    assert.equal((await searchSemanticSymbols(repo, "SecretSymbol")).hits.length, 0);
    assert.equal((await searchSemanticSymbols(repo, "ExternalSymbol")).hits.length, 0);
    await assert.rejects(findCodeReferences(repo, { path: "../outside.ts", line: 1, column: 1 }), /inside|repository/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(searchSemanticSymbols(repo, "VisibleSymbol", controller.signal));
  } finally { await closeCodeIntelligence(); await rm(repo, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); }
});
