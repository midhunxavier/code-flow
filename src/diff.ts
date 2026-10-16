/**
 * Fitting a diff into a prompt. Cutting a long diff at a fixed length drops whatever files
 * happen to come last, mid-hunk. Instead, keep whole files (source before lockfiles and
 * generated output), cut at most one file part-way, and list every file that didn't fit, so
 * the reader knows what it isn't seeing and how to look.
 */

const LOW_PRIORITY =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|Pipfile\.lock)$|\.(min\.(js|css)|map|snap)$|(^|\/)(dist|build|vendor|node_modules|__snapshots__)\//;

function fileName(chunk: string): string {
  return chunk.match(/^diff --git a\/(.+?) b\//)?.[1] ?? chunk.match(/^diff --git (\S+)/)?.[1] ?? "?";
}

function stat(chunk: string): string {
  let add = 0;
  let del = 0;
  for (const line of chunk.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return `+${add} -${del}`;
}

export function fitDiff(full: string, max: number, base: string): string {
  if (full.length <= max) return full;
  const chunks = full.split(/^(?=diff --git )/m).filter(Boolean);
  // Leave room for the list of files that don't fit.
  const budget = max - Math.min(Math.floor(max / 4), 300 + chunks.length * 60);
  const shown = new Map<number, string>();
  let used = 0;
  // Whole files first — source before lockfiles and generated output — then, with what's left,
  // the start of the first source file that was too big.
  const order = chunks.map((c, i) => ({ c, i, low: LOW_PRIORITY.test(fileName(c)) })).sort((a, b) => Number(a.low) - Number(b.low));
  for (const { c, i } of order) {
    if (used + c.length > budget) continue;
    shown.set(i, c);
    used += c.length;
  }
  const big = order.find(({ i, low }) => !shown.has(i) && !low);
  if (big && budget - used > 2_000) {
    const room = budget - used;
    const cut = big.c.lastIndexOf("\n", room);
    shown.set(big.i, `${big.c.slice(0, cut > 0 ? cut : room)}\n… (the rest of ${fileName(big.c)} is cut: ${stat(big.c)} in total)\n`);
  }
  const omitted = order.filter(({ i }) => !shown.has(i)).map(({ c }) => `- ${fileName(c)} (${stat(c)})`);
  const body = chunks.map((_, i) => shown.get(i) ?? "").join("");
  if (!omitted.length) return body;
  return (
    body +
    `\n… the diff is ${full.length} characters, too long to show whole. ${omitted.length} file(s) aren't shown above; ` +
    `run \`git diff ${base}..HEAD -- <file>\` to read them:\n${omitted.join("\n")}`
  );
}
