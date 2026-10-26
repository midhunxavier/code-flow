import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AgentBrowser, chromeExecutable } from "../src/agent-browser.js";
const signal = new AbortController().signal;
test("a preview browser survives a second viewer and reconnect while preserving its usable page", { skip: !chromeExecutable(), timeout: 60000 }, async () => {
  const site = createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end('<title>Reconnect preview</title><button>Usable</button>'); });
  await new Promise<void>(r => site.listen(0, "127.0.0.1", r)); const browser = new AgentBrowser(`qa-preview-${Date.now()}`), events: any[] = [];
  const url = `http://127.0.0.1:${(site.address() as any).port}/`; let stop = browser.watch(e => events.push(e)), other: (()=>void) | undefined;
  try {
    const opened = await browser.call("browser_navigate", { url }, signal); assert.equal(opened.title, "Reconnect preview");
    other = browser.watch(e => events.push(e)); await browser.call("browser_ui", { action: "state" }, signal); other(); other = undefined; stop();
    stop = browser.watch(e => events.push(e)); const state = await browser.call("browser_ui", { action: "state" }, signal);
    const selected = state.tabs.find((t: any) => t.id === state.selected); assert.equal(selected.url, url); assert.equal(selected.title, "Reconnect preview");
    const snapshot = await browser.call("browser_snapshot", {}, signal); assert.ok(snapshot.snapshot.some((n: any) => n.name === "Usable"));
    const deadline = Date.now() + 10000; while (!events.some(e => e.type === "frame") && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(events.filter(e => e.type === "error").length, 0, JSON.stringify(events.filter(e => e.type === "error"))); assert.ok(events.some(e => e.type === "frame"));
  } finally { other?.(); stop(); await browser.close(); site.closeAllConnections(); await new Promise<void>(r => site.close(() => r())); }
});
