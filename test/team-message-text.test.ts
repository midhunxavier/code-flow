import { test } from "node:test";
import assert from "node:assert/strict";
import { readableTeamMessage } from "../ui/team-message-text.js";

test("long findings gain sentence-boundary paragraphs without losing text or file references", () => {
  const text = "Read-only inspection supports README.md as the target. " +
    "The repository contains public/assets/logo-mark.svg and an older screenshot with no identified replacement. ".repeat(6) +
    "Keep the limitations in README.md:122-127.";
  const formatted = readableTeamMessage(text);
  assert.ok(formatted.includes("\n\n"));
  assert.equal(formatted.replace(/\s+/g, " ").trim(), text);
  for (const paragraph of formatted.split("\n\n")) assert.ok(paragraph.endsWith("."));
});

test("preserves Markdown code, lists, tables and authored line breaks", () => {
  for (const text of [
    "```ts\n" + "const a = 'Long sentence. Another sentence.';\n".repeat(20) + "```",
    "- " + "A long list item. ".repeat(50),
    "| File | Evidence |\n| --- | --- |\n" + "| README.md | Checked. |\n".repeat(30),
    "An authored first line.\n" + "A second line with details. ".repeat(30),
    "Use `README.md` as the source. ".repeat(30),
    "**" + "An emphasized sentence. ".repeat(30) + "**",
    "A short reply.",
  ]) assert.equal(readableTeamMessage(text), text);
});
