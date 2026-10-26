/** User-agent hints are labels only, never identity or authorization. */
export function deviceLabel(userAgent: string): string {
  const device = /iPhone/i.test(userAgent) ? "iPhone" : /iPad|Macintosh.*Mobile/i.test(userAgent) ? "iPad" : /Android/i.test(userAgent) ? "Android" : /Windows/i.test(userAgent) ? "Windows" : /Macintosh|Mac OS X/i.test(userAgent) ? "Mac" : /Linux/i.test(userAgent) ? "Linux" : "Phone";
  const browser = /Edg(?:e|A|iOS)?\//i.test(userAgent) ? "Edge" : /(?:Firefox|FxiOS)\//i.test(userAgent) ? "Firefox" : /(?:Chrome|CriOS)\//i.test(userAgent) ? "Chrome" : /Safari\//i.test(userAgent) ? "Safari" : "";
  return browser ? `${device} · ${browser}` : device;
}
