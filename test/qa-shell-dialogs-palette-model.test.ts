import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteResults, type PaletteRow } from "../ui/command-palette-model.js";
const actions: PaletteRow[] = [
  { id: "settings:agents", label: "Agents & models", detail: "Settings health", group: "action" },
  { id: "settings:general", label: "General", detail: "Settings keyboard", group: "action" },
  { id: "settings:projects", label: "Projects", detail: "Settings defaults", group: "action" },
  { id: "health", label: "Check provider and Git health", detail: "Actions", group: "action" },
  { id: "board", label: "Board", detail: "Collaboration", group: "action" },
  { id: "projects", label: "Manage projects", detail: "Actions", aliases: ["projects"], group: "action" },
];
test("label and explicit action matches outrank incidental settings keywords", () => {
  assert.equal(paletteResults(actions, "health").rows[0]?.id, "health"); assert.equal(paletteResults(actions, "board").rows[0]?.id, "board"); assert.equal(paletteResults(actions, "projects").rows[0]?.id, "projects");
  assert.ok(paletteResults(actions, "health").rows.some(row => row.id === "settings:agents"));
});
test("empty palette retains projects and recent runs regardless of subsection count", () => {
  const projects: PaletteRow[] = Array.from({ length: 12 }, (_, i) => ({ id: `project:${i}`, label: `Project ${i}`, detail: "Project", group: "project" }));
  const sections: PaletteRow[] = projects.flatMap(p => ["board", "people", "automation"].map(section => ({ ...p, id: `${p.id}:${section}`, label: `${p.label} · ${section}`, group: "project-section" })));
  const runs: PaletteRow[] = Array.from({ length: 100 }, (_, i) => ({ id: `run:${100-i}`, label: `Task ${100-i}`, detail: "Run", group: "run" })); const commands = [...actions, ...projects, ...sections, ...runs];
  const result = paletteResults(commands, ""); assert.ok(result.rows.some(row => row.group === "project")); assert.ok(result.rows.some(row => row.id === "run:100")); assert.ok(result.hidden > 0); assert.ok(result.rows.length <= 40);
  const matches = paletteResults(commands, "project").rows; assert.equal(matches.filter(row => row.group === "project").length, 12);
  for (const p of projects) for (const section of matches.filter(row => row.id.startsWith(p.id + ":"))) assert.ok(matches.indexOf(p) < matches.indexOf(section));
});
test("server full-history matches survive bounded client summaries and ranking is stable", () => {
  const matches: PaletteRow[] = [{ id: "cold", label: "Shortened task…", detail: "Run", group: "run", serverMatch: true }, { id: "a", label: "needle one", detail: "Run", group: "run" }, { id: "b", label: "needle two", detail: "Run", group: "run" }];
  assert.deepEqual(paletteResults(matches, "needle").rows.map(row => row.id), ["a", "b", "cold"]);
});
