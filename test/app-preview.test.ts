import { test } from "node:test";
import assert from "node:assert/strict";
import { localAppUrl, localAppUrls } from "../src/local-app-url.js";

test("agent app addresses accept loopback ports and preserve paths without opening code-flow or credential URLs", () => {
  assert.deepEqual(localAppUrls("Server at [http://localhost:5173](http://localhost:5173). Also http://127.0.0.1:8000/app?tab=1#page.", "http://localhost:4317"), ["http://localhost:5173/", "http://127.0.0.1:8000/app?tab=1#page"]);
  assert.equal(localAppUrl("http://[::1]:1234/test"), "http://[::1]:1234/test");
  for (const value of ["http://localhost:4317/docs", "https://example.com", "http://localhost.evil:5173/", "http://localhost:5173@evil.example", "http://user:password@localhost:5173", "javascript:alert(1)", "http://localhost"]) assert.equal(localAppUrl(value, "http://localhost:4317"), undefined, value);
});
