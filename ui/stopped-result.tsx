import { Markdown } from "./bits.js";
import { Icon } from "./icons.js";
import { stoppedResult } from "./task-result-format.js";

export function StoppedResult({ body }: { body: string }) {
  const result = stoppedResult(body);
  if (!result) return <Markdown text={body}/>;
  return <div class="stopped-result">
    <header class="stopped-result-status"><Icon name="alert"/><div><h3>Completion requirements not met</h3><p>{result.deliverable ? "Work is preserved. Review the findings before continuing." : "The task stopped before completing its requirements."}</p></div></header>
    {result.reason ? <section><h3>Why it stopped</h3><Markdown text={result.reason}/></section> : null}
    {result.reviews.map((review, i) => <section class="result-review" key={`${review.target}:${i}`}><header><h3>{review.reviewer}</h3><span class={`badge ${review.verdict === "approve" ? "ok" : "warn"}`}>{review.verdict === "changes_requested" ? "Changes requested" : review.verdict === "approve" ? "Approved" : review.verdict.replaceAll("_", " ")}</span></header><Markdown text={review.body.replace(/^Blocking findings:\s*$/m, "### Blocking findings")}/></section>)}
    {result.deliverable ? <section class="preserved-result"><h3>Preserved work</h3>{result.snapshot ? <dl><dt>Snapshot</dt><dd><code title={result.snapshot.commit}>{result.snapshot.commit.slice(0, 12)}</code></dd><dt>Branch</dt><dd><code>{result.snapshot.branch}</code></dd></dl> : <Markdown text={result.deliverable}/>}</section> : null}
    <details class="result-technical"><summary>Technical details</summary>{result.snapshot ? <dl><dt>Worktree</dt><dd><code>{result.snapshot.worktree}</code></dd><dt>Review command</dt><dd><code>{result.snapshot.diff}</code></dd></dl> : null}<details><summary>Original output</summary><pre>{body}</pre></details></details>
  </div>;
}
