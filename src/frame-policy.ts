import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { addressKind, snapshotUrl } from "./snapshot.js";

export function embeddingBlocked(headers: Record<string, string | string[] | undefined>, page: string, parent: string): string | undefined {
  const origin = new URL(page).origin, parentUrl = new URL(parent);
  const policies = [headers["content-security-policy"] ?? []].flat().flatMap(policy => policy.split(","));
  const ancestors = policies.flatMap(policy => {
    // Duplicate directives in one policy use the first occurrence; separate policies all apply.
    const directive = policy.split(";").map(value => value.trim()).find(value => /^frame-ancestors(?:\s|$)/i.test(value));
    return directive ? [directive] : [];
  });
  const allows = (source: string) => {
    if (source === "*") return true;
    if (source === "'self'") return origin === parentUrl.origin;
    if (/^https?:$/.test(source)) return parentUrl.protocol === source;
    try {
      const candidate = new URL(source.includes("://") ? source.replace(/:\*(?=\/|$)/, ":65535") : `${new URL(page).protocol}//${source}`);
      const host = candidate.hostname;
      return candidate.protocol === parentUrl.protocol && (host === parentUrl.hostname || host.startsWith("*.") && parentUrl.hostname.endsWith(host.slice(1))) && (/:\*(?:\/|$)/.test(source) || candidate.port === parentUrl.port);
    } catch { return false; }
  };
  // An enforced frame-ancestors directive overrides X-Frame-Options.
  if (ancestors.length) return ancestors.some(policy => !policy.split(/\s+/).slice(1).some(allows)) ? "Content-Security-Policy frame-ancestors" : undefined;
  const frame = [headers["x-frame-options"] ?? []].flat().flatMap(value => value.toUpperCase().split(",")).map(value => value.trim());
  const restriction = frame.find(value => value === "DENY" || value === "SAMEORIGIN" && origin !== parentUrl.origin);
  return restriction ? `X-Frame-Options: ${restriction}` : undefined;
}

/** Inspect public page headers without forwarding cookies or reaching loopback/metadata addresses. */
export async function inspectFramePolicy(address: string, parent: string): Promise<{ blocked: boolean; reason?: string; url: string }> {
  let url = new URL(snapshotUrl(address));
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.username || url.password) throw new Error("Page inspection does not accept credentials in URLs");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(value => addressKind(value.address))) throw new Error("External page inspection cannot reach loopback or link-local addresses");
    const destination = addresses.find(value => value.family === 4) ?? addresses[0]!;
    const response = await new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "HEAD", agent: false, family: destination.family, signal: AbortSignal.timeout(5000), maxHeaderSize: 32 * 1024,
        // Pin the checked DNS answer so a second resolution cannot redirect the request locally.
        lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
      }, result => { result.destroy(); resolve({ status: result.statusCode ?? 0, headers: result.headers }); });
      request.on("error", reject); request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      url = new URL(snapshotUrl(new URL(response.headers.location, url).href)); continue;
    }
    const reason = embeddingBlocked(response.headers, url.href, parent);
    return { blocked: !!reason, reason, url: url.href };
  }
  throw new Error("The external page redirected too many times");
}
