import { hubIdentity } from "../src/collab/hub-identity.js";

/** Public connection hints only. Never accept owner tokens, pairing URLs or arbitrary deep links. */
export function parseTeamAddress(value: string): { url: string; username?: string; project?: string; invitation?: string } {
  const hint = "Enter an HTTPS team address or the connection link your teammate shared.";
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error(hint); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.pathname !== "/") throw new Error(hint + " Personal device pairing links cannot be used to join a team.");
  if (url.hash.startsWith("#/join/")) {
    if (!/^#\/join\/[a-zA-Z0-9_-]{43}$/.test(url.hash)) throw new Error("This invitation link is incomplete. Ask the owner for the full link.");
    return { url: url.origin, invitation: url.href };
  }
  if (url.hash && !url.hash.startsWith("#/connect?")) throw new Error(hint);
  const params = new URLSearchParams(url.hash.slice("#/connect?".length));
  const username = params.get("username"), project = params.get("project");
  return { url: url.origin, ...(username ? { username } : {}), ...(project ? { project } : {}) };
}

export const teamConnectionLink = (origin: string, username: string, project?: string) => `${new URL(origin).origin}/#/connect?${new URLSearchParams({ username, ...(project ? { project } : {}) })}`;

/** Handoff only to a local Code Flow, carrying public hints, never session credentials. */
export function computerSetupLink(localAddress: string, connection: string) {
  const local = new URL(localAddress.trim());
  if (!["http:", "https:"].includes(local.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) || local.username || local.password || local.search || local.hash || local.pathname !== "/") throw new Error(`Enter the local Code Flow address printed in its terminal, such as ${DEFAULT_LOCAL_CODEFLOW}.`);
  const hints = parseTeamAddress(connection);
  if (hints.invitation) throw new Error("Accept the project invitation first.");
  return `${local.origin}/team-handoff#/settings/connections/join?connection=${encodeURIComponent(teamConnectionLink(hints.url, hints.username ?? "", hints.project))}`;
}

export const DEFAULT_LOCAL_CODEFLOW = "http://localhost:4317";
export function savedConnectionFor(connections: { id: string; linked: boolean; url?: string; user?: { username: string } }[], hint: string): string | undefined {
  const address = parseTeamAddress(hint);
  if (address.invitation) return;
  return connections.find(connection => connection.linked && connection.url && hubIdentity(connection.url) === hubIdentity(address.url) && (!address.username || connection.user?.username === address.username))?.id;
}
