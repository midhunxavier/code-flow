// Development: rebuild the UI on change and restart the server on change (tsx watch).
// Use `npm run dev` (fake agents, port 4318) — never your real server on 4317.
import { spawn } from "node:child_process";

const ui = spawn(process.execPath, ["scripts/build-ui.mjs", "--watch"], { stdio: "inherit" });
const server = spawn("npx", ["tsx", "watch", "src/server.ts"], { stdio: "inherit", env: process.env });
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
