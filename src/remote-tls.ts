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
export interface InspectedCertificate { certificate: X509Certificate; validFrom: number; expiresAt: number; hostnames: string[] }
/** Parse key identity once; validity is evaluated again whenever remote access is used. */
export function inspectEnvironmentCertificate(certPem: string | Buffer, keyPem: string | Buffer): InspectedCertificate {
  if (Buffer.byteLength(certPem) > 128 * 1024 || Buffer.byteLength(keyPem) > 32 * 1024) throw new Error("Choose a PEM certificate and private key within the size limits");
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
    if (!certificate.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("mismatch");
    createSecureContext({ cert: certPem, key: keyPem, minVersion: "TLSv1.2" });
  } catch { throw new Error("The certificate and private key could not be read or do not match. Use PEM files with an unencrypted private key."); }
  const validFrom = Date.parse(certificate.validFrom), expiresAt = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt)) throw new Error("The certificate has invalid validity dates");
  // Only advertise literal SAN names, rechecked against the parsed certificate. Wildcards
  // and escaped/non-hostname names cannot themselves be used as a pairing-link address.
  const hostnames = [...new Set((certificate.subjectAltName ?? "").split(", ").flatMap(part => {
    const raw = part.match(/^(?:DNS|IP Address):(.+)$/)?.[1];
    if (!raw) return [];
    try { const host = certificateHostname(raw); return certificateCoversHost(certificate, host) ? [host] : []; } catch { return []; }
  }))];
  return { certificate, validFrom, expiresAt, hostnames };
}
export function certificateCoversHost(certificate: X509Certificate, hostname: string): boolean {
  return !!(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname, { subject: "never" }));
}
export const certificateTimeInvalid = (info: Pick<InspectedCertificate, "validFrom" | "expiresAt">, now = Date.now()) => info.validFrom > now || info.expiresAt <= now;
/** Check material before saving or replacing a listener. Never include private key contents in errors. */
export function validateRemoteCertificate(input: RemoteCertificate, now = Date.now(), allowExpired = false): CertificateInfo {
  const hostname = certificateHostname(input.hostname);
  if (input.source !== "import" && input.source !== "tailscale") throw new Error("Choose Tailscale or import a certificate");
  if (typeof input.cert !== "string" || typeof input.key !== "string") throw new Error("Choose a PEM certificate and private key within the size limits");
  const info = inspectEnvironmentCertificate(input.cert, input.key);
  if ((!allowExpired && info.expiresAt <= now) || info.validFrom > now) throw new Error("The certificate is expired or not valid yet");
  if (!certificateCoversHost(info.certificate, hostname)) throw new Error("The certificate does not cover this hostname or IP address");
  return { hostname, source: input.source, expiresAt: info.expiresAt };
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
