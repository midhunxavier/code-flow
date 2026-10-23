/** Public connection hints only. Never accept owner tokens, pairing URLs or arbitrary deep links. */
export function parseTeamAddress(value: string): { url: string; username?: string; invitation?: string } {
  const hint = "Enter an HTTPS team address or the connection link your teammate shared.";
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error(hint); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.pathname !== "/") throw new Error(hint + " Personal device pairing links cannot be used to join a team.");
  if (url.hash.startsWith("#/join/")) {
    if (!/^#\/join\/[a-zA-Z0-9_-]{43}$/.test(url.hash)) throw new Error("This invitation link is incomplete. Ask the owner for the full link.");
    return { url: url.origin, invitation: url.href };
  }
  if (url.hash && !url.hash.startsWith("#/connect?")) throw new Error(hint);
  const username = new URLSearchParams(url.hash.slice("#/connect?".length)).get("username") ?? undefined;
  return { url: url.origin, ...(username ? { username } : {}) };
}

export const teamConnectionLink = (origin: string, username: string) => `${new URL(origin).origin}/#/connect?${new URLSearchParams({ username })}`;
