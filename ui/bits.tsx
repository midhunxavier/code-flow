import type { ComponentChildren } from "preact";
import { SHORT } from "./lib.js";
import type { AgentId } from "./types.js";

export function AgentTag({ id, note }: { id?: AgentId; note?: string }) {
  if (!id) return null;
  return (
    <span class={`agent ${id}`}>
      {SHORT[id] ?? id}
      {note ? <span class="model"> {note}</span> : null}
    </span>
  );
}

/** Tiny, safe markdown: headings, bold, inline code, fenced code, lists. */
export function Markdown({ text }: { text: string }) {
  const nodes: ComponentChildren[] = [];
  text.split(/```[a-z]*\n?/).forEach((block, i) => {
    if (i % 2 === 1) {
      nodes.push(<pre key={`p${i}`}>{block}</pre>);
      return;
    }
    block.split("\n").forEach((line, j) => {
      if (!line.trim()) return;
      const h = line.match(/^#{1,3}\s+(.*)/);
      const li = line.match(/^\s*[-*]\s+(.*)/);
      const key = `${i}-${j}`;
      if (h) nodes.push(<h2 key={key}>{inline(h[1]!)}</h2>);
      else if (li) nodes.push(<div key={key} style="padding-left:12px">• {inline(li[1]!)}</div>);
      else nodes.push(<div key={key}>{inline(line)}</div>);
    });
  });
  return <div>{nodes}</div>;
}

function inline(text: string): ComponentChildren[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}
