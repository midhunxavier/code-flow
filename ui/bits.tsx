import type { ComponentChildren } from "preact";
import { useMemo } from "preact/hooks";
import { encode } from "uqr";
import { SHORT } from "./lib.js";
import type { AgentId, RunSummary } from "./types.js";

/** The check couldn't run in this environment: why, and where to fix it. */
export function CantRunNote({ cantRun }: { cantRun: NonNullable<RunSummary["checkCantRun"]> }) {
  return (
    <div class="cant-run">
      The check can't run here: <code>{cantRun.reason}</code>. Set <code>setup</code> and <code>check</code> in <code>.codeflow/config.json</code>.
      <div class="cr-why">That's the environment, not the change: it fails on the base commit too. So no fix rounds were spent on it, and whether the change works is unknown.</div>
    </div>
  );
}

export function AgentTag({ id, note }: { id?: AgentId; note?: string }) {
  if (!id) return null;
  return (
    <span class={`agent ${id}`}>
      {SHORT[id] ?? id}
      {note ? <span class="model"> {note}</span> : null}
    </span>
  );
}

/** A QR code for a link: dark modules on white, with the quiet zone scanners need. */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const qr = encode(text, { ecc: "M", border: 0 });
  const quiet = 4;
  const n = qr.size + quiet * 2;
  let d = "";
  qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + quiet} ${y + quiet}h1v1h-1z`)));
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges" role="img" aria-label={`QR code for ${text}`}>
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#1a1b16" />
    </svg>
  );
}

/**
 * Small, safe markdown: headings, paragraphs, bullet and numbered lists, quotes, tables, rules,
 * fenced code, and inline bold, italics, code and http(s) links. Text is never parsed as HTML.
 */
export function Markdown({ text }: { text: string }) {
  // Parsed once per text: a long thread re-renders often, and its messages rarely change (the same
  // elements back also let Preact skip comparing them).
  const nodes = useMemo(() => markdownNodes(text), [text]);
  return <div class="md">{nodes}</div>;
}

/** The elements `Markdown` shows for a text. */
export function markdownNodes(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = [];
  text.split(/^```[^\n]*\n?/m).forEach((chunk, i) => {
    if (i % 2 === 1) nodes.push(<pre key={`c${i}`} tabIndex={0} aria-label="Code block">{chunk.replace(/\n$/, "")}</pre>);
    else blocks(chunk, `b${i}`, nodes);
  });
  return nodes;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function blocks(text: string, prefix: string, out: ComponentChildren[]) {
  const lines = text.split("\n");
  let i = 0;
  const key = () => `${prefix}-${i}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      out.push(h[1]!.length <= 2 ? <h3 key={key()}>{inline(h[2]!)}</h3> : <h4 key={key()}>{inline(h[2]!)}</h4>);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (LIST.test(line)) {
      // One list per run of top-level items of the same kind; nested items (either kind) and
      // indented continuation lines stay inside it.
      const ordered = /^\s*\d/.test(line);
      const items: { depth: number; num?: number; lines: string[] }[] = [];
      const start = key();
      while (i < lines.length) {
        const m = lines[i]!.match(LIST);
        if (!m) {
          if (items.length && /^\s{2,}\S/.test(lines[i]!)) items.at(-1)!.lines.push(lines[i++]!.trim());
          else break;
          continue;
        }
        const depth = Math.min(3, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2));
        const num = /\d/.test(m[2]!) ? parseInt(m[2]!, 10) : undefined;
        if (!depth && (num !== undefined) !== ordered) break;
        items.push({ depth, num, lines: [m[3]!] });
        i++;
      }
      const lis = items.map((it, n) => (
        <li key={n} value={ordered && !it.depth ? it.num : undefined} class={`${it.depth ? `d${it.depth}` : ""} ${it.num === undefined ? "bullet" : "num"}`}>
          {withBreaks(it.lines)}
        </li>
      ));
      out.push(ordered ? <ol key={start}>{lis}</ol> : <ul key={start}>{lis}</ul>);
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const quoted: string[] = [];
      const start = key();
      while (i < lines.length && lines[i]!.trimStart().startsWith(">")) quoted.push(lines[i++]!.trimStart().replace(/^>\s?/, ""));
      out.push(<blockquote key={start}>{withBreaks(quoted)}</blockquote>);
      continue;
    }
    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
      const start = key();
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div key={start} class="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>
                  {head.map((_, m) => (
                    <td key={m}>{inline(r[m] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // A paragraph runs until a blank line or another kind of block; its line breaks are kept.
    const para: string[] = [];
    const start = key();
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    out.push(<p key={start}>{withBreaks(para)}</p>);
  }
}

const startsBlock = (lines: string[], i: number) => {
  const line = lines[i]!;
  return /^#{1,6}\s/.test(line) || RULE.test(line) || LIST.test(line) || line.trimStart().startsWith(">") || (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? ""));
};

const withBreaks = (lines: string[]) => lines.flatMap((l, n) => (n ? [<br key={`br${n}`} />, ...inline(l)] : inline(l)));

function inline(text: string): ComponentChildren[] {
  return text.split(/(\*\*(?:`[^`]+`|[^*`])+\*\*|(?<![\w_])__(?:`[^`]+`|[^_`])+__(?![\w_])|`[^`]+`|\[[^\]]+\]\([^\s)]+\)|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<![\w_])_[^_\s][^_]*_(?![\w_]))/).map((part, i) => {
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^__[A-Za-z0-9_]+__$/.test(part)) return part; // Keep code identifiers such as __init__ intact.
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) return <b key={i}>{inline(part.slice(2, -2))}</b>;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link && /^https?:\/\//i.test(link[2]!))
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer">
          {inline(link[1]!)}
        </a>
      );
    if (link && (/^file:\/\//i.test(link[2]!) || !/^[a-z][a-z0-9+.-]*:/i.test(link[2]!) || /^[^:]*[./\\][^:]*:\d+$/.test(link[2]!))) {
      let target = link[2]!; try { target = decodeURIComponent(target); } catch { /* show the original malformed escape */ }
      return <span key={i} class="md-file-label" title={target}>{inline(link[1]!)}</span>;
    }
    if (part.length > 2 && ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_")))) return <i key={i}>{part.slice(1, -1)}</i>;
    return part;
  });
}
