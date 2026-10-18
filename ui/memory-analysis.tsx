import { useEffect, useId, useState } from "preact/hooks";
import type { MemoryAnalysis } from "../src/memory-analysis.js";
import type { MemoryEntry } from "../src/memory.js";
import { Markdown } from "./bits.js";
import { api, post, showToast } from "./lib.js";

/** Evidence is computed on demand from authorized entries and the selected repository. */
export function MemoryAnalysisPanel({ endpoint, repo, entries, refreshKey, onPublished }: { endpoint: string; repo: string; entries: MemoryEntry[]; refreshKey: string; onPublished: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MemoryAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [publishing, setPublishing] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    setLoading(true); setError("");
    api<MemoryAnalysis>(`${endpoint}/analysis?repo=${encodeURIComponent(repo)}`, { signal: controller.signal }).then(
      (value) => { if (current) setData(value); },
      (problem) => { if (current) setError((problem as Error).message); },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [open, endpoint, repo, entries, refreshKey, version]);
  const title = (id: string) => entries.find((entry) => entry.id === id)?.title ?? id;
  const publish = async () => {
    if (!data?.onboarding.sourceRefs.length || publishing) return;
    setPublishing(true); setError("");
    try {
      await post(`${endpoint}/analysis/publish`, { repo, expectedSources: data.onboarding.sourceRefs });
      showToast("Onboarding guidance saved with its source revisions.");
      await onPublished(); setVersion((value) => value + 1);
    } catch (problem) { setError((problem as Error).message); }
    finally { setPublishing(false); }
  };
  return <details class="at-section memory-analysis" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Memory health, provenance and onboarding</summary>
    <p class="help">Inspect sources, review applicability and repeated wording, and curate accepted guidance before publishing it.</p>
    <button class="btn small" disabled={loading} onClick={() => setVersion((value) => value + 1)}>{loading ? "Inspecting…" : "Refresh memory analysis"}</button>
    {error ? <p class="msg err" role="alert">{error}</p> : null}
    {data ? <>
      <p class="help">{data.graph.nodes.filter((node) => node.available).length} entries inspected{data.git.head ? ` at ${data.git.head.slice(0, 12)}` : " · Git evidence unavailable"}{data.git.branch ? ` · ${data.git.branch}` : ""}.{data.truncated ? " Analysis reached a limit; omitted entries or comparisons need separate review." : ""}</p>
      <details><summary>Source and derived-entry graph</summary><MemoryProvenanceGraph graph={data.graph} /></details>
      <details><summary>Freshness and applicability · {data.stale.length} to review</summary>
        {data.stale.length ? <ul>{data.stale.map((entry) => <li key={entry.id}><MemoryEntryLink id={entry.id}>{title(entry.id)}</MemoryEntryLink> · revision {entry.revision}<ul>{entry.reasons.map((reason, index) => <li key={index}>{reason.detail}</li>)}</ul></li>)}</ul> : <p class="help">No issues found by these bounded checks. This is not a semantic correctness assessment.</p>}
      </details>
      <details><summary>Repeated wording · {data.duplicates.length} pairs</summary>
        <p class="help">Lexical overlap is a review hint. Supported semantic claims are inspected separately below. Compare applicability before combining entries.</p>
        {data.duplicates.length ? <ul>{data.duplicates.map((pair) => <li key={`${pair.a.id}:${pair.b.id}`}><MemoryEntryLink id={pair.a.id}>{title(pair.a.id)}</MemoryEntryLink> and <MemoryEntryLink id={pair.b.id}>{title(pair.b.id)}</MemoryEntryLink> · {pair.kind === "exact" ? "Same text, ignoring whitespace" : `${Math.round(pair.similarity * 100)}% lexical overlap`}</li>)}</ul> : <p class="help">No repeated wording found within the comparison limit.</p>}
      </details>
      <details><summary>Semantic claim review · {data.claims.findings.filter((finding) => finding.kind === "contradiction").length} conflicts · {data.claims.findings.filter((finding) => finding.kind === "equivalent").length} equivalent pairs</summary>
        <p class="help">{data.claims.method}</p><p class="help">{data.claims.claims.length} claims from {data.claims.inspectedEntries} entries; {data.claims.unsupported} unsupported lines or facts. {data.claims.truncated ? "A claim/comparison limit was reached." : ""} Source paths and branch applicability must overlap before a pair is suggested.</p>
        {data.claims.findings.length ? <ul>{data.claims.findings.map((finding, index) => <li key={`${finding.a.id}:${finding.b.id}:${index}`}><strong>{finding.kind === "contradiction" ? "Potential contradiction" : "Equivalent supported claim"}: {finding.predicate} · {finding.subject}</strong><p><MemoryEntryLink id={finding.a.id}>{title(finding.a.id)}</MemoryEntryLink> revision {finding.a.revision} and <MemoryEntryLink id={finding.b.id}>{title(finding.b.id)}</MemoryEntryLink> revision {finding.b.revision}</p><p class="help">{finding.explanation}</p><details><summary>Compare claim evidence</summary><p>Left · {finding.left.evidence.method} · characters {finding.left.evidence.start}–{finding.left.evidence.end}</p><pre>{finding.left.evidence.text}</pre><pre>{JSON.stringify(finding.left.value)}</pre><p>Right · {finding.right.evidence.method} · characters {finding.right.evidence.start}–{finding.right.evidence.end}</p><pre>{finding.right.evidence.text}</pre><pre>{JSON.stringify(finding.right.value)}</pre></details></li>)}</ul> : <p class="help">No supported claim pairs found. This does not show that arbitrary prose is consistent.</p>}
        <details><summary>Write explicit semantic facts</summary><p class="help">Edit a knowledge entry to include this fenced block. Subjects and predicates identify one fact; booleans express policy, strings express exact settings, and numbers/ranges use count, time or byte units. Keep conditions in the entry's path and branch applicability. Only reviewed project guidance should be accepted.</p><pre>{'```codeflow-claims\n[\n  {"subject":"guest requests","predicate":"allow","value":false},\n  {"subject":"cache ttl","predicate":"setting","min":5,"max":10,"unit":"minutes"}\n]\n```'}</pre><p class="help">The local grammar also recognizes simple standalone instructions such as “Never permit guest requests” and “Set cache TTL to 300 seconds”. Conditional, compound and unsupported sentences require explicit facts; no model or external service is used.</p></details>
      </details>
      <details><summary>Curated project onboarding</summary>
        <p class="help">Only accepted guidance written by you with trusted user origins is included. Entries needing review, imported material, private material and earlier onboarding summaries are excluded.</p>
        {data.onboarding.body ? <><Markdown text={data.onboarding.body} /><p class="help">Sources: {data.onboarding.sourceRefs.map((source) => `${title(source.id)} (revision ${source.revision})`).join(", ")}. {data.onboarding.omitted} entries omitted.</p><button class="btn small primary" disabled={publishing || loading} onClick={publish}>{publishing ? "Saving…" : "Save onboarding as project knowledge"}</button><p class="help">Saving is your explicit publication of the reviewed summary. Source revisions are rechecked before it is saved.</p></> : <p class="help">No eligible guidance to publish. Add or review user-authored repository guidance first.</p>}
        {data.onboarding.reasons.length ? <details><summary>Why entries were omitted</summary><ul>{data.onboarding.reasons.map((item) => <li key={item.id}>{title(item.id)}: {item.reason}</li>)}</ul></details> : null}
      </details>
      {data.notes.map((note, index) => <p class="help" key={index}>{note}</p>)}
    </> : loading ? <p class="help" role="status">Inspecting project knowledge…</p> : null}
  </details>;
}

function MemoryProvenanceGraph({ graph }: { graph: MemoryAnalysis["graph"] }) {
  const marker = `memory-provenance-${useId().replace(/:/g, "")}`;
  const [selected, setSelected] = useState("");
  const nodes = graph.nodes.slice(0, 60);
  const included = new Set(nodes.map((node) => node.key));
  const edges = graph.edges.filter((edge) => included.has(edge.from) && included.has(edge.to));
  const depths = new Map(nodes.map((node) => [node.key, 0]));
  for (let pass = 0; pass < 6; pass++) for (const edge of edges) depths.set(edge.to, Math.min(5, Math.max(depths.get(edge.to) ?? 0, (depths.get(edge.from) ?? 0) + 1)));
  const rows = new Map<number, number>();
  const positions = new Map(nodes.map((node) => { const depth = depths.get(node.key)!; const row = rows.get(depth) ?? 0; rows.set(depth, row + 1); return [node.key, { x: 12 + depth * 220, y: 12 + row * 65 }]; }));
  const width = Math.max(220, ...[...positions.values()].map((position) => position.x + 205));
  const height = Math.max(75, ...[...positions.values()].map((position) => position.y + 60));
  const current = graph.nodes.find((node) => node.key === selected);
  return <>
    <p class="help">Arrows go from a source revision to a derived entry. Older or deleted revisions are shown as references without restored text.{nodes.length < graph.nodes.length ? ` Showing ${nodes.length} of ${graph.nodes.length} nodes.` : ""}</p>
    {/* Colours and lines come from the stylesheet (.memory-graph), so the graph follows the theme. The scroller
        takes focus itself: axe doesn't count the SVG node buttons as focusable content for keyboard scrolling. */}
    {nodes.length ? <div class="memory-graph" tabIndex={0}>
      <svg width={width} height={height} role="group" aria-label="Memory provenance graph">
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" /></marker></defs>
        {edges.map((edge) => { const from = positions.get(edge.from)!, to = positions.get(edge.to)!; return <path key={`${edge.from}:${edge.to}`} class="mem-edge" d={`M${from.x + 190},${from.y + 24} C${from.x + 215},${from.y + 24} ${to.x - 25},${to.y + 24} ${to.x},${to.y + 24}`} marker-end={`url(#${marker})`} />; })}
        {nodes.map((node) => { const point = positions.get(node.key)!; const label = node.title ?? node.id; return <g key={node.key} class={`mem-node${node.available ? "" : " ref"}${selected === node.key ? " on" : ""}`} transform={`translate(${point.x},${point.y})`} role="button" tabIndex={0} aria-label={`${label}, revision ${node.revision}${node.available ? "" : ", reference only"}`} onClick={() => setSelected(node.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.key); } }}><title>{label} · revision {node.revision}</title><rect width="190" height="48" rx="8" /><text x="10" y="20" class="mem-title">{label.length > 25 ? label.slice(0, 24) + "…" : label}</text><text x="10" y="37">Revision {node.revision}{node.available ? ` · ${node.status}` : " · reference only"}</text></g>; })}
      </svg>
    </div> : <p class="help">No entries to draw yet.</p>}
    {current ? <p class="help" role="status">{current.title ?? current.id} · revision {current.revision}. {graph.edges.filter((edge) => edge.to === current.key).length} source references; {graph.edges.filter((edge) => edge.from === current.key).length} derived references.{current.available ? "" : " The text of this revision is unavailable and has not been recovered."}</p> : null}
    <details><summary>Read source references as a list</summary><ul>{graph.edges.slice(0, 200).map((edge) => <li key={`${edge.from}:${edge.to}`}><code>{edge.from}</code> → <code>{edge.to}</code></li>)}</ul>{graph.edges.length > 200 ? <p class="help">Showing the first 200 of {graph.edges.length} references.</p> : null}</details>
  </>;
}

export function MemoryDeleteImpact({ endpoint, repo, entryId, onReady }: { endpoint: string; repo: string; entryId: string; onReady: () => void }) {
  const [impact, setImpact] = useState<MemoryAnalysis["deletionImpact"][number] | null>(null);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let current = true;
    api<MemoryAnalysis>(`${endpoint}/analysis?repo=${encodeURIComponent(repo)}`).then(
      (data) => { if (current) { const impact = data.deletionImpact.find((entry) => entry.id === entryId); setImpact(impact ?? null); if (!impact) setError("This entry is not included in the bounded preview."); setTruncated(data.truncated); } },
      (problem) => { if (current) setError((problem as Error).message); },
    ).finally(() => { if (current) onReady(); });
    return () => { current = false; };
  }, [endpoint, repo, entryId]);
  return <div class="help" role="group" aria-label="Memory deletion impact">
    {impact ? <><p>{impact.direct.length} directly derived entries; {impact.transitive.length} downstream entries retain their text and provenance.</p><p>{impact.retained}</p>{impact.transitive.length ? <details><summary>Entries to review separately</summary><ul>{impact.transitive.map((entry) => <li key={entry.id}><MemoryEntryLink id={entry.id}>{entry.id}</MemoryEntryLink> · revision {entry.revision}</li>)}</ul></details> : null}{truncated ? <p>The analysis reached a limit; additional derived entries may exist.</p> : null}</> : error ? <p>Impact preview unavailable: {error}. Derived text and separate transcript history are retained.</p> : <p role="status">Loading deletion impact…</p>}
  </div>;
}

function MemoryEntryLink({ id, children }: { id: string; children: string }) {
  return <button type="button" class="mem-link" onClick={() => { const target = document.getElementById(`memory-${id}`); target?.scrollIntoView({ behavior: "smooth", block: "center" }); target?.focus({ preventScroll: true }); }}>{children}</button>;
}
