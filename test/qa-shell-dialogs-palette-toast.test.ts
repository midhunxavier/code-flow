import test from "node:test";
import assert from "node:assert/strict";
Object.assign(globalThis, { window: {}, location: { hash: "", search: "", hostname: "localhost" } });
const { showToast, showError, dismissToast, toast } = await import("../ui/lib.js");
const current = () => toast.value;
test("action failures remain dismissible while ordinary success expires after two seconds", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  showToast("Saved"); assert.equal(current()?.kind, "info"); t.mock.timers.tick(1999); assert.equal(current()?.text, "Saved"); t.mock.timers.tick(1); assert.equal(current(), null);
  showError("Cannot connect"); const id = current()!.id; t.mock.timers.tick(60_000); assert.equal(current()?.kind, "error"); assert.equal(current()?.text, "Cannot connect"); dismissToast(id); assert.equal(current(), null);
});
test("explicit error durations have a readable minimum and stale dismissal cannot remove newer feedback", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  showError("Old failure", 100); const old = current()!.id; t.mock.timers.tick(5999); assert.equal(current()?.text, "Old failure"); t.mock.timers.tick(1); assert.equal(current(), null);
  showError("Persistent failure"); showError("Newest failure"); assert.notEqual(current()?.id, old); dismissToast(old); assert.equal(current()?.text, "Newest failure"); dismissToast(); assert.equal(current(), null);
});
