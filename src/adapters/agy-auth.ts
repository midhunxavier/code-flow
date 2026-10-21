import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Native CLI diagnostics, never model responses. Do not return or persist the input text. */
export function agyCredentialFailure(text: string): boolean {
  return /(?:token refresh failed|failed to refresh loaded token|failed to (?:save|persist|marshal) (?:refreshed (?:OAuth )?token|credentials)|failed to (?:save|persist) token to keyring|failed to load (?:stored )?token from keyring, falling back to file|stored credentials are invalid or expired)/i.test(text);
}

export interface AgyAuthObservation {
  log: "read" | "missing" | "unreadable" | "too-large";
  refreshObserved: boolean;
  credentialFailure: boolean;
  interactiveAuthObserved: boolean;
  loadedTokenExpired: boolean | null;
}
export const AGY_AUTH_LOG_LIMIT = 4 * 1024 * 1024;

/** Only known native auth source lines count as evidence; never scrape dates, accounts or tokens.
 * Refresh evidence is observational and cannot grant access or expand runtime permissions. */
export function observeAgyAuthLine(observation: AgyAuthObservation, line: string): void {
  const message = line.match(/\b(?:auth|auth_provider|server_oauth|credentials|keyring)\.go:\d+\]\s+(.*)$/)?.[1];
  if (!message) return;
  if (/token refreshed, new expiry=|Auto-saving refreshed token from token source callback/.test(message)) observation.refreshObserved = true;
  if (agyCredentialFailure(message)) observation.credentialFailure = true;
  if (/OAuth: starting OAuth flow/.test(message)) observation.interactiveAuthObserved = true;
  const expired = message.match(/keyringAuth: loaded token, [^\r\n]*\bexpired=(true|false)\b/)?.[1];
  if (expired) observation.loadedTokenExpired = observation.loadedTokenExpired === true || expired === "true";
}

/** Private per-turn log only. Bounded reads, no symlink traversal, no raw diagnostics returned. */
export async function inspectAgyAuthLog(path: string): Promise<AgyAuthObservation> {
  const result: AgyAuthObservation = { log: "unreadable", refreshObserved: false, credentialFailure: false, interactiveAuthObserved: false, loadedTokenExpired: null };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) return result;
    if (stat.size > AGY_AUTH_LOG_LIMIT) { result.log = "too-large"; return result; }
    const buffer = Buffer.alloc(16 * 1024);
    let consumed = 0, pending = "", dropped = false;
    while (consumed <= AGY_AUTH_LOG_LIMIT) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, AGY_AUTH_LOG_LIMIT + 1 - consumed), consumed);
      if (!bytesRead) break;
      consumed += bytesRead;
      if (consumed > AGY_AUTH_LOG_LIMIT) { result.log = "too-large"; return result; }
      // Auth markers are ASCII. Cap each line independently of arbitrary diagnostic payloads.
      for (const part of buffer.subarray(0, bytesRead).toString("latin1").split(/(?<=\n)/)) {
        if (!dropped) {
          pending += part;
          if (pending.length > 8192) { pending = ""; dropped = true; }
        }
        if (part.endsWith("\n")) {
          if (!dropped) observeAgyAuthLine(result, pending.trimEnd());
          pending = ""; dropped = false;
        }
      }
    }
    if (pending && !dropped) observeAgyAuthLine(result, pending);
    result.log = "read";
    return result;
  } catch (error) {
    result.log = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    return result;
  } finally { await file?.close(); }
}
