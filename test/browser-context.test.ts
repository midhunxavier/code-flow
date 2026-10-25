import { test } from "node:test";
import assert from "node:assert/strict";
import { browserContextMessage, composeBrowserMessage, editBrowserText, parseBrowserMessage, type BrowserContext } from "../ui/browser-context.js";

const context: BrowserContext = { version: 1, url: "http://localhost:3001/", selector: "#root > div.modal", text: "Server configuration", comment: "Add the server automatically.\nKeep the form available.", html: '<div role="dialog">Server configuration</div>', snapshot: "pin-abc-1.png", console: ["Request failed"] };

test("browser context roundtrips without mixing page evidence into editable text", () => {
  const raw = composeBrowserMessage("Please fix this", [context, { ...context, url: "http://localhost:3002/", snapshot: "pin-def-1.png" }]);
  const parsed = parseBrowserMessage(raw);
  assert.equal(parsed.text, "Please fix this");
  assert.deepEqual(parsed.contexts[0], context);
  assert.equal(parsed.contexts.length, 2);
  const changed = parseBrowserMessage(editBrowserText(raw, "Changed instructions"));
  assert.equal(changed.text, "Changed instructions");
  assert.deepEqual(changed.contexts, parsed.contexts);
  const sent = raw + "\n\nAttached, in this worktree (not committed): `.codeflow-context/messages/123-pin-abc-1.png`, `.codeflow-context/messages/123-pin-def-1.png`";
  assert.equal(parseBrowserMessage(sent).text, "Please fix this");
});

test("legacy browser feedback becomes a card, preserving surrounding text and mixed attachments", () => {
  const legacy = 'From the app in the browser (http://localhost:3001/, 636px wide):\n1. `#root > div.modal`: Add the server automatically.\n   Text: "Server configuration"\n   HTML: <div role="dialog">Server configuration</div>\n   Snapshot: pin-abc-1.png';
  const parsed = parseBrowserMessage("Before\n\n" + legacy + "\n\nAfter");
  assert.match(parsed.text, /^Before\s+After$/);
  assert.deepEqual(parsed.contexts[0], { version: 1, url: context.url, selector: context.selector, text: context.text, comment: "Add the server automatically.", html: context.html, snapshot: context.snapshot });
  const footer = "Attached, in this worktree (not committed): `.codeflow-context/messages/file-notes.txt`";
  assert.equal(parseBrowserMessage(legacy + "\n\n" + footer).text, footer);
  assert.equal(parseBrowserMessage(legacy + "\n\n" + legacy).contexts.length, 2);
});

test("unknown, malformed, and ordinary messages remain visible verbatim", () => {
  for (const message of ["  ordinary text\n", "```codeflow-browser-context\nnot json\n```", '```codeflow-browser-context\n{"version":2}\n```', "From the app in the browser:\nHere is my own note."]) {
    assert.deepEqual(parseBrowserMessage(message), { text: message, contexts: [] });
  }
  const malicious = { ...context, comment: "```\n</div><script>alert(1)</script>\n```codeflow-browser-context", text: "<img onerror=alert(1)>" };
  assert.deepEqual(parseBrowserMessage(browserContextMessage(malicious)).contexts, [malicious]);
  const edited = browserContextMessage(context).replace("Browser comment: Add the server automatically.", "Browser comment: Different instructions");
  assert.deepEqual(parseBrowserMessage(edited), { text: edited, contexts: [] });
});
