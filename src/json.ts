/**
 * Agents are asked to end structured answers with a fenced ```json block.
 * This pulls out the last such block, falling back to the last balanced {...} object.
 */
export function extractJson<T = any>(text: string): T | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse<T>(fences[i]![1]!);
    if (parsed !== undefined) return parsed;
  }
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    const start = matchingBrace(text, end);
    if (start < 0) continue;
    const parsed = tryParse<T>(text.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParse<T>(raw: string): T | undefined {
  try {
    const value = JSON.parse(raw.trim());
    return value && typeof value === "object" ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Index of the "{" that balances the "}" at `end`, ignoring braces inside strings. */
function matchingBrace(text: string, end: number): number {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"') {
      // Skip back over a string literal. A quote is escaped only by an odd number of
      // backslashes: `"a\\"` ends with an escaped backslash, not an escaped quote.
      for (i--; i >= 0 && !(text[i] === '"' && !escaped(text, i)); i--);
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{" && --depth === 0) return i;
  }
  return -1;
}

function escaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
  return n % 2 === 1;
}

/**
 * Minimal JSON Schema check for the shapes code-flow asks agents for (objects, arrays,
 * strings, numbers, booleans, enums, required keys). Returns a problem description, or
 * undefined when the value fits.
 */
export function shapeProblem(schema: any, value: unknown, path = "answer"): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(value) ? undefined : `${path} must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
  }
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
      for (const key of schema.required ?? []) {
        if (!(key in (value as object))) return `${path}.${key} is missing`;
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in (value as object)) {
          const problem = shapeProblem(sub, (value as Record<string, unknown>)[key], `${path}.${key}`);
          if (problem) return problem;
        }
      }
      return undefined;
    }
    case "array":
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const problem = shapeProblem(schema.items, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
      return undefined;
    case "string":
      return typeof value === "string" ? undefined : `${path} must be a string`;
    case "number":
    case "integer":
      return typeof value === "number" ? undefined : `${path} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} must be true or false`;
    default:
      return undefined;
  }
}
