/** Add reading breaks to long, unformatted prose without rewriting its words.
 * Leave Markdown blocks alone so lists, tables and code retain their structure. */
export function readableTeamMessage(text: string): string {
  if (typeof Intl.Segmenter !== "function" || /```|~~~/.test(text)) return text;
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return text.split(/\n\s*\n/).map(paragraph => {
    if (paragraph.length < 480 || paragraph.includes("\n") || /[`|*_\[\]<>]|^\s*(?:#{1,6}\s|[-+]\s|\d+[.)]\s)/.test(paragraph)) return paragraph;
    const groups: string[] = [];
    let group = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      if (group.length >= 240) { groups.push(group.trimEnd()); group = ""; }
      group += segment;
    }
    if (group) groups.push(group.trimEnd());
    return groups.join("\n\n");
  }).join("\n\n");
}
