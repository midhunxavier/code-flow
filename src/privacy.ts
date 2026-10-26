import { privateEnvironmentValues } from "./env.js";

const CREDENTIAL_KEY = "(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie|controlToken|capability|api[_-]?key|(?:access|auth|refresh)[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret|token|(?:[A-Z0-9]+[_-])+(?:token|secret|password|api[_-]?key|access[_-]?key(?:[_-]?id)?))";
const credentialKey = new RegExp(`^${CREDENTIAL_KEY}$`, "i");

/** End of a quote at its JSON escape depth, including an escaped trailing backslash. */
function quotedEnd(text: string, start: number, delimiter: string): number {
  const quote = delimiter.at(-1), depth = delimiter.length - 1;
  for (let end = start + delimiter.length; end < text.length;) {
    let slashes = 0;
    while (text[end + slashes] === "\\") slashes++;
    if (text[end + slashes] === quote && (slashes - depth) % (2 * (depth + 1)) === 0) return end + slashes + 1;
    end += slashes + 1;
  }
  return text.length;
}
/** Credential-shaped keys can hold whole JSON objects/arrays, including inside log strings. */
function structuredEnd(text: string, start: number): number {
  const stack: string[] = [];
  for (let at = start; at < text.length; at++) {
    const quoted = /^(\\*["'])/.exec(text.slice(at));
    if (quoted) { at = quotedEnd(text, at, quoted[0]) - 1; continue; }
    const c = text[at];
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") { if (c !== stack.pop()) return text.length; if (!stack.length) return at + 1; }
  }
  return text.length;
}
function redactAssignments(text: string): string {
  const assignments = new RegExp(`(?:(?<![\\w.-])|(?<=\\\\[nrt]))(${CREDENTIAL_KEY})(\\\\*["'])?\\s*[:=]\\s*`, "gi");
  let result = "", from = 0;
  for (let match; (match = assignments.exec(text));) {
    const start = assignments.lastIndex;
    const quoted = /^(\\*["'])/.exec(text.slice(start));
    let end = start, replacement = "[REDACTED]";
    if (quoted) {
      const delimiter = quoted[0];
      end = quotedEnd(text, start, delimiter);
      replacement = delimiter + "[REDACTED]" + (text.slice(start + delimiter.length, end).endsWith(delimiter) ? delimiter : "");
    } else if (text.slice(start).startsWith("[REDACTED")) {
      const close = text.indexOf("]", start);
      end = close < 0 ? text.length : close + 1;
    } else if (text[start] === "{" || text[start] === "[") {
      end = structuredEnd(text, start);
    } else {
      const header = /^(?:authorization|proxy[-_]authorization|cookie|set[-_]cookie)$/i.test(match[1]!);
      // Header schemes and cookies may contain quoted fields and separators. The
      // entire line is private; a quoted field cannot end its redaction early.
      const stop = header ? /[\r\n]/ : /[\s"',;}&\]]/;
      while (end < text.length && !stop.test(text[end]!)) end++;
    }
    if (end === start) continue;
    result += text.slice(from, start) + replacement;
    from = end; assignments.lastIndex = end;
  }
  return result + text.slice(from);
}

/** Redaction is used for diagnostic and evidence exports, never to mutate source files. */
export function redactText(text: string, secrets: string[] = environmentSecrets()): string {
  let result = redactAssignments(text)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s"']+/gi, "$1[REDACTED]")
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]");
  for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  return result;
}

function environmentSecrets(): string[] {
  return [...privateEnvironmentValues(), ...Object.entries(process.env).filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(key) && value && value.length >= 8).map(([, value]) => value!)];
}

export function redactExport<T>(value: T): T {
  const secrets = environmentSecrets();
  const visit = (item: unknown, key = ""): unknown => {
    if (item != null && credentialKey.test(key)) return "[REDACTED]";
    if (typeof item === "string") return redactText(item, secrets);
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };
  return visit(value) as T;
}
