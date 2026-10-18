import { test } from "node:test";
import assert from "node:assert/strict";
import { redactExport, redactText } from "../src/privacy.js";
test("export redaction removes credential-bearing URL userinfo across common source and database schemes", () => {
  const text = "npm https://alice:p%40ssw0rd@registry.example/package postgres://owner:dbsecret@localhost/database redis://:cache-secret@localhost/0";
  const redacted = redactText(text, []);
  assert.equal(redacted, "npm https://[REDACTED]@registry.example/package postgres://[REDACTED]@localhost/database redis://[REDACTED]@localhost/0");
  assert.deepEqual(redactExport({ dependencies: ["git+https://user:source-secret@example.invalid/repo"], password: "plain" }), { dependencies: ["git+https://[REDACTED]@example.invalid/repo"], password: "[REDACTED]" });
  assert.equal(redactText("https://example.invalid/path?a=b and an email user@example.invalid", []), "https://example.invalid/path?a=b and an email user@example.invalid");
});
