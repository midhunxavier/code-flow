import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalSharedPath } from "../src/shared-access.js";

test("canonicalization rejects ambiguous traversal, encoded separators, double encoding and appended route segments", () => {
  for (const path of ["/api/runs/../accounts", "/api/runs/%2e%2e/accounts", "/api/runs%2fone", "/api/runs%5cone", "/api/%252e%252e/accounts", "/api/runs//one", "/api/runs/one/", "/api/runs/one%00", "/api/runs/one%0a", "/api\\runs", "https://host/api/runs", "/api/runs/#extra"]) assert.throws(() => canonicalSharedPath(path), /path/);
  assert.deepEqual(canonicalSharedPath("/api/v1/runs/one?ignored=a%2fb").parts, ["api", "runs", "one"]);
});
