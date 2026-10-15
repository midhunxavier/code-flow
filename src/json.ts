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
      // skip back over a string literal
      for (i--; i >= 0 && !(text[i] === '"' && text[i - 1] !== "\\"); i--);
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{" && --depth === 0) return i;
  }
  return -1;
}
