import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelConfirmations, confirmAction, confirmations, settleConfirmation } from "../ui/confirm-state.js";

const options = { title: "Delete task?", confirmLabel: "Delete task", danger: true };

test("confirmation queue resolves only the active request and ignores late close events", async () => {
  const first = confirmAction("First task", options);
  const second = confirmAction("Second task", options);
  const [one, two] = confirmations.value;
  settleConfirmation(two!.id, true);
  assert.equal(confirmations.value.length, 2);
  settleConfirmation(one!.id, true);
  assert.equal(await first, true);
  settleConfirmation(one!.id, false);
  assert.equal(confirmations.value[0]!.id, two!.id);
  settleConfirmation(two!.id, false);
  assert.equal(await second, false);
  assert.equal(confirmations.value.length, 0);
});

test("navigation and unmount cancellation resolve every pending action as declined", async () => {
  const pending = [confirmAction("First task", options), confirmAction("Second task", options)];
  const oldId = confirmations.value[0]!.id;
  cancelConfirmations();
  assert.deepEqual(await Promise.all(pending), [false, false]);
  assert.equal(confirmations.value.length, 0);
  const next = confirmAction("New task", options);
  settleConfirmation(oldId, true);
  assert.equal(confirmations.value.length, 1);
  cancelConfirmations();
  assert.equal(await next, false);
});
