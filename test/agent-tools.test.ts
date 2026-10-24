import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-browser-test-"));
const { AgentBrowser, chromeExecutable } = await import("../src/agent-browser.js");
const { AgentComputer } = await import("../src/agent-computer.js");
const { AgentToolBridge, validateAgentTool } = await import("../src/agent-tools.js");

test("Chrome tools navigate, inspect, fill, click and capture a real page across calls", { skip: !chromeExecutable() }, async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(`<title>Agent tools fixture</title><h1>Browser fixture</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value">Greet</button><output></output>`); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const browser = new AgentBrowser("fixture"), signal = new AbortController().signal;
  try {
    const first = await browser.call("browser_navigate", { url: `http://127.0.0.1:${port}` }, signal);
    assert.equal(first.title, "Agent tools fixture");
    const field = first.snapshot.find((item: any) => item.role === "textbox" && item.name === "Name");
    assert.ok(field, JSON.stringify(first));
    const typed = await browser.call("browser_type", { ref: field.ref, text: "Codeflow" }, signal);
    await assert.rejects(browser.call("browser_click", { ref: field.ref }, signal), /stale/);
    const button = typed.snapshot.find((item: any) => item.role === "button" && item.name === "Greet");
    const clicked = await browser.call("browser_click", { ref: button.ref }, signal);
    assert.ok(clicked.snapshot.some((item: any) => item.name.includes("Hello Codeflow")), JSON.stringify(clicked));
    const screenshot = await browser.call("browser_screenshot", {}, signal);
    assert.equal(screenshot.content[0].mimeType, "image/png");
    assert.ok(Buffer.from(screenshot.content[0].data, "base64").length > 1000);
    const original = (await browser.call("browser_tabs", {}, signal)).tabs[0].id;
    await browser.call("browser_tabs", { action: "new" }, signal);
    assert.equal((await browser.call("browser_tabs", {}, signal)).tabs.length, 2);
    await browser.call("browser_tabs", { action: "select", tab: original }, signal);
    assert.ok((await browser.call("browser_snapshot", {}, signal)).snapshot.some((item: any) => item.name.includes("Hello Codeflow")));
    await assert.rejects(browser.call("browser_navigate", { url: "file:///etc/passwd" }, signal), /http/);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("browser input waits for asynchronous confirmation instead of returning the previous result", { skip: !chromeExecutable() }, async () => {
  let submissions = 0;
  const server = createServer((req, res) => {
    if (req.url === "/submit") { submissions++; setTimeout(() => res.end("done"), 250); return; }
    res.setHeader("content-type", "text/html"); res.end('<button onclick="fetch(\'/submit\').then(()=>document.querySelector(\'output\').textContent=\'Confirmed current submission\')">Submit</button><output>Previous result</output>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = new AgentBrowser("async-confirmation"), signal = new AbortController().signal;
  try {
    const page = await browser.call("browser_navigate", { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, signal);
    const result = await browser.call("browser_click", { ref: page.snapshot.find((node: any) => node.role === "button").ref }, signal);
    assert.equal(submissions, 1); assert.ok(result.snapshot.some((node: any) => node.name === "Confirmed current submission")); assert.equal(result.pendingRequests, 0);
    await browser.call("browser_key", { key: "Tab" }, signal);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("computer actions require fresh screenshot coordinates and preserve pixel scaling", async () => {
  const calls: any[] = [], signal = new AbortController().signal;
  const computer = new AgentComputer(async input => { calls.push(input); return { data: "test", width: 2000, height: 1000, pointWidth: 1000, pointHeight: 500, app: "Fixture" }; });
  await assert.rejects(computer.call("computer_action", { action: "click", screenshot: "old", x: 20, y: 30 }, signal), /fresh/);
  const capture = await computer.call("computer_screenshot", {}, signal);
  const screenshot = JSON.parse(capture.content[0].text).screenshot;
  await assert.rejects(computer.call("computer_action", { action: "click", screenshot, x: 2001, y: 30 }, signal), /outside/);
  await computer.call("computer_action", { action: "click", screenshot, x: 200, y: 100 }, signal);
  assert.deepEqual(calls.at(-1), { action: "click", x: 100, y: 50, expectedApp: "Fixture" });
  await assert.rejects(computer.call("computer_action", { action: "click", screenshot, x: 200, y: 100 }, signal), /fresh/);
});

test("external action intents persist before execution, deduplicate after restart and preserve uncertainty", async () => {
  const bridge = new AgentToolBridge(), receipts: import("../src/agent-tools.js").SharedToolAction[] = []; let writes = 0, failReceipt = false;
  (bridge as any).computer = new AgentComputer(async input => {
    if ((input as { action?: string }).action === "type") { assert.equal(receipts.at(-1)?.state, "started"); writes++; }
    return { data: "test", width: 1000, height: 600, pointWidth: 1000, pointHeight: 600, app: "Fixture" };
  });
  const issue = (runId: string) => bridge.issue({ runId, actionScope: "task:worker", priorActions: receipts, mode: "write", full: true, signal: new AbortController().signal, active: () => true,
    onActionState: async receipt => { if (failReceipt && receipt.state === "completed") throw new Error("Injected receipt write failure"); const index = receipts.findIndex(item => item.id === receipt.id); if (index < 0) receipts.push(receipt); else receipts[index] = receipt; } });
  const call = async (grant: Awaited<ReturnType<typeof issue>>, name: string, args = {}) => { const response = await fetch(grant.connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${grant.connection.token}` }, body: JSON.stringify({ name, arguments: args }) }); return { status: response.status, body: await response.json() as any }; };
  const first = await issue("one");
  try {
    let shot = JSON.parse((await call(first, "computer_screenshot")).body.content[0].text).screenshot;
    const args = { action: "type", screenshot: shot, text: "once", operationId: "submit-once" };
    assert.equal((await call(first, "computer_action", args)).status, 200); assert.equal(writes, 1);
    first.revoke();
    const second = await issue("two"); await call(second, "computer_screenshot");
    assert.match((await call(second, "computer_action", { action: "type", screenshot: shot, text: "missing ID" })).body.error, /operationId is required/);
    await call(second, "computer_screenshot");
    assert.match((await call(second, "computer_action", args)).body.content[0].text, /already completed/); assert.equal(writes, 1);
    assert.match((await call(second, "computer_action", { ...args, text: "different" })).body.error, /different action/);
    shot = JSON.parse((await call(second, "computer_screenshot")).body.content[0].text).screenshot;
    failReceipt = true; const uncertain = { action: "type", screenshot: shot, text: "uncertain", operationId: "uncertain" };
    assert.equal((await call(second, "computer_action", uncertain)).status, 400); assert.equal(writes, 2); assert.equal(receipts.at(-1)?.state, "uncertain");
    failReceipt = false; await call(second, "computer_screenshot");
    assert.match((await call(second, "computer_action", uncertain)).body.error, /uncertain/); assert.equal(writes, 2);
  } finally { await bridge.close(); }
});

test("Agent and Team desktop turns share a single cancellable ownership queue", async () => {
  const bridge = new AgentToolBridge(); (bridge as any).computer = new AgentComputer(async () => ({ data: "test", width: 1000, height: 600, pointWidth: 1000, pointHeight: 600, app: "Fixture" }));
  const issue = (runId: string) => bridge.issue({ runId, mode: "write", full: true, signal: new AbortController().signal, active: () => true });
  const first = await issue("agent"), second = await issue("team");
  const shot = (grant: typeof first) => fetch(grant.connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${grant.connection.token}` }, body: JSON.stringify({ name: "computer_screenshot", arguments: {} }) });
  try { await shot(first); const waiting = shot(second); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(bridge.control("desktop").state().waiting, 1); first.revoke(); assert.equal((await waiting).status, 200); }
  finally { await bridge.close(); }
});

test("agent bridge rejects expired capabilities, malformed calls and writes from side chats", async () => {
  const bridge = new AgentToolBridge(), controller = new AbortController();
  const grant = await bridge.issue({ runId: "bridge-test", mode: "read", full: false, signal: controller.signal, active: () => true });
  const call = async (name: string, args = {}) => { const response = await fetch(grant.connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${grant.connection.token}` }, body: JSON.stringify({ name, arguments: args }) }); return { status: response.status, body: await response.json() as any }; };
  try {
    assert.match((await call("browser_click", { ref: "e1" })).body.error, /read-only/);
    assert.match((await call("computer_screenshot")).body.error, /Full access/);
    assert.throws(() => validateAgentTool("browser_type", { ref: "e1", text: {}, extra: true }), /Invalid|Unexpected/);
    controller.abort(); assert.equal((await call("browser_snapshot")).status, 403);
  } finally { await bridge.close(); }
});

test("teammates keep exclusive tool ownership until their turn ends and reuse the same Chrome session", { skip: !chromeExecutable() }, async () => {
  const bridge = new AgentToolBridge(), controller = new AbortController();
  const first = await bridge.issue({ runId: "team-a", browserId: "task:shared-team", resourceOwner: "Claude", mode: "write", full: false, signal: controller.signal, active: () => true });
  const second = await bridge.issue({ runId: "team-b", browserId: "task:shared-team", resourceOwner: "Codex", mode: "write", full: false, signal: new AbortController().signal, active: () => true });
  const tabs = async (grant: typeof first) => { const r = await fetch(grant.connection.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${grant.connection.token}` }, body: JSON.stringify({ name: "browser_tabs", arguments: {} }) }); return { status: r.status, value: await r.json() as any }; };
  try {
    const original = await tabs(first); assert.equal(original.status, 200);
    const waiting = tabs(second);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(bridge.control("task:shared-team").state().waiting, 1);
    controller.abort();
    const continued = await waiting; assert.equal(continued.status, 200);
    // Chrome can finish setting about:blank's title while the next owner waits.
    // Session reuse is established by the same tab IDs, URLs and selection.
    const identities = (value: any) => JSON.parse(value.content[0].text).tabs.map(({ id, url, selected }: { id: string; url: string; selected: boolean }) => ({ id, url, selected }));
    assert.ok(identities(original.value).length > 0);
    assert.deepEqual(identities(continued.value), identities(original.value));
    assert.equal((await tabs(first)).status, 403);
  } finally { await bridge.close(); }
});

test("live browser viewer reconnects, rejects stale input and keeps tabs isolated by task", {skip:!chromeExecutable()}, async()=>{
  const bridge=new AgentToolBridge(), signal=new AbortController().signal;
  const first=await bridge.browser("task:first"), same=await bridge.browser("task:first"), other=await bridge.browser("task:other");
  assert.equal(same,first);assert.notEqual(other,first);
  const events:any[]=[];
  let stop=first.watch(event=>events.push(event));
  const until=async(check:()=>boolean)=>{const end=Date.now()+15000;while(!check()){if(Date.now()>end)throw new Error("No browser event");await new Promise(resolve=>setTimeout(resolve,25));}};
  try {
    await until(()=>events.some(event=>event.type==="frame")&&events.some(event=>event.type==="state"));
    const before=await first.call("browser_ui",{action:"state"},signal);
    await first.call("browser_ui",{action:"resize",width:640,height:480},signal);
    await assert.rejects(first.call("browser_ui",{action:"text",tab:before.selected,view:before.view,text:"stale"},signal),/changed/);
    await assert.rejects(first.call("browser_ui",{action:"resize",width:NaN,height:480},signal),/Invalid/);
    const current=await first.call("browser_ui",{action:"state"},signal);
    await assert.rejects(first.call("browser_ui",{action:"mouse",tab:current.selected,view:current.view,type:"mousePressed",button:"left",x:900,y:20},signal),/Invalid/);
    stop();stop();events.length=0;stop=first.watch(event=>events.push(event));
    await until(()=>events.some(event=>event.type==="frame"));
    assert.equal((await first.call("browser_ui",{action:"state"},signal)).selected,before.selected);
    const unrelated=await other.call("browser_ui",{action:"state"},signal);
    assert.notEqual(unrelated.selected,before.selected);
    await first.call("browser_tabs",{action:"new"},signal);
    const newTab=(await first.call("browser_ui",{action:"state"},signal)).selected;
    await first.call("browser_tabs",{action:"close",tab:newTab},signal);
    assert.equal((await first.call("browser_ui",{action:"state"},signal)).selected,before.selected);
    await first.call("browser_tabs",{action:"close",tab:before.selected},signal);
    const blank=await first.call("browser_ui",{action:"state"},signal);
    assert.ok(blank.selected);assert.notEqual(blank.selected,before.selected);assert.equal(blank.tabs.length,1);
    assert.equal(blank.tabs[0].url,"about:blank");
  } finally {stop();await bridge.close();}
});


test("Gemini normalized computer coordinates convert to display points explicitly", async () => {
  const calls: any[] = [], signal = new AbortController().signal;
  const computer = new AgentComputer(async input => { calls.push(input); return { data: "test", width: 1920, height: 1200, pointWidth: 1440, pointHeight: 900, app: "Fixture" }; });
  const shot = await computer.call("computer_screenshot", {}, signal), screenshot = JSON.parse(shot.content[0].text).screenshot;
  await assert.rejects(computer.call("computer_action", { action: "click", coordinateSpace: "normalized", screenshot, x: 1000, y: 500 }, signal), /outside/);
  await computer.call("computer_action", { action: "click", coordinateSpace: "normalized", screenshot, x: 500, y: 500 }, signal);
  assert.deepEqual(calls.at(-1), { action: "click", x: 720, y: 450, expectedApp: "Fixture" });
  assert.throws(() => validateAgentTool("computer_action", { action: "click", screenshot, coordinateSpace: "guess", x: 1, y: 1 }), /Invalid/);
});
