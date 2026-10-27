import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectGuides, type Guide } from "../src/docs-help.js";
import { composerCheckMode, checkExplanation } from "../ui/composer-checks.js";
import { DEFAULT_EXECUTION_BUDGET } from "../src/execution-budget.js";
import { patterns } from "../src/patterns/index.js";
const guide = (body: string): Guide => ({ id: "runs", title: "Runs and workspace", group: "Your work", body });
const moving = "- **Moving a run:** click the project chip at the top of the run. Choose its destination and keep the workspace.";
const long = guide(Array.from({ length: 9 }, (_, i) => `## Run section ${i}\n${"This run has steps and answers. ".repeat(70)}`).join("\n\n") + "\n\n## Projects\n" + "A project has runs. ".repeat(180) + "\n" + moving + "\n\n## The side panel\n" + "The side panel has files and terminal tabs. ".repeat(300));
test("conversation, team and managed check modes follow the execution contract", () => {
  assert.equal(composerCheckMode("solo"), "conversation");
  assert.equal(composerCheckMode("solo", { container: true, team: true }), "conversation");
  assert.equal(composerCheckMode("solo", { team: true }), "team");
  assert.equal(composerCheckMode("solo", { remote: true }), "managed");
  assert.equal(composerCheckMode("solo", { checkpointOnFinish: true }), "managed");
  for (const pattern of patterns.filter(p => p.id !== "solo")) assert.equal(composerCheckMode(pattern.id), "managed");
});
test("check explanations distinguish an ordinary reply from team and checkpoint verification", () => {
  const chat = checkExplanation("conversation", "npm test"); assert.match(chat, /do not run checks automatically/); assert.match(chat, /merge validation/); assert.match(chat, /npm test/); assert.doesNotMatch(chat, /after every turn/);
  assert.match(checkExplanation("team", "npm test"), /team runs “npm test” when it verifies/);
  assert.match(checkExplanation("managed", "npm test"), /runs “npm test” when the workflow verifies/);
});
for (const question of ["How do I move a run to another project?", "How do I move a run to another project? Answer in two sentences.", "Explain moving runs to projects briefly, please."]) test(`bounded retrieval retains the complete later moving instruction: ${question}`, () => {
  const selected = selectGuides([long], question, "runs", ["What does the side panel show?"])[0]!;
  assert.ok(selected.body.includes(moving)); assert.match(selected.body, /## Projects/); assert.ok(selected.body.length <= 10000); assert.doesNotMatch(selected.body, /missi$/);
});
test("current question outranks earlier topics and engineering records remain excluded", () => {
  const selected = selectGuides([long, { ...guide("obsolete move instructions"), id: "old", group: "Engineering records" }], "Move the run to a project", "runs", ["side panel", "side panel files", "side panel terminal"]);
  assert.deepEqual(selected.map(g => g.id), ["runs"]); assert.ok(selected[0]!.body.includes(moving));
});
test("a giant opening cannot consume the budget before a complete matching bullet", () => {
  const body = "# Setup\n" + "Unrelated opening. ".repeat(1500) + "\n## Environment\n- CODEFLOW_HOME controls storage.\n- PATH finds the provider.";
  const excerpt = selectGuides([guide(body)], "CODEFLOW_HOME storage", "runs")[0]!.body;
  assert.match(excerpt, /## Environment\n- CODEFLOW_HOME controls storage\./); assert.ok(excerpt.length <= 10000);
});
test("actual runs guide keeps project movement for suffixed and follow-up questions", () => {
  const body = readFileSync(new URL("../docs/runs.md", import.meta.url), "utf8");
  for (const question of ["How do I move a run to another project?", "How do I move a run to another project? Answer in two sentences."]) {
    const excerpt = selectGuides([guide(body)], question, "runs", ["What does the side panel show?"])[0]!.body;
    assert.match(excerpt, /Moving a run/); assert.match(excerpt, /project chip/); assert.ok(excerpt.length <= 10000);
  }
});
test("workflow docs list all built-ins and current budget defaults without promising checks for chats", () => {
  const text = readFileSync(new URL("../docs/patterns.md", import.meta.url), "utf8");
  for (const pattern of patterns) assert.ok(text.includes(`**${pattern.name}**`), pattern.name);
  assert.ok(text.includes(`${DEFAULT_EXECUTION_BUDGET.maxMinutes} minutes and ${DEFAULT_EXECUTION_BUDGET.maxSteps} agent steps by default`));
  assert.match(text, /Agent conversations do not automatically commit or run checks/);
  assert.doesNotMatch(text, /60 and 40 by default|A limit that isn't a positive number is ignored/);
});
