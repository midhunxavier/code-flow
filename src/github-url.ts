/** An explicit GitHub/GHE PR identity, suitable for host-qualified CLI operations. */
export function parsePullRequestUrl(value: string): { host: string; owner: string; repository: string; number: number } | undefined {
  if (/[\\\s]/.test(value)) return;
  try {
    const url = new URL(value), path = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname) || !path) return;
    const number = Number(path[3]); if (!Number.isSafeInteger(number)) return;
    return { host: url.host, owner: path[1]!, repository: path[2]!, number };
  } catch { return; }
}
