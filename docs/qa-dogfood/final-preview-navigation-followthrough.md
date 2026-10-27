# Preview navigation after Stop — final follow-through

Status: fixed and independently reviewed. Base `a4509f143f99206576b113418c81e98e66eea9f5`; branch `codex/qa-final-preview-navigation`.

The frozen full unit run caught a refused navigation to a healthy preview that the test had already stopped. Exactly one unchanged whole-file replay reproduced the product race: Stop returned200 at19:20:39.128UTC, then automatic navigation to that same server dispatched at19:20:39.381,253ms later. Eleven behavior cases passed; the strict after-hook correctly rejected that unexpected400.

Automatic result-preview intents now carry the server generation. Stop invalidates only the matching scope, normalized URL and generation. The browser queue checks current intent before dispatch and completion; obsolete automatic outcomes cannot replace current/manual feedback. Manual browser navigation takes precedence. Reload preserves history without reopening a canceled stopped intent; an explicit successful manual choice of the same URL may restore normally. Backend authority and stale-generation409 protections are unchanged.

The six new regressions cover a held queue followed by Stop and reload; late automatic failure versus manual feedback; late success versus a current error; exact generation/scope/history identity; real stale Stop409 followed by replacement navigation; and a documented mocked Stop409 followed by real same-URL manual navigation/restoration. Passive browser updates cannot erase current action errors.

Validation:

- New `test/qa-preview-navigation-cancel.test.ts`:6/6, strict error audit passed (only seven explicitly generated HTTP failures, matched exactly to console messages).
- Original `test/qa-preview-journeys-ui.test.ts`, unchanged:11/11 on modified sources, browser400=0, errors[].
- TypeScript passes; asset tests2/2 pass.
- Independent source/receipt review: no remaining actionable finding.

A first regression attempt had a fixture resize checkpoint timeout; a subsequent attempt passed all six behaviors but recorded an unclassified400 in its after-hook. That raw evidence remains preserved. One targeted diagnostic did not reproduce it. The final test awaits successful navigation response completion before subsequent actions and cleanup, preserving the strict audit rather than allowing the error.

Already-dispatched backend Chrome work is not claimed to be aborted. The repair prevents obsolete queued client work and suppresses obsolete UI completions; active/manual errors remain visible.

Detailed source/timing/evidence report: `/private/tmp/codeflow-qa-continue/final-preview-navigation-followthrough.md`. Independent report: `final-preview-navigation-review.md` in the same QA root. Final logs/artifacts: `preview-navigation-regression-complete/` and `preview-navigation-original-fixed/`. The entire original fixture was preserved in `preview-navigation-original-20261026/original-full-fixture.tar.gz` (SHA256 `4c1f066281eaeb67601d03331348df601a8f58b4fc8c19d06f3f1ab760bcc306`) with a verified per-file/mode/link manifest.

All execution used explicit scratch CODEFLOW_HOME and synthetic local repos/providers. Frozen integration inputs, live servers, user home, real repositories and remotes were untouched.
