import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

/** Single-use, short-lived browser handoffs. Never return these secrets through MCP. */
export class WorkspaceHandoffs {
  private tickets = new Map<string, { path: string; expires: number; signIn: boolean }>();
  constructor(private now = () => Date.now()) {}
  /**
   * Default: a 60-second ticket for an immediate `codeflow open`, which signs that browser in.
   * Approval links live for the confirmation's lifetime and pass `signIn: false`: anything holding the
   * CLI bootstrap secret can ask for one, so it must never turn into an owner session.
   */
  issue(path: string, ttlMs = 60_000, bytes = 32, signIn = true) {
    if (!/^\/\?team=local#\/(?:chat\/[a-f0-9]{32}|run\/[a-zA-Z0-9-]+)$/.test(path)) throw new Error("Invalid workspace destination");
    for (const [id, t] of this.tickets) if (t.expires <= this.now()) this.tickets.delete(id);
    if (this.tickets.size >= 100) throw new Error("Too many pending browser handoffs; try again shortly");
    const id = randomBytes(bytes).toString("hex"); this.tickets.set(id, { path, expires: this.now() + ttlMs, signIn }); return id;
  }
  revoke(id: string) { this.tickets.delete(id); }
  consume(id: string) { return this.redeem(id)?.path; }
  /** Single use: the destination, and whether this ticket may sign the browser in. */
  redeem(id: string) { const ticket = this.tickets.get(id); this.tickets.delete(id); return ticket && ticket.expires > this.now() ? { path: ticket.path, signIn: ticket.signIn } : undefined; }
}
export async function openWorkspaceBrowser(url: string): Promise<boolean> {
  // A remote/headless shell must not launch a browser on the wrong computer.
  if (process.env.CODEFLOW_NO_BROWSER === "1" || process.env.SSH_CONNECTION || process.env.CODEFLOW_SSH_HOST || process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", code => { clearTimeout(timer); resolve(code === 0); });
  });
}
