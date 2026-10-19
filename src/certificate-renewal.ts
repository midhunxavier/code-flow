import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { CertificateInfo } from "./remote-tls.js";

export const RENEW_BEFORE = 30 * 86400_000;
const HOUR = 3600_000;
type State = { identity: string; nextAttempt: number; failures: number; lastSuccess?: number; error?: string };
/** Persist retries before issuance so a restart cannot cause a tight certificate request loop. */
export class CertificateRenewal {
  private state?: State;
  private running = false;
  constructor(private file: string, private now = Date.now) {}
  async load() {
    try {
      const s = JSON.parse(await readFile(this.file, "utf8"));
      if (typeof s.identity === "string" && Number.isFinite(s.nextAttempt) && Number.isInteger(s.failures) && s.failures >= 0) {
        this.state = { identity: s.identity, nextAttempt: s.nextAttempt, failures: s.failures,
          lastSuccess: Number.isFinite(s.lastSuccess) ? s.lastSuccess : undefined, error: typeof s.error === "string" ? s.error : undefined };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Certificate renewal history could not be read"); }
  }
  private identity(info: CertificateInfo) { return `${info.hostname}:${info.expiresAt}`; }
  status(info?: CertificateInfo) {
    if (info?.source !== "tailscale") return undefined;
    const state = this.state?.identity === this.identity(info) ? this.state : undefined;
    return { automatic: true, running: this.running, nextAttempt: state?.nextAttempt ?? Math.max(0, info.expiresAt - RENEW_BEFORE), lastSuccess: state?.lastSuccess, error: state?.error };
  }
  private async save(state: State) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try { await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await rename(temp, this.file); this.state = state; }
    finally { await rm(temp, { force: true }); }
  }
  async tick(info: CertificateInfo | undefined, renew: () => Promise<CertificateInfo>) {
    const status = this.status(info);
    if (!info || !status || this.running || this.now() < status.nextAttempt) return;
    this.running = true;
    try {
      const failures = this.state?.identity === this.identity(info) ? this.state.failures : 0;
      const pending: State = { identity: this.identity(info), failures: Math.min(10, failures + 1),
        nextAttempt: this.now() + Math.min(24, 2 ** Math.min(failures, 5)) * HOUR, lastSuccess: status.lastSuccess };
      await this.save(pending);
      try {
        const renewed = await renew();
        await this.save({ identity: this.identity(renewed), failures: 0, lastSuccess: this.now(), nextAttempt: Math.max(this.now() + HOUR, renewed.expiresAt - RENEW_BEFORE) });
      } catch {
        // Do not expose command output or private certificate material through status.
        await this.save({ ...pending, error: "Automatic renewal failed. Check Tailscale is connected, HTTPS certificates are enabled, and this user can run tailscale cert. Codeflow will retry automatically." });
      }
    } finally { this.running = false; }
  }
}
