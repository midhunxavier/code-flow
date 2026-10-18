import { privateEnvironmentValues } from "./env.js";

/** Redaction is used for diagnostic and evidence exports, never to mutate source files. */
export function redactText(text: string, secrets: string[] = environmentSecrets()): string {
  let result = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED TOKEN]")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]{12,}=*/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]");
  for (const secret of secrets) if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  return result;
}

function environmentSecrets(): string[] {
  return [...privateEnvironmentValues(), ...Object.entries(process.env).filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(key) && value && value.length >= 8).map(([, value]) => value!)];
}

export function redactExport<T>(value: T): T {
  const secrets = environmentSecrets();
  const visit = (item: unknown, key = ""): unknown => {
    if (typeof item === "string") return /^(?:token|controlToken|authorization|cookie|password|secret|apiKey|capability)$/i.test(key) ? "[REDACTED]" : redactText(item, secrets);
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };
  return visit(value) as T;
}
