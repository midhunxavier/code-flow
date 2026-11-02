import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliTeamError, fail } from "./model.js";
import { CliTeamsService, tokenMatches } from "./service.js";

export interface RuntimeDescriptor { version: 1; pid: number; endpoint: string; bootstrap: string }
export const RUNTIME_FILE = "cli-teams-runtime.json";
/** Separate loopback transport; execution still belongs to the web runtime's RunManager. */
export async function startCliTeamsTransport(service: CliTeamsService) {
  const bootstrap = randomBytes(32).toString("hex");
  const capabilities = new Map<string, Awaited<ReturnType<CliTeamsService["connect"]>>>();
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    void (async () => {
      const address = server.address();
      if (!address || typeof address === "string" || req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin || req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/json")) fail("scope_denied", "Use the local authenticated CLI transport");
      const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const privileged = tokenMatches(bearer, bootstrap), connection = capabilities.get(bearer);
      if (!privileged && !connection) fail("scope_denied", "Invalid CLI connection");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) fail("validation_failed", "Request exceeds 64 KiB"); chunks.push(chunk); }
      let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("validation_failed", "Expected JSON request"); }
      let data: unknown;
      if (req.url === "/connect" && privileged) {
        if (!body || typeof body.projectRoot !== "string") fail("validation_failed", "Choose the project root");
        for (const [token, c] of capabilities) if (!c.active || c.expiresAt < Date.now()) capabilities.delete(token);
        const c = await service.connect(body.projectRoot), token = randomBytes(32).toString("hex"); capabilities.set(token, c);
        data = { token, connectionId: c.id };
      } else if (req.url === "/call" && connection) data = await service.call(connection, body.name, body.arguments ?? {});
      else if (req.url === "/heartbeat" && connection) { service.heartbeat(connection); data = {}; }
      else if (req.url === "/disconnect" && connection) { service.disconnect(connection); capabilities.delete(bearer); data = {}; }
      else if (["/preview", "/confirm", "/attach"].includes(req.url ?? "") && privileged) {
        const c = await service.connect(body.projectRoot);
        try {
          data = req.url === "/preview" ? await service.acceptancePreview(c, body.proposalId, body.revision)
            : req.url === "/confirm" ? await service.accept(c, body.proposalId, body.revision, body.hash)
            : await service.attach(c, body.runId, body.connectionId);
        } finally { service.disconnect(c); }
      } else fail("scope_denied", "Unknown or unauthorized CLI operation");
      send(200, { protocolVersion: 1, ok: true, data });
    })().catch(error => send(error instanceof CliTeamError && error.code === "scope_denied" ? 403 : 400, { protocolVersion: 1, ok: false, error: { code: error instanceof CliTeamError ? error.code : "operation_failed", message: error instanceof Error ? error.message : "CLI request failed", details: error instanceof CliTeamError ? error.details : undefined } }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No CLI listener");
  const descriptor: RuntimeDescriptor = { version: 1, pid: process.pid, endpoint: `http://127.0.0.1:${address.port}`, bootstrap };
  const file = join(service.home, RUNTIME_FILE), temp = `${file}.${process.pid}.tmp`;
  await mkdir(service.home, { recursive: true });
  try { await writeFile(temp, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" }); await rename(temp, file); }
  catch (error) { server.close(); await rm(temp, { force: true }); throw error; }
  return { descriptor, async close() {
    for (const c of capabilities.values()) service.disconnect(c);
    capabilities.clear(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const current = await readFile(file, "utf8").then(JSON.parse, () => undefined);
    if (current?.bootstrap === bootstrap) await rm(file, { force: true });
  } };
}
