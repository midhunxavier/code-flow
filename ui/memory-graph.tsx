import { useEffect, useState } from "preact/hooks";
import type { KnowledgeGraph, MemoryEntry } from "../src/memory.js";
import { api } from "./lib.js";

const labels = { applies_to: "applies to", learned_from: "learned from", derived_from: "written with", verified_at: "verified at" };

/** A readable relationship inspector, including the exact memory revision that supplied each link. */
export function MemoryGraph({ endpoint, repo, entries }: { endpoint: string; repo: string; entries: MemoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!open) return;
    let current = true;
    setGraph(null); setError("");
    api<KnowledgeGraph>(`${endpoint}/graph?repo=${encodeURIComponent(repo)}`).then(
      (value) => { if (current) setGraph(value); },
      (problem: Error) => { if (current) setError(problem.message); },
    );
    return () => { current = false; };
  }, [open, endpoint, repo, entries]);
  const nodes = new Map(graph?.entities.map((node) => [node.id, node]));
  const rows = graph?.relationships.filter((edge) => `${nodes.get(edge.from)?.label} ${nodes.get(edge.to)?.label} ${labels[edge.relation]}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <details class="knowledge-graph" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Knowledge graph</summary>
    <p class="help">Connections recorded in memory paths and evidence. “Written with” records context, not proof that one claim follows from another. Proposal connections remain unapproved.</p>
    <label>Find connections<input class="field" aria-label="Find knowledge connections" value={filter} onInput={(event) => setFilter(event.currentTarget.value)} placeholder="Memory, file, run or commit" /></label>
    {error ? <p class="msg err" role="alert">{error}</p> : !graph ? <p role="status">Loading connections…</p> : <>
      {graph.truncated ? <p class="help">Showing the first 1,000 connections. The graph is larger than this view.</p> : null}
      {!rows.length ? <p class="help">No matching connections.</p> : <div class="knowledge-connections" tabIndex={0} role="region" aria-label="Knowledge connections"><table>
        <thead><tr><th>Memory</th><th>Relationship</th><th>Connected item</th><th>Evidence</th></tr></thead>
        <tbody>{rows.map((edge) => {
          const from = nodes.get(edge.from)!, to = nodes.get(edge.to)!;
          const entry = entries.find((item) => item.id === edge.evidence.id);
          return <tr key={`${edge.from}:${edge.to}:${edge.relation}`}>
            <td><a href={`#memory-${from.key}`} onClick={(event) => { event.preventDefault(); document.getElementById(`memory-${from.key}`)?.focus(); }}>{from.label}</a></td>
            <td>{labels[edge.relation]}</td><td>{to.kind}: {to.kind === "run" ? <a href={`#/run/${encodeURIComponent(to.key)}`}>{to.label}</a> : to.label}</td>
            <td>Revision {edge.evidence.revision} · {entry?.status === "accepted" ? "Accepted" : "Proposal"}{edge.targetRevision ? ` · source revision ${edge.targetRevision}` : ""}</td>
          </tr>;
        })}</tbody>
      </table></div>}
    </>}
  </details>;
}
