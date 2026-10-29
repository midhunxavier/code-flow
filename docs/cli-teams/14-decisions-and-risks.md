# Decisions, risks, and deferred scope

Status: proposed. [Index](README.md)

## Accepted design decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D01 | CLI integration first | Establish complete mixed-provider workflows before native desktop tool sharing |
| D02 | One local runtime owner | Avoid competing schedulers and duplicated executions |
| D03 | Profiles, roles, teams, graphs, and runs are separate | Reuse workflows across provider/model assignments |
| D04 | Declarative typed graphs with explicit bounded loops | Validate execution before launch and make recovery deterministic |
| D05 | Existing adapters and durable journal are foundations | Reuse tested process, session, and recovery behavior |
| D06 | Host and managed participant contracts | Let the current conversation contribute without pretending it is fully controlled |
| D07 | Immutable artifacts and revision-bound votes | Prevent stale approvals/checks from satisfying completion |
| D08 | Human acceptance is distinct from agent verdicts | Preserve user intent and avoid approval spoofing through tool arguments |
| D09 | One implementation writer per run in V1 | Keep workspace ownership and recovery understandable |
| D10 | Unanimous required-reviewer agreement initially | Provide a clear, testable completion rule; preserve disagreement |
| D11 | Saved definitions never carry execution authority | Sharing a team must not share credentials, permissions, or user acceptance |
| D12 | No automatic publishing/merging | Keep local collaboration scope separate from delivery actions |

## Integration risks and required resolution

| Risk | Why it matters | Resolution gate |
| --- | --- | --- |
| Native host acceptance signal unavailable | A model calling start does not prove a user approved | P0 proves a native signal or ships a clearly disclosed interactive terminal fallback |
| Host model/effort not observable | Saved settings could be misrepresented | Label reported/unknown settings; strict roles use managed workers |
| Host cannot change/verify active workspace | Native writes may happen outside a run worktree | Managed builders are baseline; enable host writing only after a tested integration path |
| Host cannot receive unsolicited progress | Background completion may not appear automatically | Cursor-based polling/status is required; push is optional |
| CLI version drift | Flags, settings, and protocol responses can change | Record tested version/transport and revalidate mandatory capabilities before launch |
| Provider quotas or authorization fail mid-run | Teams can lose a required member | Preserve work; retry/replacement only under accepted constraints |
| Recursive skill/MCP discovery in workers | Workers could start nested teams or duplicate orchestration | Child tool/config allowlists and a recursion regression test |
| Same-user process access | Local files/TTY checks are not strong isolation against a hostile same-user process | State the trust boundary; preserve mandatory sandbox requirements rather than promising impossible isolation |
| Crash after external effect | Blind retry can duplicate writes or commands | Durable intent plus process/workspace reconciliation; explicit uncertain state |
| JSONL projection divergence | State and UI could disagree after a crash | One authoritative graph journal; derived projections rebuilt from committed records |
| Cross-review explosion | Pairwise work and context grow quickly | Explicit roster/expansion budgets and review-panel alternatives |
| Consensus without evidence | Agents can agree on a wrong result | Requirement coverage, independent review, exact-target checks, and visible limitations |
| Snapshot misses dirty work | User receives a review of the wrong code | Explicit baseline modes and before/after source fingerprints |
| Incomplete cost accounting | Host usage and provider billing may be unobservable | Separate managed launches, reported usage, and unknown values |

## Required decisions from P0

Record the answer and observed evidence in the implementation change that closes each item:

- [ ] Native acceptance support per host and fallback UX.
- [ ] Host-session identity, model/effort provenance, and reconnect support.
- [ ] Feasible host write-workspace coordination; whether V1 advertises it as supported or experimental.
- [ ] Runtime owner attachment to the existing web application and headless startup path.
- [ ] Tested CLI versions and supported operating environments for the packaged bridge.

These are bounded integration probes, not permission to leave runtime behavior ambiguous. The documented fallback should be usable when a capability is absent.

## Future extensions

After V1 release evidence exists, consider additional providers, remote participants, parallel builders with explicit integration stages, desktop browser/tool brokering, a graphical workflow editor, quorum policies, and plugin marketplace packaging.

Every extension must preserve existing artifact identity, actor authority, versioned definitions, and bounded execution contracts. A provider adapter adds execution capability; it does not get to redefine approval or recovery semantics.

## Scope change policy

Update this pack and its requirement/test traceability when implementation evidence changes a design decision. Do not silently weaken release criteria to fit an incomplete integration. Mark experimental behavior and the verified fallback clearly. Documentation examples must continue to distinguish proposed interfaces from released commands until the release actually includes them.
