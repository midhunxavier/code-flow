import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { childEnv } from "./env.js";

export interface TailscaleStatus {
  state: "connected" | "not-installed" | "needs-login" | "needs-approval" | "stopped" | "starting" | "unavailable";
  message: string;
  ip?: string;
  dnsName?: string;
}

/** Direct access only: never accept an arbitrary address from command output as a bind target. */
export function isTailscaleIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}

export function parseTailscaleStatus(output: string): TailscaleStatus {
  const raw = JSON.parse(output);
  if (!raw || typeof raw !== "object") throw new Error("Invalid Tailscale status");
  switch (raw.BackendState) {
    case "NeedsLogin": return { state: "needs-login", message: "Sign in to Tailscale on this computer, then refresh." };
    case "NeedsMachineAuth": return { state: "needs-approval", message: "Ask your tailnet administrator to approve this computer, then refresh." };
    case "Stopped": return { state: "stopped", message: "Turn on Tailscale on this computer, then refresh." };
    case "Starting": return { state: "starting", message: "Tailscale is connecting. Codeflow will check again automatically." };
    case "Running": break;
    default: return { state: "unavailable", message: "Tailscale is not ready. Open Tailscale on this computer and check its connection." };
  }
  if (raw.TUN === false) return { state: "unavailable", message: "Direct access needs Tailscale's network interface. Userspace networking is not supported." };
  if (raw.Self?.Online === false) return { state: "unavailable", message: "Tailscale reports this computer offline. Reconnect Tailscale, then refresh." };
  const ip = Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs.find((value: unknown) => typeof value === "string" && isTailscaleIPv4(value)) : undefined;
  if (!ip) return { state: "unavailable", message: "Tailscale has no usable IPv4 address. Reconnect Tailscale, then refresh." };
  const dns = typeof raw.Self?.DNSName === "string" ? raw.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  const dnsName = dns.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(dns) ? dns : undefined;
  return { state: "connected", message: "Tailscale is connected.", ip, ...(dnsName ? { dnsName } : {}) };
}

const run = promisify(execFile);
// macOS bundles its CLI in the app; TAILSCALE_BE_CLI avoids opening a GUI from a server.
// https://tailscale.com/docs/reference/tailscale-cli
function commands(): string[] {
  const names = ["tailscale"];
  if (process.platform === "darwin") names.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  if (process.platform === "win32") names.push(join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"));
  return names;
}

/** Read only. Never logs in, changes the tailnet, enables Serve/Funnel or returns peer identities. */
export async function detectTailscale(candidates = commands()): Promise<TailscaleStatus> {
  for (const command of candidates) {
    try {
      const { stdout } = await run(command, ["status", "--json", "--peers=false"], {
        env: childEnv({ TAILSCALE_BE_CLI: "1" }), timeout: 4_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
      return parseTailscaleStatus(stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Some versions exit nonzero while logged out, but still return a useful JSON status.
      const stdout = (error as { stdout?: string }).stdout;
      if (stdout) {
        try { return parseTailscaleStatus(stdout); } catch { /* malformed output is unavailable */ }
      }
      return { state: "unavailable", message: "Could not read Tailscale status. Open Tailscale and check that its service is running, then refresh." };
    }
  }
  return { state: "not-installed", message: "Install Tailscale on this computer and your remote device, sign in to the same tailnet, then refresh." };
}
