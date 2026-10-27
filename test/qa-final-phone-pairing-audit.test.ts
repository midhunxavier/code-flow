import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeExpectedCount401, type Count401, type PhoneTransitions } from "./phone-pairing-audit.js";

const remote = "https://127.0.0.1:12345";
const url = `${remote}/api/projects/counts`;
const transitions: PhoneTransitions = { remote, revokedAt: 10, revoked: true, rotatedAt: 20, rotated: true };
const event = (changes: Partial<Count401> = {}): Count401 => ({ page: "phone", url, method: "GET", status: 401, body: { error: "Not signed in: use the owner link or sign in to shared projects", signIn: true }, receivedAt: 11, ...changes });

test("only a matched phone revocation or rotation response is consumed once", () => {
  const records = [event(), event({ page: "other", receivedAt: 21 })];
  assert.equal(consumeExpectedCount401("phone", url, records, transitions), true);
  assert.equal(consumeExpectedCount401("phone", url, records, transitions), false);
  assert.equal(consumeExpectedCount401("other", url, records, transitions), true);
  assert.deepEqual(records, []);
});

test("unknown, premature and unconfirmed authentication failures are retained", () => {
  const cases: [Count401, PhoneTransitions, Count401["page"], string][] = [
    [event({ page: "unknown" }), transitions, "unknown", url],
    [event({ receivedAt: 9 }), transitions, "phone", url],
    // Revocation started at 10, but this response arrived at 15 before confirmation at 20.
    [event({ receivedAt: 15 }), { ...transitions, revokedAt: 20 }, "phone", url],
    // Rotation started at 20; confirmation occurred at 30.
    [event({ page: "other", receivedAt: 25 }), { ...transitions, rotatedAt: 30 }, "other", url],
    [event(), { ...transitions, revoked: false }, "phone", url],
    [event({ page: "other", receivedAt: 19 }), transitions, "other", url],
    [event({ page: "other", receivedAt: 21 }), { ...transitions, rotated: false }, "other", url],
    [event(), transitions, "other", url],
    [event(), transitions, "phone", `${url}?different=1`],
    [event({ url: "https://other.example/api/projects/counts" }), transitions, "phone", "https://other.example/api/projects/counts"],
    [event({ method: "POST" }), transitions, "phone", url],
    [event({ status: 403 }), transitions, "phone", url],
    [event({ body: { error: "different", signIn: true } }), transitions, "phone", url],
    [event({ body: { error: "Not signed in: use the owner link or sign in to shared projects", signIn: true, extra: true } }), transitions, "phone", url],
    [event({ body: undefined }), transitions, "phone", url],
  ];
  for (const [response, context, page, consoleUrl] of cases) {
    const records = [response];
    assert.equal(consumeExpectedCount401(page, consoleUrl, records, context), false, JSON.stringify({ response, context, page, consoleUrl }));
    assert.deepEqual(records, [response]);
  }
});
