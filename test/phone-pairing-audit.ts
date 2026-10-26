/** Evidence used to pair a browser console error with one observed, authenticated lifecycle response. */
export interface Count401 {
  page: "phone" | "other" | "unknown";
  url: string;
  method: string;
  status: number;
  body: unknown;
  receivedAt: number;
}
export interface PhoneTransitions {
  remote: string;
  revokedAt: number;
  revoked: boolean;
  rotatedAt: number;
  rotated: boolean;
}

/** Consume at most one precisely observed 401 for a phone invalidated by this fixture. */
export function consumeExpectedCount401(page: Count401["page"], url: string, responses: Count401[], transitions: PhoneTransitions): boolean {
  const index = responses.findIndex(response => {
    if (response.page !== page || response.url !== url || url !== `${transitions.remote}/api/projects/counts` || response.method !== "GET" || response.status !== 401) return false;
    const body = response.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = body as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "error,signIn" || value.error !== "Not signed in: use the owner link or sign in to shared projects" || value.signIn !== true) return false;
    return page === "phone" && transitions.revoked && transitions.revokedAt > 0 && response.receivedAt >= transitions.revokedAt
      || page === "other" && transitions.rotated && transitions.rotatedAt > 0 && response.receivedAt >= transitions.rotatedAt;
  });
  if (index < 0) return false;
  responses.splice(index, 1);
  return true;
}
