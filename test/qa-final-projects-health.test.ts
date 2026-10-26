import { test } from "node:test";
import assert from "node:assert/strict";
Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1400, addEventListener() {} } });
Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "127.0.0.1", hash: "", origin: "http://127.0.0.1" } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
const state = await import("../ui/state.js");

test("project choices appear while health is pending, without skipping the storage diagnosis gate", async () => {
  let release!: (response: Response) => void, settled = false;
  const health = new Promise<Response>(resolve => release = resolve);
  globalThis.fetch = ((input: string) => input.includes("/api/health") ? health : Promise.resolve(new Response(JSON.stringify([{ id: "p-ready", name: "Available project", repos: ["/fixture"], createdAt: 1 }])))) as typeof fetch;
  const loading = state.loadProjects().then(() => { settled = true; });
  try {
    const deadline = Date.now() + 500;
    while (!state.projects.value.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.projects.value[0]?.id, "p-ready", "the project list must not wait for unrelated health diagnostics");
    assert.equal(settled, false, "boot still waits for storage diagnosis before restoring drafts");
    assert.equal(state.projectsLoaded.value, false);
  } finally { release(new Response(JSON.stringify({ projects: { available: false, reason: "fixture storage diagnosis" } }))); await loading; }
  assert.equal(state.projectsLoaded.value, true);
  assert.equal(state.projectsStatus.value.available, false, "the eventual storage diagnosis remains authoritative");
});
