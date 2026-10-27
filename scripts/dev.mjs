// Development: rebuild the UI on change and restart the server on change (tsx watch).
// Use `npm run dev` (fake agents, port 4318) — never your real server on 4317.
import "./check-node.mjs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// One session token for the whole dev session, so the browser stays signed in while tsx
// restarts the server on every change.
const env = { ...process.env, CODEFLOW_TOKEN: process.env.CODEFLOW_TOKEN || randomBytes(24).toString("hex") };

// --fake-agents: the stand-in CLIs, by absolute path (a relative or $PWD-based PATH entry
// silently falls back to the real CLIs — and your real quota — when the shell can't resolve it).
if (process.argv.includes("--fake-agents")) {
  const fakeBin = fileURLToPath(new URL("../test/fake-bin", import.meta.url));
  env.PATH = `${fakeBin}${delimiter}${env.PATH ?? ""}`;
  const resolved = execFileSync("which", ["claude", "codex", "agy"], { env }).toString().trim().split("\n");
  if (resolved.some((bin) => !bin.startsWith(fakeBin))) {
    console.error(`Refusing to start: fake agents expected, but found ${resolved.join(", ")}`);
    process.exit(1);
  }
  console.log("[dev] using fake agents from test/fake-bin");
}
const { buildTrainingWorker } = await import("./build-training-worker.mjs");
await buildTrainingWorker();
const ui = spawn(process.execPath, ["scripts/build-ui.mjs", "--watch"], { stdio: "inherit" });
const stable = process.argv.includes("--stable");
const server = spawn("npx", ["tsx", ...(stable ? [] : ["watch"]), "src/server.ts"], { stdio: "inherit", env });
const stop = () => {
  ui.kill("SIGTERM");
  server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => {
  ui.kill("SIGTERM");
  process.exit(code ?? 0);
});
