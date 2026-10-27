export const meta = {
  name: 'codeflow-fix-verify',
  description: 'Fix every confirmed CodeFlow QA issue cluster in its own worktree, merge serially into the dogfood branch, then independently re-run the original repros',
  phases: [{ title: 'Fix' }, { title: 'Merge' }, { title: 'Verify' }, { title: 'Repair' }],
}

const QA = args.qa
const DOGFOOD = args.dogfood
const BRANCH = args.branch
const SAFETY = `Hard safety rules (these override anything else):
- NEVER touch the user's live CodeFlow server on ports 4317/4318 (PID ${args.livePid}) or ~/.codeflow. Never kill processes by name (no pkill/killall); stop only servers you started, with ${QA}/qa-server.sh stop <name> or by the exact PID you started.
- Never run tasks on the user's real repositories. Make scratch git repos under ${QA}/fixes-scratch/<your cluster key>/ (git init, or 'git clone --no-hardlinks' a real repo there) and register those as projects on your QA server.
- Never git push, never 'gh pr create/merge', never touch remotes. Fake gh is on PATH in fake mode (FAKE_GH_STATE).
- Use http://127.0.0.1:<port>, never localhost. qa-server.sh tokens are qa-<name>-token.
- Real agent CLIs (claude, codex, agy) are signed in; use them only when the issue was originally observed with real agents and a fake run can't show the fix, with the cheapest model/effort (claude haiku, codex low, agy flash low), tiny tasks, at most 2 real runs.
- Do not edit ${DOGFOOD} unless your instructions say you are the integrator.`

const QA_TOOLS = `QA tooling:
- ${QA}/qa-server.sh start <name> <port> fake <srcdir>  → isolated server (own CODEFLOW_HOME=${QA}/homes/<name>, token qa-<name>-token, fake agents from <srcdir>/test/fake-bin, new homes start with no projects). It builds the UI only if <srcdir>/public/index.html is missing — after changing ui/ files run 'node scripts/build-ui.mjs' in <srcdir> yourself, then restart. 'stop <name>' / 'restart <name>' / 'status <name>'. Server log: ${QA}/homes/<name>/server.out. Port must be odd; port+1 is also used.
- ${QA}/qa-browser.mjs: import { openApp } from it; const { browser, page, errors, shot, api, base } = await openApp({ port, name, profile? }) gives headless Chrome signed in, an 'errors' array (console errors, page errors, API 5xx), shot(label) screenshots under ${QA}/shots/<name>/, and api(path, body?, method?) with the bearer token. Run scripts with plain 'node <script>.mjs' from a directory under ${QA}/work/<your key>/ — if node can't resolve packages, set NODE_OPTIONS= and import via absolute paths as qa-browser.mjs does.
- Fake agents: test/fake-agent.mjs and test/fake-work.mjs are steered by task keywords and FAKE_* env vars (read them for the behaviour you need, e.g. AUTO-QUESTION, ASK-APPROVAL, WAIT-FOR-STEER, FAKE_SLEEP_MS). Pass env vars by exporting them before qa-server.sh start.`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, worktree: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' } }, required: ['sha', 'subject'] } },
    issues: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      outcome: { type: 'string', enum: ['fixed', 'duplicate', 'not-a-bug', 'deferred', 'partial'] },
      change: { type: 'string', description: 'what you changed and where (file:line), or why not' },
      verification: { type: 'string', description: 'what you re-ran (original repro on a live QA server, tests) and what you observed' },
      tests: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'outcome', 'change', 'verification', 'tests'] } },
    testsRun: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    tscPassed: { type: 'boolean' },
    notesForIntegrator: { type: 'string' },
  },
  required: ['branch', 'worktree', 'commits', 'issues', 'testsRun', 'tscPassed', 'notesForIntegrator'],
}
const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' }, preMergeSha: { type: 'string' }, mergeSha: { type: 'string' },
    conflicts: { type: 'array', items: { type: 'string' } }, resolutionNotes: { type: 'string' },
    tscPassed: { type: 'boolean' },
    testsRun: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    problems: { type: 'string' },
  },
  required: ['merged', 'preMergeSha', 'mergeSha', 'conflicts', 'resolutionNotes', 'tscPassed', 'testsRun', 'problems'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      verdict: { type: 'string', enum: ['verified', 'still-broken', 'regressed', 'not-applicable'] },
      evidence: { type: 'string' },
    }, required: ['id', 'verdict', 'evidence'] } },
    reviewFindings: { type: 'array', items: { type: 'object', properties: {
      file: { type: 'string' }, line: { type: 'number' }, problem: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor', 'nit'] },
    }, required: ['file', 'problem', 'severity'] } },
    cleanup: { type: 'string' },
  },
  required: ['results', 'reviewFindings', 'cleanup'],
}

let mergeChain = Promise.resolve()
function serial(fn) { const p = mergeChain.then(fn); mergeChain = p.then(() => {}, () => {}); return p }
// Slot budget under the global cap of 8: 4 fixers/repairs + 3 verifiers + 1 merger, so the (serial) merger never
// waits behind work that was queued after it.
function semaphore(n) {
  let active = 0
  const waiters = []
  // urgent work (repairs, re-integrations) jumps ahead of fixers that haven't started yet
  return async (fn, urgent) => {
    if (active >= n) await new Promise(resolve => urgent ? waiters.unshift(resolve) : waiters.push(resolve))
    active++
    try { return await fn() } finally { active--; const next = waiters.shift(); if (next) next() }
  }
}
const fixSlot = semaphore(4)
const verifySlot = semaphore(3)

// Merges that already completed in the first run of this workflow; they replay from the cache with their original
// single-branch prompt. Everything else goes through the batch merger.
const V1_MERGED = new Set(args.v1Merged || [])
const BATCH_MERGE_SCHEMA = {
  type: 'object',
  properties: {
    branches: { type: 'array', items: { type: 'object', properties: {
      branch: { type: 'string' }, merged: { type: 'boolean' },
      mergeCommit: { type: 'string', description: 'sha of the merge commit for this branch (empty if not merged)' },
      parentSha: { type: 'string', description: 'first parent of that merge commit' },
      conflicts: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
    }, required: ['branch', 'merged', 'mergeCommit', 'parentSha', 'conflicts', 'notes'] } },
    finalSha: { type: 'string' }, tscPassed: { type: 'boolean' },
    testsRun: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    problems: { type: 'string' },
  },
  required: ['branches', 'finalSha', 'tscPassed', 'testsRun', 'problems'],
}
function batchMergePrompt(batch) {
  const list = batch.map(b => `- ${b.fix.branch} — cluster ${b.c.key}: ${b.c.title}${b.round ? ` (repair round ${b.round})` : ''}${b.attempt ? ' (re-integrated after an earlier failed merge)' : ''}
  commits: ${JSON.stringify(b.fix.commits.map(x => x.subject))}
  fixer notes: ${(b.fix.notesForIntegrator || '(none)').slice(0, 1500)}`).join('\n')
  return `You are the integrator for QA fixes on the CodeFlow repo. Integration worktree: ${DOGFOOD} (branch ${BRANCH}). You are the only agent allowed to modify it right now; merges are serialized and batched.

Merge these branches into ${BRANCH}, one at a time, in this order:
${list}

For each branch:
  cd ${DOGFOOD}; git status --short must be clean apart from untracked public/ build output (if a merge is half-done from an interrupted earlier integrator, inspect it and 'git merge --abort').
  git merge --no-ff <branch> -m "Merge <branch>: <cluster title>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  On conflicts: read both sides and the commits on each side (git log -p) and resolve so BOTH intents survive — fixes from other clusters already merged must not be lost. Never resolve by blindly taking one side. If a conflict is genuinely irreconcilable, 'git merge --abort' for that branch, report merged:false with the reason, and continue with the next branch.
  If git says 'Already up to date' because an interrupted earlier integrator already merged that branch, find its merge commit (git log --merges --first-parent --grep '<branch>') and report that; still run the checks below.
  Record that branch's merge commit sha and its first parent.
After all branches:
- npx tsc --noEmit must pass. If merges broke types (e.g. two fixes changed the same signature), fix with a follow-up commit on ${BRANCH} (message ending with the Co-Authored-By line above).
- Run each merged cluster's own unit tests (test/qa-<cluster key>*.test.ts) in one tsx --test invocation, plus existing unit tests whose module names appear in the merged diffs (git diff --name-only <first parent>..HEAD; grep test/ for the module names; cap this at ~15 files and prefer the most directly related). Skip e2e here — verifiers run browser checks. Fix anything the merges broke; if a failure also happens before the batch (check in a detached worktree under ${QA}/work/merge-check), it is not caused by the batch — note it in problems.
- Leave the worktree clean (no uncommitted changes, no merge in progress). Never git push or touch remotes. Never start QA servers from ${DOGFOOD}.
${SAFETY}
Return per branch: merged, mergeCommit, parentSha, conflicts, notes; plus finalSha (HEAD of ${BRANCH} at the end), tscPassed, the tests you ran.`
}
const mergeQueue = []
let mergerRunning = false
function enqueueMerge(c, fix, round, attempt) {
  return new Promise(resolve => { mergeQueue.push({ c, fix, round, attempt, resolve }); runMerger() })
}
async function runMerger() {
  if (mergerRunning) return
  mergerRunning = true
  try {
    while (mergeQueue.length) {
      const batch = mergeQueue.splice(0, 8)
      const res = await agent(batchMergePrompt(batch), { label: `merge-batch:${batch.map(b => b.c.key + (b.round ? '#' + b.round : '')).join('+')}`.slice(0, 120), phase: 'Merge', schema: BATCH_MERGE_SCHEMA })
      for (const b of batch) {
        const r = res && res.branches.find(x => x.branch === b.fix.branch)
        b.resolve(r ? { batch: true, merged: r.merged, preMergeSha: r.parentSha, mergeSha: r.mergeCommit, finalSha: res.finalSha, conflicts: r.conflicts, notes: r.notes, tscPassed: res.tscPassed, problems: res.problems } : null)
      }
    }
  } finally { mergerRunning = false }
}
// One branch → merged state. v1-completed merges replay from cache; failed batch merges get one re-integration by
// the owner of the branch (merge the integration branch into it, resolve, re-test) and are queued again.
async function mergeBranch(c, fix, round) {
  const id = `${c.key}#${round}`
  if (V1_MERGED.has(id)) return serial(() => agent(mergePrompt(c, fix, round), { label: round ? `merge:${c.key}#${round}` : `merge:${c.key}`, phase: 'Merge', schema: MERGE_SCHEMA }))
  let merge = await enqueueMerge(c, fix, round, 0)
  if (merge && merge.merged) return merge
  const integ = await fixSlot(() => agent(integratePrompt(c, fix, round, merge), { label: `integrate:${c.key}${round ? '#' + round : ''}`, phase: 'Repair', schema: FIX_SCHEMA }), true)
  if (!integ || !integ.commits.length) return merge
  return enqueueMerge(c, { ...fix, commits: [...fix.commits, ...integ.commits], notesForIntegrator: `${fix.notesForIntegrator || ''}\nRe-integration: ${integ.notesForIntegrator || ''}` }, round, 1)
}
function integratePrompt(c, fix, round, merge) {
  return `The integrator could not merge branch ${fix.branch} (CodeFlow QA fixes for cluster ${c.key}: ${c.title}) into ${BRANCH}. Integrator report: ${JSON.stringify(merge)}
You own that branch. Its worktree is ${QA}/fixes/${c.key}${round ? '-r' + round : ''} (if missing: git -C ${DOGFOOD} worktree add <that path> ${fix.branch}; ln -s ${DOGFOOD}/node_modules into it).
In that worktree: commit or discard nothing that isn't yours; then 'git merge ${BRANCH}' and resolve every conflict so both your fixes and the already-integrated fixes survive (read git log -p on both sides). Run npx tsc --noEmit, your cluster's tests (test/qa-${c.key}*.test.ts) and existing tests for the files you touched. Commit the merge with a message ending in 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'. Don't touch ${DOGFOOD}'s working tree.
${SAFETY}
Return the structured result with 'issues' empty and the new commit(s) in 'commits'.`
}

function fixPrompt(c) {
  return `You are a senior developer on the CodeFlow app (Node/TypeScript server in src/, Preact UI in ui/ built by scripts/build-ui.mjs into public/, tests in test/*.test.ts run with 'tsx --test', browser e2e in test/e2e/*.e2e.ts using playwright-core + Chrome). A thorough hands-on QA pass found and independently reproduced bugs; you own one cluster of them.

Cluster ${c.key}: ${c.title}
Full details of every issue (repro steps, expected, actual, the verifier's reproduction, root cause, suspected files, fix approach, suggested regression test): ${QA}/fixes-in/${c.key}.json — read ALL of it first. It contains ${c.n} issues; its 'cluster.notes' field has the planner's notes on shared root causes and duplicates.

Setup (exactly):
  git -C ${DOGFOOD} worktree add ${QA}/fixes/${c.key} -b qa-fix/${c.key} ${BRANCH}
  ln -s ${DOGFOOD}/node_modules ${QA}/fixes/${c.key}/node_modules
(If that worktree/branch already exists from an earlier attempt, reuse it and continue from its state.) Work only inside ${QA}/fixes/${c.key}.

${SAFETY}

${QA_TOOLS}
Your ports: ${c.port} (and ${c.port + 2} if you need a second server). Name your servers f${c.idx} / f${c.idx}b.

For each issue:
1. Understand the repro and confirm the root cause in the code yourself — the verifier's diagnosis is a lead, not gospel.
2. Fix it at the root, in the right layer (server validation AND UI if both are wrong). Read the surrounding code first and match its style, naming and comment density. No unrelated refactors. Fix complete user-visible behaviour (loading/error/empty states, focus, keyboard) where the issue is about that.
3. Add focused regression coverage in NEW files you own: test/qa-${c.key}.test.ts (and more test/qa-${c.key}-*.test.ts if needed) for logic/API, and test/e2e/qa-${c.key}.e2e.ts for browser-only behaviour (copy the harness style of an existing e2e such as test/e2e/deferred-runs.e2e.ts or test/e2e/project-navigation.e2e.ts). Don't append to shared existing test files (that causes merge conflicts); edit an existing test only where your fix intentionally changes behaviour it asserts, and say so in notesForIntegrator.
4. If docs (docs/*.md) describe behaviour wrongly, correct them minimally; if the docs are right and the code is wrong, fix the code.
5. Duplicates: fix once, mark the others 'duplicate' naming the id that carries the fix. If on reflection something is not a bug, or needs a product decision, a large new feature, or infrastructure we don't have, mark it 'not-a-bug' or 'deferred' with a precise reason — don't paper over it. Prefer fixing over deferring.

Validation (all required):
- npx tsc --noEmit passes in your worktree (baseline on the base commit: ${QA}/work/base-tsc.log).
- Your new tests pass, and existing tests for every module you touched still pass (find them with grep; run with npx tsx --test <files>). E2e tests are flaky on this machine; rerun a failing one once and compare against the base before blaming your change.
- Re-run each fixed issue's ORIGINAL repro, the way the tester did it, against a QA server started from your worktree (rebuild the UI first if you changed ui/). Check the browser 'errors' array and the server log. Describe what you saw in 'verification'. A unit test passing is not enough on its own for a user-visible bug.
- Stop your QA servers and remove ${QA}/fixes-scratch/${c.key} scratch repos you no longer need (keep your worktree and branch).
- Commit on qa-fix/${c.key} (logical commits, conventional imperative subject lines like the repo's history; never commit public/, node_modules, or scratch files). Every commit message must end with the line:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

Return the structured result. 'issues' must contain every id in the cluster exactly once.`
}

function mergePrompt(c, fix, attempt) {
  return `You are the integrator for a batch of QA fixes on the CodeFlow repo. Integration worktree: ${DOGFOOD} (branch ${BRANCH}). You are the only agent allowed to modify it right now; merges are serialized.

Merge branch ${fix.branch} (cluster ${c.key}: ${c.title}${attempt ? `, repair round ${attempt}` : ''}) into ${BRANCH}:
  cd ${DOGFOOD} && git status --short   (must be clean apart from untracked public/ build output; if a previous merge was left half-done, inspect it, then 'git merge --abort' only if it is clearly not yours)
  git rev-parse HEAD   → preMergeSha
  git merge --no-ff ${fix.branch} -m "Merge ${fix.branch}: ${c.title.replace(/"/g, "'")}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
The fixer's notes: ${fix.notesForIntegrator || '(none)'}
Commits: ${JSON.stringify(fix.commits)}

If there are conflicts: read both sides and the commits on each side (git log -p) and resolve so BOTH intents survive — other clusters' fixes already merged must not be lost. Never resolve by blindly taking one side. If the conflict is genuinely irreconcilable, 'git merge --abort' and report merged:false with the details.
After merging (whether or not there were conflicts):
- npx tsc --noEmit must pass. If the merge broke types (e.g. two fixes changed the same signature), fix it with a follow-up commit on ${BRANCH} (message ending with the Co-Authored-By line above).
- Run the cluster's own tests (test/qa-${c.key}*.test.ts, and test/e2e/qa-${c.key}*.e2e.ts if present) plus the existing tests for files touched by this merge (git diff --name-only preMergeSha HEAD; grep test/ for the module names). Fix anything this merge broke; if a failure also happens at preMergeSha (check with 'git stash'-free methods: a detached worktree at preMergeSha under ${QA}/work/merge-check), it is not caused by this merge — note it in problems.
- Leave the worktree clean (no uncommitted changes, no merge in progress). Do not run git push or touch remotes. Do not start QA servers from ${DOGFOOD}.
${SAFETY}
Return preMergeSha, mergeSha (final HEAD of ${BRANCH} after any follow-up commits), and what you ran.`
}

function verifyPrompt(c, fix, merge, round) {
  const claimed = fix.issues.filter(i => i.outcome === 'fixed' || i.outcome === 'partial').map(i => i.id)
  return `You are an independent, skeptical verifier for CodeFlow QA fixes (cluster ${c.key}: ${c.title}${round ? `, re-check after repair round ${round}` : ''}). Don't trust the fixer's report; reproduce yourself.

Original issues (repro, expected, actual): ${QA}/fixes-in/${c.key}.json. The fixer claims these are fixed: ${JSON.stringify(claimed)}. Fixer report per issue: ${JSON.stringify(fix.issues.map(i => ({ id: i.id, outcome: i.outcome, change: i.change })))}
${merge.batch ? `The fix was merged into ${BRANCH} by merge commit ${merge.mergeSha} (diff of this cluster: git -C ${DOGFOOD} diff ${merge.preMergeSha} ${merge.mergeSha}); the integrated branch after that merge batch is ${merge.finalSha}.

1. Create a detached worktree of the integrated commit: git -C ${DOGFOOD} worktree add --detach ${QA}/verify/${c.key}${round ? '-r' + round : ''} ${merge.finalSha}; ln -s ${DOGFOOD}/node_modules into it.` : `The fix landed on ${BRANCH} at ${merge.mergeSha} (diff of this cluster: git -C ${DOGFOOD} diff ${merge.preMergeSha} ${merge.mergeSha}).

1. Create a detached worktree of exactly that commit: git -C ${DOGFOOD} worktree add --detach ${QA}/verify/${c.key}${round ? '-r' + round : ''} ${merge.mergeSha}; ln -s ${DOGFOOD}/node_modules into it.`}
2. Start a QA server from it (fake mode; names v${c.idx}${round ? 'r' + round : ''}, port ${c.port + 4}; qa-server.sh builds the UI because public/ is missing) and re-run every claimed issue's ORIGINAL repro the way a developer would, in the UI with headless Chrome where the issue is user-visible (API only for API issues). Use scratch repos under ${QA}/fixes-scratch/v-${c.key}/. Check the browser errors array and the server log. Also try one or two nearby variations a fix commonly misses (other entry point, reload, narrow viewport, repeated click, error path).
3. Review the cluster diff for correctness: wrong conditions, missed callers, broken edge cases, security regressions (auth, path traversal, injection), behaviour changes to unrelated features, tests that don't actually test the fix. Report concrete findings only, with file:line.
4. Verdict per claimed id: verified (original repro now behaves as expected), still-broken, regressed (something else broke), or not-applicable (can't be exercised here — say exactly why). Include the evidence (what you did, what you saw).
5. Stop your server (qa-server.sh stop <name>), remove the verify worktree (git -C ${DOGFOOD} worktree remove --force ${QA}/verify/${c.key}${round ? '-r' + round : ''}) and your scratch repos. Report cleanup.
${SAFETY}
${QA_TOOLS}`
}

function repairPrompt(c, fix, verify, round) {
  const bad = verify.results.filter(r => r.verdict === 'still-broken' || r.verdict === 'regressed')
  const findings = verify.reviewFindings.filter(f => f.severity !== 'nit')
  return `You are fixing what an independent verifier found wrong with the QA fixes for CodeFlow cluster ${c.key} (${c.title}), repair round ${round}.
Original issue details: ${QA}/fixes-in/${c.key}.json. The first fix is already merged into ${BRANCH} (see git log --merges for qa-fix/${c.key}).
Verifier results that failed: ${JSON.stringify(bad)}
Verifier code-review findings: ${JSON.stringify(findings)}

Setup: git -C ${DOGFOOD} worktree add ${QA}/fixes/${c.key}-r${round} -b qa-fix/${c.key}-r${round} ${BRANCH}; ln -s ${DOGFOOD}/node_modules into it. Work only there.
Fix each failing item and each valid review finding (if a finding is wrong, say why). Extend test/qa-${c.key}*.test.ts / test/e2e/qa-${c.key}*.e2e.ts so the failure is caught. Validate exactly as before: npx tsc --noEmit, the tests, and the original repro on a QA server from your worktree (name r${c.idx}${round}, port ${c.port + 2}). Commit with messages ending in 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'. Stop your servers.
${SAFETY}
${QA_TOOLS}
Return the structured result; 'issues' lists only the ids you worked on this round (failed ids, plus a pseudo-id 'review-<n>' per review finding addressed).`
}

const clusters = args.clusters
log(`Fixing ${clusters.length} clusters (${clusters.reduce((n, c) => n + c.n, 0)} issues)`)

const results = await pipeline(
  clusters,
  c => fixSlot(() => agent(fixPrompt(c), { label: `fix:${c.key}`, phase: 'Fix', schema: FIX_SCHEMA })),
  (fix, c) => {
    if (!fix) return null
    if (!fix.commits.length) return { c, fix, merge: null, verify: null, rounds: [] }
    return mergeBranch(c, fix, 0).then(merge => ({ c, fix, merge, verify: null, rounds: [] }))
  },
  async (st) => {
    if (!st || !st.merge || !st.merge.merged) return st
    const { c, fix } = st
    let verify = await verifySlot(() => agent(verifyPrompt(c, fix, st.merge, 0), { label: `verify:${c.key}`, phase: 'Verify', schema: VERIFY_SCHEMA }))
    st.verify = verify
    for (let round = 1; round <= 2 && verify; round++) {
      const failing = verify.results.filter(r => r.verdict === 'still-broken' || r.verdict === 'regressed')
      const serious = verify.reviewFindings.filter(f => f.severity === 'major' || f.severity === 'minor')
      if (!failing.length && !serious.length) break
      const rep = await fixSlot(() => agent(repairPrompt(c, fix, verify, round), { label: `repair:${c.key}#${round}`, phase: 'Repair', schema: FIX_SCHEMA }), true)
      if (!rep || !rep.commits.length) { st.rounds.push({ round, repair: rep, merge: null, verify: null }); break }
      const merge = await mergeBranch(c, rep, round)
      if (!merge || !merge.merged) { st.rounds.push({ round, repair: rep, merge, verify: null }); break }
      const fixForVerify = { ...fix, issues: fix.issues.filter(i => failing.some(f => f.id === i.id)) }
      verify = await verifySlot(() => agent(verifyPrompt(c, fixForVerify.issues.length ? fixForVerify : fix, merge, round), { label: `verify:${c.key}#${round}`, phase: 'Verify', schema: VERIFY_SCHEMA }))
      st.rounds.push({ round, repair: rep, merge, verify })
    }
    return st
  },
)
const done = results.filter(Boolean)
const tally = { fixed: 0, duplicate: 0, 'not-a-bug': 0, deferred: 0, partial: 0 }
for (const r of done) for (const i of r.fix?.issues || []) tally[i.outcome] = (tally[i.outcome] || 0) + 1
log(`Clusters done ${done.length}/${clusters.length}; outcomes ${JSON.stringify(tally)}`)
return { results }
