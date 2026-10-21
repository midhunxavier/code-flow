import { test } from "node:test";
import assert from "node:assert/strict";
import { localAppUrl, localAppUrls } from "../src/local-app-url.js";
import { embeddingBlocked, inspectFramePolicy } from "../src/frame-policy.js";

test("agent app addresses accept loopback ports and preserve paths without opening code-flow or credential URLs", () => {
  assert.deepEqual(localAppUrls("Server at [http://localhost:5173](http://localhost:5173). Also http://127.0.0.1:8000/app?tab=1#page.", "http://localhost:4317"), ["http://localhost:5173/", "http://127.0.0.1:8000/app?tab=1#page"]);
  assert.equal(localAppUrl("http://[::1]:1234/test"), "http://[::1]:1234/test");
  for (const value of ["http://localhost:4317/docs", "https://example.com", "http://localhost.evil:5173/", "http://localhost:5173@evil.example", "http://user:password@localhost:5173", "javascript:alert(1)", "http://localhost"]) assert.equal(localAppUrl(value, "http://localhost:4317"), undefined, value);
});

test("external frame restrictions distinguish blocked embedding from allowed framing", () => {
  const page = "https://aerobase.se", parent = "http://localhost:4317";
  assert.match(embeddingBlocked({ "x-frame-options": "SAMEORIGIN" }, page, parent)!, /SAMEORIGIN/);
  assert.equal(embeddingBlocked({ "x-frame-options": "SAMEORIGIN" }, page, page), undefined);
  assert.match(embeddingBlocked({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }, page, parent)!, /frame-ancestors/);
  assert.equal(embeddingBlocked({ "x-frame-options": "DENY", "content-security-policy": `frame-ancestors ${parent}` }, page, parent), undefined, "CSP frame-ancestors overrides X-Frame-Options");
  assert.equal(embeddingBlocked({ "content-security-policy": "frame-ancestors https://*.example.com" }, page, "https://app.example.com"), undefined);
  assert.match(embeddingBlocked({ "content-security-policy": "frame-ancestors https://*.example.com" }, page, "https://example.com.evil")!, /frame-ancestors/);
  assert.match(embeddingBlocked({ "content-security-policy": ["frame-ancestors *", "frame-ancestors 'self'"] }, page, parent)!, /frame-ancestors/);
  assert.match(embeddingBlocked({ "content-security-policy": "frame-ancestors *, frame-ancestors 'self'" }, page, parent)!, /frame-ancestors/, "combined CSP headers enforce every policy");
  assert.equal(embeddingBlocked({ "content-security-policy": "frame-ancestors *; frame-ancestors 'none'" }, page, parent), undefined, "the first duplicate directive wins within a policy");
  assert.match(embeddingBlocked({ "x-frame-options": "SAMEORIGIN, SAMEORIGIN" }, page, parent)!, /SAMEORIGIN/);
  assert.equal(embeddingBlocked({}, page, parent), undefined);
});

test("frame inspection rejects local services, metadata, credentials and non-web protocols", async () => {
  for (const address of ["http://127.0.0.1:1234", "http://[::1]:1234", "http://169.254.169.254/", "http://user:password@example.com", "file:///etc/passwd"]) await assert.rejects(inspectFramePolicy(address, "http://localhost:4317"));
});
