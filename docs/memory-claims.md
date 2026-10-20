# Local semantic memory review

Project memory → **Advanced memory tools** → **Semantic claim review** compares supported facts with overlapping applicability. It identifies equivalent claims and potential contradictions with the exact source entry revisions, character offsets, evidence snippets and normalized values. Findings are suggestions for human review. Analysis never selects a winner, changes status, combines text or publishes guidance automatically.

The local grammar recognizes standalone policy instructions, including a small documented action vocabulary and policy polarity: “Always permit guest requests” is equivalent to “Do not block guest requests” and conflicts with “Never allow guest requests”. Setting statements normalize numeric dimensions: “Set cache TTL to 5 minutes” equals “Cache time-to-live is 300 seconds”. Numeric constraints conflict only when their intervals are disjoint, including exclusive `<` and `>` boundaries. Overlapping ranges are not treated as contradictions. Time and byte dimensions are never compared with each other or with counts.

Conditional or compound prose is deliberately not flattened into unconditional advice. Statements containing conditions, alternatives, conjunctions or multiple sentences are unsupported by this grammar. Unsupported prose is counted, and a report with no findings does not prove consistency. This is a bounded deterministic semantic interpretation, not unrestricted natural-language entailment, embeddings or an external model.

For precise facts, edit a knowledge entry to add a fenced JSON array:

````markdown
```codeflow-claims
[
  {"subject":"guest requests","predicate":"allow","value":false},
  {"subject":"package manager","predicate":"setting","value":"pnpm"},
  {"subject":"cache ttl","predicate":"setting","min":5,"max":10,"unit":"minutes"}
]
```
````

A fact has a subject (up to 120 characters), a lowercase predicate (up to 40 characters), and either a boolean/string/number `value`, or numeric `min`/`max` bounds. Unknown fields, invalid units and mixed scalar/range values are rejected as unsupported. `min` and `max` are inclusive. Units accept counts, milliseconds/seconds/minutes/hours, bytes, decimal KB/MB/GB and binary KiB/MiB/GiB. A missing numeric unit means count. Different explicit string settings for the same subject/predicate are a potential conflict; the analyzer does not infer application-specific aliases or which configuration is appropriate.

Subjects use Unicode normalization, case/spacing normalization, a small noun normalization vocabulary, and the `time-to-live`/`TTL` alias. Policy action aliases include use/utilize/employ, allow/permit/accept, deny/block/disallow/forbid/reject, require/enforce, cache/memoize, validate/verify and log/record. These aliases remain review hints: context outside the supported statement can still matter. `enable` and `allow` remain different predicates. Structured boolean predicates can use the same aliases; other explicit predicates are compared exactly.

Comparisons stay inside the already authorized repository and project. Private/deleted entries are excluded. Paths must intersect by exact path or directory ancestry; repository-wide entries overlap every path. Two branch-specific entries must name the same branch, and conflicting exact commit applicability is excluded. Source revision metadata is retained. Opposite supported facts inside one entry can also be flagged; repeated equivalent facts inside one entry are not listed as duplicate entries.

Limits: 500 entries; 20,000 source characters per body; 12 claims per entry; 1,000 claims total; 50,000 candidate comparisons; 100 findings; 512-character evidence snippets; 8 KiB-character structured blocks. Offsets refer to UTF-16 positions in the source body, as used by the browser editor. Every truncation and unsupported fact is reported. The feature runs locally without provider quota, network downloads, shell execution or automatic memory mutation.
