#!/usr/bin/env node
// Dependency-free stdio MCP transport. Only the parent-created member capability is used;
// this process has no file, shell, permission-approval, or identity-selection operations.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

let connection;
try { connection = process.argv[2] === "--connection" ? JSON.parse(readFileSync(process.argv[3], "utf8")) : undefined; } catch { process.exit(1); }
const endpoint = connection?.endpoint ?? process.env.CODEFLOW_TEAM_ENDPOINT;
const token = connection?.token ?? process.env.CODEFLOW_TEAM_CAPABILITY;
delete process.env.CODEFLOW_TEAM_CAPABILITY;
delete process.env.CODEFLOW_TOKEN;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/v1\/runs\//.test(endpoint) || !token) process.exit(1);

let initialized = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function bridge(body) {
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? "Team bridge request failed");
  return result;
}
async function request(message) {
  // JSON can parse successfully without yielding a JSON-RPC object (for example null).
  // Reject the envelope before dereferencing it so malformed input cannot terminate MCP.
  const validId = (id) => typeof id === "string" || typeof id === "number" && Number.isFinite(id);
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" || (message.id !== undefined && !validId(message.id))) {
    send({ jsonrpc: "2.0", id: validId(message?.id) ? message.id : null, error: { code: -32600, message: "Invalid request" } }); return;
  }
  const id = message.id;
  if (id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") {
      initialized = true;
      const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      result = { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "code-flow-team", version: "1.0.0" } };
    } else if (message.method === "ping") result = {};
    else if (!initialized) throw new Error("Initialize the team bridge first");
    else if (message.method === "tools/list") result = await bridge({ method: "tools/list" });
    else if (message.method === "tools/call") {
      try {
        const value = await bridge({ name: message.params?.name, arguments: message.params?.arguments ?? {} });
        result = { content: [{ type: "text", text: JSON.stringify(value.result) }], isError: false };
      } catch (error) { result = { content: [{ type: "text", text: error instanceof Error ? error.message : "Team command failed" }], isError: true }; }
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }); return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (error) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "Team bridge failed" } }); }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let inflight = 0;
for await (const line of input) {
  if (line.length > 64 * 1024 || inflight >= 4) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request exceeds bridge limits" } }); continue; }
  try {
    const message = JSON.parse(line);
    inflight++;
    void request(message).finally(() => { inflight--; });
  } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
}
