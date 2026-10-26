import { test } from "node:test";
import assert from "node:assert/strict";
import { browserContextMessage, parseBrowserMessage, reconcileSnapshots } from "../ui/browser-context.js";
const saved = new Map<string, string>(), legacy = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, __CODEFLOW_WORKSPACE: "qa-computer" } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "localhost", hash: "", search: "", origin: "http://localhost" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) } });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => legacy.get(key) ?? null } });
const { readMessageDraft, writeMessageDraft } = await import("../ui/message-draft.js");
const context = { version: 1 as const, comment: "Make this readable", url: "http://localhost:4355", selector: "h1", text: "Heading", snapshot: "pin.png" };
const text = browserContextMessage(context), image = { name: "pin.png", data: "data:image/png;base64,abc", size: 3 };
test("main and side message drafts durably retain paired text/images in their owning computer", async () => {
  await writeMessageDraft("main:run", { text, images: [image] }); await writeMessageDraft("side:run:new", { text: "side", images: [] });
  assert.deepEqual(await readMessageDraft("main:run"), { text, images: [image] }); assert.deepEqual(await readMessageDraft("side:run:new"), { text: "side", images: [] });
  assert.ok([...saved.keys()].every(key => key.includes("qa-computer"))); assert.ok([...saved.values()].some(value => JSON.parse(value).images[0]?.data === image.data));
});
test("legacy pin text with a lost image keeps the card with an explicit unavailable flag", async () => {
  legacy.set("agent-draft:old", text); const restored = await readMessageDraft("main:old", "agent-draft:old"), card = parseBrowserMessage(restored.text).contexts[0]!;
  assert.ok([...saved.values()].some(value => JSON.parse(value).text === restored.text), "legacy text migrates without another edit");
  assert.equal(card.snapshot, undefined); assert.equal(card.snapshotUnavailable, true); assert.equal(card.comment, context.comment);
  assert.equal(reconcileSnapshots(restored.text, []), restored.text, "reconciliation is idempotent");
});
test("successful-send clearing cannot resurrect the older session draft", async () => {
  legacy.set("agent-draft:sent", text); await writeMessageDraft("main:sent", { text: "", images: [] });
  assert.deepEqual(await readMessageDraft("main:sent", "agent-draft:sent"), { text: "", images: [] });
});
test("missing references alone are removed, preserving all other text and complete screenshots", () => {
  assert.equal(reconcileSnapshots(text, [image]), text);
  const mixed = `User text\n\n${text}\n\n${browserContextMessage({ ...context, snapshot: "missing.png", comment: "Other" })}`;
  const restored = parseBrowserMessage(reconcileSnapshots(mixed, [image])); assert.equal(restored.text, "User text"); assert.equal(restored.contexts[0]!.snapshot, "pin.png"); assert.equal(restored.contexts[1]!.snapshotUnavailable, true);
});

test("a failed migration save preserves the readable legacy draft", async () => {
  const original = localStorage.setItem; localStorage.setItem = () => { throw new Error("quota full"); }; legacy.set("agent-draft:quota", "Keep legacy words");
  try { assert.deepEqual(await readMessageDraft("main:quota", "agent-draft:quota"), { text: "Keep legacy words", images: [] }); }
  finally { localStorage.setItem = original; }
});
