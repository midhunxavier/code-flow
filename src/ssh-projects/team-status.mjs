// Read-only probe. Never installs, starts or reconnects a team server, and never
// emits its owner token or the secret path in a device-access link.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function status() {
  let runtime;
  try { runtime = JSON.parse(await readFile(join(homedir(), ".codeflow/team-server/runtime.json"), "utf8")); }
  catch (error) { return { state: error.code === "ENOENT" ? "not-installed" : "unavailable" }; }
  if (runtime?.protocol !== 1 || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535
    || !/^[a-f0-9]{64}$/.test(runtime.token ?? "") || !/^[a-f0-9]{32}$/.test(runtime.instance ?? "")) return { state: "unavailable" };
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(4000), redirect: "error",
    });
    if (!response.ok) throw new Error("Status unavailable");
    return response.json();
  };
  try {
    const identity = await get("/api/team-host-runtime");
    if (identity.instance !== runtime.instance) return { state: "unavailable" };
    const remote = await get("/api/remote");
    let address;
    if (remote.enabled && remote.lan && remote.secure && !remote.lanError) {
      try {
        const url = new URL(remote.tailscaleUrl ?? remote.lanUrls?.[0]);
        if (url.protocol === "https:" && !url.username && !url.password) address = url.origin;
      } catch { /* An absent or invalid address cannot be shared. */ }
    }
    return {
      state: "running",
      access: !remote.enabled || !remote.lan ? "disabled" : remote.lanError ? "error" : address ? "ready" : "incomplete",
      ...(address ? { address } : {}),
      network: remote.transport === "tailscale" ? "Tailscale" : "Private network",
    };
  } catch { return { state: "unavailable" }; }
}
console.log("CODEFLOW_TEAM_STATUS " + JSON.stringify(await status()));
