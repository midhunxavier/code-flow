/** Compare known aliases without changing the address used for requests or TLS. */
export function hubIdentity(origin: string): string {
  const url = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "127.0.0.1";
  return url.origin;
}
