import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

export interface RemoteCertificate {
  cert: string;
  key: string;
  hostname: string;
  source: "import" | "tailscale";
}
export interface CertificateInfo { hostname: string; source: "import" | "tailscale"; expiresAt: number }
const FILE = join(CODEFLOW_HOME, "remote-tls.json");
export function certificateHostname(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Enter the hostname or IP address your other device will use");
  const host = raw.trim().toLowerCase();
  if (!host || host.length > 253 || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))) throw new Error("Enter a hostname or IP address without https://, a port or a path");
  return host;
}
/** Check material before saving or replacing a listener. Never include private key contents in errors. */
export function validateRemoteCertificate(input: RemoteCertificate, now = Date.now(), allowExpired = false): CertificateInfo {
  const hostname = certificateHostname(input.hostname);
  if (input.source !== "import" && input.source !== "tailscale") throw new Error("Choose Tailscale or import a certificate");
  if (typeof input.cert !== "string" || typeof input.key !== "string" || input.cert.length > 128 * 1024 || input.key.length > 32 * 1024) throw new Error("Choose a PEM certificate and private key within the size limits");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(input.cert);
    const key = createPrivateKey(input.key);
    if (!cert.checkPrivateKey(key)) throw new Error("mismatch");
    createSecureContext({ cert: input.cert, key: input.key, minVersion: "TLSv1.2" });
  } catch { throw new Error("The certificate and private key could not be read or do not match. Use PEM files with an unencrypted private key."); }
  const expiresAt = Date.parse(cert.validTo);
  if (!Number.isFinite(expiresAt) || (!allowExpired && expiresAt <= now) || Date.parse(cert.validFrom) > now) throw new Error("The certificate is expired or not valid yet");
  if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { subject: "never" }))) throw new Error("The certificate does not cover this hostname or IP address");
  return { hostname, source: input.source, expiresAt };
}
export async function loadRemoteCertificate(file = FILE, allowExpired = false): Promise<RemoteCertificate | undefined> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Saved HTTPS configuration could not be read. Import or renew the certificate in Remote access settings."); }
  let value: RemoteCertificate;
  try { value = JSON.parse(raw); validateRemoteCertificate(value, Date.now(), allowExpired); } catch { throw new Error("Saved HTTPS configuration is invalid or expired. Import or renew the certificate in Remote access settings."); }
  return value;
}
export async function saveRemoteCertificate(value: RemoteCertificate, file = FILE): Promise<void> {
  validateRemoteCertificate(value);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
