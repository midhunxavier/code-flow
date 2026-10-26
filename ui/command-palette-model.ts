export interface PaletteRow { id: string; label: string; detail: string; group: "action" | "project" | "run" | "project-section"; aliases?: string[]; serverMatch?: boolean }
const normalized = (text: string) => text.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
const words = (text: string) => normalized(text).match(/[\p{L}\p{N}]+/gu) ?? [];
/** Keep each kind of destination discoverable; rank labels above keyword-only matches. */
export function paletteResults<T extends PaletteRow>(commands: T[], query: string, limit = 40): { rows: T[]; hidden: number } {
  const search = normalized(query).trim(), terms = search.split(/\s+/).filter(Boolean);
  if (!terms.length) {
    const rows = (["action", "project", "run"] as const).flatMap(group => commands.filter(command => command.group === group).slice(0, group === "action" ? 6 : 5)).slice(0, limit);
    return { rows, hidden: Math.max(0, commands.length - rows.length) };
  }
  const scored = commands.flatMap((command, index) => {
    const label = normalized(command.label), detail = normalized(command.detail), aliases = command.aliases?.map(normalized) ?? [];
    const haystack = `${label} ${detail} ${aliases.join(" ")}`;
    if (!command.serverMatch && !terms.every(term => haystack.includes(term))) return [];
    const labelWords = words(label), detailWords = words(detail);
    const score = aliases.includes(search) ? 1100 : label === search ? 1000 : label.startsWith(search) ? 800
      : terms.every(term => labelWords.some(word => word.startsWith(term))) ? 600
      : terms.every(term => label.includes(term)) ? 400
      : terms.every(term => [...labelWords, ...detailWords].some(word => word.startsWith(term))) ? 200 : 100;
    return [{ command, score, index }];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return { rows: scored.slice(0, limit).map(item => item.command), hidden: Math.max(0, scored.length - limit) };
}
