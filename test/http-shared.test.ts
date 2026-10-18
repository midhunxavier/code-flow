import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { HttpError, readJson, readLoginJson } from "../src/http.js";
const request = (headers: Record<string, string> = {}) => Object.assign(new PassThrough(), { headers: { "content-type": "application/json", ...headers } }) as unknown as IncomingMessage & Pick<PassThrough, "write" | "end">;

test("operation-specific JSON limits reject declared and streamed overflow while ordinary uploads retain their default", async () => {
  const declared = request({ "content-length": "100" }); await assert.rejects(readJson(declared, 10), (error: unknown) => error instanceof HttpError && error.status === 413); declared.destroy();
  const streamed = request(); const tooLarge = readJson(streamed, 8); streamed.end('{"body":"too long"}'); await assert.rejects(tooLarge, (error: unknown) => error instanceof HttpError && error.status === 413);
  const ordinary = request(); const parsed = readJson(ordinary); ordinary.end(JSON.stringify({ attachment: "a".repeat(20000) })); assert.equal((await parsed).attachment.length, 20000);
});
test("absolute body deadlines destroy dribbling requests rather than renewing their timeout on each byte", async () => {
  const slow = request(); const parsed = readJson(slow, 100, { timeoutMs: 25 });
  const drip = setInterval(() => slow.write(" "), 5);
  try { await assert.rejects(parsed, (error: unknown) => error instanceof HttpError && error.status === 408); assert.equal(slow.destroyed, true); }
  finally { clearInterval(drip); slow.destroy(); }
});
test("anonymous login body admission is bounded and releases capacity on success and parse failure", async () => {
  const pending = Array.from({ length: 4 }, () => request()); const parsing = pending.map((req) => readLoginJson(req)); const fifth = request();
  await assert.rejects(readLoginJson(fifth), (error: unknown) => error instanceof HttpError && error.status === 429); fifth.destroy();
  pending.forEach((req) => req.end("{}")); await Promise.all(parsing);
  const invalid = request(); const rejected = readLoginJson(invalid); invalid.end("not json"); await assert.rejects(rejected, /Invalid JSON/);
  const next = request(); const available = readLoginJson(next); next.end('{"username":"reviewer"}'); assert.equal((await available).username, "reviewer");
});
test("authorization and dispatch share a parsed body without weakening a later operation limit", async () => {
  const req = request(); const first = readJson(req, 1024); req.end('{"repo":"/repo","path":"src/file.ts"}'); const body = await first; assert.deepEqual(await readJson(req, 1024), body, "downstream dispatch does not consume an empty request after authorization"); await assert.rejects(readJson(req, 8), (error: unknown) => error instanceof HttpError && error.status === 413);
});
