import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sendAsset } from "../src/assets.js";

test("hashed assets negotiate compression and validate without retransmitting content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cf-assets-"));
  const name = "main-ABCDEF12.js", source = "export const example = 'hello';\n".repeat(100);
  try {
    await writeFile(join(dir, name), source);
    const request = async (headers: Record<string, string>, asset = name) => {
      let status = 0, resultHeaders: Record<string, string> = {}, body: Buffer | undefined;
      const response = { writeHead(code: number, values: Record<string, string>) { status = code; resultHeaders = values; }, end(value?: Buffer) { body = value; } };
      await sendAsset(dir, asset, { headers } as IncomingMessage, response as unknown as ServerResponse);
      return { status, headers: resultHeaders, body };
    };
    const br = await request({ "accept-encoding": "gzip, br" });
    assert.equal(br.status, 200); assert.equal(br.headers["content-encoding"], "br");
    assert.equal(brotliDecompressSync(br.body!).toString(), source);
    assert.match(br.headers["cache-control"]!, /immutable/);
    const cached = await request({ "accept-encoding": "br", "if-none-match": br.headers.etag! });
    assert.equal(cached.status, 304); assert.equal(cached.body, undefined);
    const gzip = await request({ "accept-encoding": "br;q=0, gzip" });
    assert.equal(gzip.headers["content-encoding"], "gzip"); assert.equal(gunzipSync(gzip.body!).toString(), source);
    const plain = await request({}); assert.equal(plain.body!.toString(), source); assert.notEqual(plain.headers.etag, br.headers.etag);
    await assert.rejects(request({}, "../private.txt"), /Asset not found/);
    await assert.rejects(request({}, "missing-ABCDEF12.js"), /Asset not found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
