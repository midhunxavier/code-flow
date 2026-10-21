const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localAppUrl(value: string, ownAddress?: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || !url.port || url.username || url.password) return;
    if (ownAddress && url.port === new URL(ownAddress).port) return;
    return url.href;
  } catch { return; }
}

export function localAppUrls(text: string, ownAddress?: string): string[] {
  const found = [...text.matchAll(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#][^\s<>"'`()\[\]]*)?/gi)];
  return [...new Set(found.map(([value]) => localAppUrl(value.replace(/[.,;!]+$/, ""), ownAddress)).filter((url): url is string => !!url))];
}
