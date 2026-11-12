export class SharedPathError extends Error { readonly status = 400; }
/** Inspect the original request target before WHATWG URL normalization can erase traversal. */
export function canonicalSharedPath(target: string): { pathname: string; parts: string[] } {
  const raw = target.split("?")[0]!;
  if (!raw.startsWith("/") || raw.length > 4000 || /[\\#\x00-\x20\x7f]/.test(raw) || /%(?:2f|5c|00|25)/i.test(raw)) throw new SharedPathError("Invalid request path");
  let path: string; try { path = decodeURIComponent(raw); } catch { throw new SharedPathError("Invalid request path encoding"); }
  if (/[\\#\x00-\x20\x7f]/.test(path)) throw new SharedPathError("Invalid request path");
  const parts = path === "/" ? [] : path.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new SharedPathError("Ambiguous request path");
  if (parts[0] === "api" && parts[1] === "v1" && parts[2] !== "capabilities") parts.splice(1, 1);
  return { pathname: `/${parts.join("/")}`, parts };
}
