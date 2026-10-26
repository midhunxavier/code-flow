#!/usr/bin/env node
// The documented HTTP client never shells out, reads provider credentials, or infers consent.
import { readFile, writeFile } from "node:fs/promises";

const [command = "help", ...args] = process.argv.slice(2);
const usage = `code-flow client

  codeflow client status
  codeflow client runs [search]
  codeflow client run request.json
  codeflow client readiness /absolute/repo [--execute]
  codeflow client verify /absolute/repo [profile.json]
  codeflow client pause RUN_ID
  codeflow client continue RUN_ID
  codeflow client resume RUN_ID
  codeflow client export RUN_ID [output.json]
  codeflow client diagnostics [output.json]

Set CODEFLOW_URL (default http://127.0.0.1:4317) and CODEFLOW_TOKEN to the
server's explicit Bearer token. Commands use the versioned /api/v1 routes.
Maintenance is separate: npm run maintenance -- --help.
`;
if (["help", "--help", "-h"].includes(command)) { process.stdout.write(usage); process.exit(0); }
const known = new Set(["status", "runs", "run", "readiness", "verify", "pause", "continue", "resume", "export", "diagnostics"]);
if (!known.has(command)) { process.stderr.write(`Unknown command: ${command}\n${usage}`); process.exit(2); }
const token = process.env.CODEFLOW_TOKEN;
if (!token) { process.stderr.write("Set CODEFLOW_TOKEN to the explicit token used by your server.\n"); process.exit(2); }
let origin;
try { origin = new URL(process.env.CODEFLOW_URL || "http://127.0.0.1:4317"); } catch {}
if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
  process.stderr.write("CODEFLOW_URL must be an HTTP(S) origin without embedded credentials, for example http://127.0.0.1:4317.\n"); process.exit(2);
}
const requestFile = async (path) => {
  if (!path) throw new Error("Name a JSON request file");
  const text = await readFile(path, "utf8");
  if (text.length > 40 * 1024 * 1024) throw new Error("Request file exceeds 40 MB");
  return JSON.parse(text);
};
const requireId = () => { if (!args[0] || !/^[a-zA-Z0-9-]{1,100}$/.test(args[0])) throw new Error("Choose a run ID"); return args[0]; };
let path = "/health", method = "GET", body, output;
try {
  switch (command) {
    case "runs": path = `/runs?limit=50${args[0] ? `&q=${encodeURIComponent(args[0])}` : ""}`; break;
    case "run": path = "/runs"; method = "POST"; body = await requestFile(args[0]); break;
    case "readiness": path = "/readiness"; method = "POST"; body = { repo: args[0], execute: args.includes("--execute") }; break;
    case "verify": path = "/verification"; method = "POST"; body = { repo: args[0], ...(args[1] ? { profile: await requestFile(args[1]) } : {}) }; break;
    case "pause": case "continue": path = `/runs/${requireId()}/pause`; method = "POST"; body = { paused: command === "pause" }; break;
    case "resume": path = `/runs/${requireId()}/resume`; method = "POST"; body = {}; break;
    case "export": path = `/runs/${requireId()}/export?transcript=1`; output = args[1]; break;
    case "diagnostics": path = "/diagnostics"; output = args[0]; break;
  }
  const response = await fetch(new URL(`/api/v1${path}`, origin), { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(command === "verify" || command === "readiness" ? 65 * 60_000 : 120_000), redirect: "error" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (output) { await writeFile(output, text, { mode: 0o600, flag: "wx" }); process.stdout.write(`Saved ${output}\n`); }
  else process.stdout.write(text);
} catch (error) { const cause = typeof error.cause?.code === "string" && /^[A-Z0-9_]+$/.test(error.cause.code) ? ` (${error.cause.code})` : "";
  process.stderr.write(`${error.message}${cause}${error.name === "TypeError" ? ` contacting ${origin.origin}` : ""}\n`); process.exitCode = 1; }
