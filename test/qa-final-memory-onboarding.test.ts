import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { analyzeProjectMemory } from "../src/memory-analysis.js";
import type { MemoryEntry } from "../src/memory.js";
import { onboardingExamples, onboardingScopeExamples, literalMemoryPaths } from "./qa-final-memory-onboarding-fixture.js";

for (const [name, examples] of [
  ["Python indentation", onboardingExamples.slice(0, 2)],
  ["significant quoted spaces", onboardingExamples.slice(2)],
] as const) test(`onboarding preserves distinct ${name} while normalized duplicate review remains available`, async () => {
  const repo = await mkdtemp("/private/tmp/codeflow-onboarding-unit-");
  const entries = [...examples, { title: "Z Exact duplicate", body: examples[0]!.body }].map((example, i): MemoryEntry => ({
    ...example, id: `m-${i}`, revision: 1, repo, projectId: "p", scope: "project", status: "accepted", acceptedBy: "user",
    tags: [], paths: [], applicability: { kind: "repository" }, derivedFrom: [], sourceRefs: [],
    origins: [{ kind: "user", trust: "trusted", private: false, lockedDown: false }], createdAt: 1, updatedAt: 2,
  }));
  try {
    const result = await analyzeProjectMemory({ repo, projectId: "p", entries });
    assert.deepEqual(result.onboarding.sourceRefs, [{ id: "m-0", revision: 1 }, { id: "m-1", revision: 1 }]);
    for (const example of examples) assert.ok(result.onboarding.body.includes(example.body));
    assert.deepEqual(result.onboarding.reasons, [{ id: "m-2", reason: `Same text as ${examples[0]!.title}` }]);
    assert.equal(result.onboarding.omitted, 1);
    assert.ok(result.duplicates.some(pair => pair.a.id === "m-0" && pair.b.id === "m-1" && pair.kind === "exact"), "normalized review hints stay unchanged");
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("identical onboarding bodies keep distinct branch and path applicability", async () => {
  const repo = await mkdtemp("/private/tmp/codeflow-onboarding-scopes-");
  try {
    execFileSync("git", ["init", "-qb", "main"], { cwd: repo });
    for (const file of ["README.md", "config.txt"]) await writeFile(`${repo}/${file}`, "fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
    const examples = [...onboardingScopeExamples, { title: "I Both paths", body: "Include the fixture name in examples.", paths: ["README.md", "config.txt"] }, { title: "Z Both paths reversed duplicate", body: "Include the fixture name in examples.", paths: ["config.txt", "README.md", "config.txt"] }];
    const entries = examples.map((example, index) => ({
      id: `m-${index}`, revision: 1, repo, projectId: "p", scope: "project", status: "accepted", acceptedBy: "user",
      tags: [], paths: [], applicability: { kind: "repository" }, derivedFrom: [], sourceRefs: [],
      origins: [{ kind: "user", trust: "trusted", private: false, lockedDown: false }], createdAt: 1, updatedAt: 2, ...example,
    } as MemoryEntry));
    const result = await analyzeProjectMemory({ repo, projectId: "p", entries });
    assert.equal(result.git.branch, "main"); assert.equal(result.git.available, true);
    assert.deepEqual(result.onboarding.sourceRefs, entries.slice(0, 5).map(entry => ({ id: entry.id, revision: 1 })));
    assert.deepEqual(result.onboarding.reasons, [{ id: "m-5", reason: "Same text as I Both paths" }]);
    assert.match(result.onboarding.body, /## E Current branch guidance[\s\S]*Applies to branch main/);
    assert.match(result.onboarding.body, /## F Repository wide guidance/);
    const pathLists = [...result.onboarding.body.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!)).filter(Array.isArray);
    assert.deepEqual(pathLists, [["README.md"], ["config.txt"], ["README.md", "config.txt"]]);
    assert.equal(result.onboarding.omitted, 1);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("onboarding path and branch labels fence punctuation, backticks and line breaks as literal JSON", async () => {
  const repo = await mkdtemp("/private/tmp/codeflow-onboarding-literals-");
  try {
    execFileSync("git", ["init", "-qb", "_qa_"], { cwd: repo });
    for (const path of literalMemoryPaths) await writeFile(`${repo}/${path}`, "fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const entry: MemoryEntry = {
      id: "literal", title: "Literal paths", body: "Keep these fixture names exact.", revision: 1, repo, projectId: "p", scope: "project", status: "accepted", acceptedBy: "user",
      tags: [], paths: literalMemoryPaths, applicability: { kind: "branch", branch: "_qa_", commit }, derivedFrom: [], sourceRefs: [],
      origins: [{ kind: "user", trust: "trusted", private: false, lockedDown: false }], createdAt: 1, updatedAt: 2,
    };
    const result = await analyzeProjectMemory({ repo, projectId: "p", entries: [entry] });
    assert.deepEqual(result.onboarding.sourceRefs, [{ id: "literal", revision: 1 }]);
    const blocks = [...result.onboarding.body.matchAll(/```json\n([\s\S]*?)\n```/g)];
    assert.equal(blocks.length, 2);
    assert.equal(JSON.parse(blocks[0]![1]!), `Applies to branch _qa_ at ${commit}.`);
    assert.deepEqual(JSON.parse(blocks[1]![1]!), literalMemoryPaths);
    for (const block of blocks) assert.equal(block[1]!.split("\n").some(line => line.startsWith("```")), false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
