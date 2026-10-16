import { git } from "./git.js";

/**
 * Test integrity: the check only proves something if the tests it runs are still the tests.
 * An agent stuck on a failing test can make the check pass by deleting or skipping the test,
 * weakening its assertions, or changing what the check command runs. code-flow looks for that
 * in every change it commits and hands what it finds to the agents and to you.
 */

export interface IntegrityIssue {
  kind: "deleted-test" | "skipped-test" | "weakened-test" | "test-config" | "test-script" | "fewer-tests";
  file: string;
  detail: string;
  /** high: very likely to make a failing check pass without fixing anything. */
  severity: "high" | "medium";
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift|scala)$|_spec\.rb$/i;
const TEST_CONFIG =
  /(^|\/)(jest|vitest|vite|playwright|cypress|karma|ava|babel)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc(\.[a-z]+)?$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|\.coveragerc|phpunit\.xml(\.dist)?)$|(^|\/)\.github\/workflows\//;
const SKIP =
  /\b(?:describe|it|test|context|suite)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip|@(?:Disabled|Ignore)\b|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]|\{\s*skip\s*:\s*true\b|\{\s*todo\s*:\s*true\b/;
const ASSERTION =
  /\b(assert\w*|expect|should|t\.(?:Error|Fatal|Fail)\w*|require\.\w+|deepEqual|strictEqual|notEqual|toBe\w*|toEqual|toMatch\w*|toThrow\w*|toHave\w*|toContain\w*)\b/;

export const isTestFile = (path: string) => TEST_FILE.test(path);

/** npm/pnpm/yarn script names a check command runs, e.g. `npm test` → test, `npm run test:unit` → test:unit. */
function scriptsRun(check?: string): string[] {
  const names = new Set(["test"]);
  for (const m of (check ?? "").matchAll(/\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/g)) names.add(m[1]!);
  return [...names];
}

async function fileAt(cwd: string, ref: string, path: string): Promise<string | undefined> {
  const res = await git(["show", `${ref}:${path}`], cwd);
  return res.code === 0 ? res.stdout : undefined;
}

/**
 * What a change (`from`..`to`) did to the tests. `tests` compares how many tests ran before and
 * after (from the check's summary), which catches skips the patterns above don't know about.
 */
export async function inspectChanges(
  cwd: string,
  from: string,
  to = "HEAD",
  opts: { check?: string; tests?: { before?: number; after?: number } } = {},
): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const range = `${from}..${to}`;
  const status = await git(["diff", "--name-status", "-M", "-z", range], cwd);
  if (status.code !== 0) return issues;
  const tokens = status.stdout.split("\0").filter(Boolean);
  const changes: { code: string; path: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]![0]!;
    if (code === "R" || code === "C") {
      changes.push({ code: "R", path: tokens[i + 2]! });
      i += 2;
    } else {
      changes.push({ code, path: tokens[i + 1]! });
      i += 1;
    }
  }

  for (const { code, path } of changes) {
    if (code === "D" && isTestFile(path)) issues.push({ kind: "deleted-test", file: path, detail: "test file deleted", severity: "high" });
    else if (TEST_CONFIG.test(path)) {
      issues.push({ kind: "test-config", file: path, detail: code === "D" ? "test configuration deleted" : "test configuration changed", severity: code === "D" ? "high" : "medium" });
    }
  }

  // Added lines that skip tests, and test files that lost assertions.
  const added = new Set(changes.filter((c) => c.code === "A").map((c) => c.path));
  const patch = await git(["diff", "-U0", "--no-color", "-M", range], cwd);
  let file = "";
  let header = false;
  const counts = new Map<string, { removed: number; added: number }>();
  for (const line of patch.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      continue;
    }
    if (line.startsWith("@@")) {
      header = false;
      continue;
    }
    if (header) {
      if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (line.startsWith("+")) {
      const text = line.slice(1);
      if (SKIP.test(text)) {
        issues.push({ kind: "skipped-test", file, detail: `adds \`${text.trim().slice(0, 120)}\``, severity: added.has(file) ? "medium" : "high" });
      }
      if (isTestFile(file) && ASSERTION.test(text)) bump(counts, file, "added");
    } else if (line.startsWith("-") && isTestFile(file) && ASSERTION.test(line.slice(1))) {
      bump(counts, file, "removed");
    }
  }
  for (const [path, c] of counts) {
    if (!added.has(path) && c.removed > c.added) {
      issues.push({ kind: "weakened-test", file: path, detail: `${c.removed} assertion line(s) removed, ${c.added} added`, severity: "medium" });
    }
  }

  // The check command can be changed without touching a test: package.json scripts.
  if (changes.some((c) => c.path === "package.json")) {
    const parse = (raw?: string) => {
      try {
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    };
    const [before, after] = await Promise.all([fileAt(cwd, from, "package.json").then(parse), fileAt(cwd, to, "package.json").then(parse)]);
    for (const name of scriptsRun(opts.check)) {
      const was = before?.scripts?.[name];
      const now = after?.scripts?.[name];
      if (was !== undefined && was !== now) {
        issues.push({ kind: "test-script", file: "package.json", detail: `scripts.${name} changed from \`${was}\` to \`${now ?? "(removed)"}\``, severity: "high" });
      }
    }
  }

  const { before, after } = opts.tests ?? {};
  if (before !== undefined && after !== undefined && after < before) {
    issues.push({ kind: "fewer-tests", file: "", detail: `${before} tests ran before, ${after} after`, severity: "high" });
  }
  return issues;
}

function bump(map: Map<string, { removed: number; added: number }>, file: string, key: "removed" | "added") {
  const entry = map.get(file) ?? { removed: 0, added: 0 };
  entry[key]++;
  map.set(file, entry);
}

/** Issues as a markdown list (for prompts, summaries and the PR body). */
export function describeIssues(issues: IntegrityIssue[]): string {
  return issues.map((i) => `- **${i.severity}** ${i.file ? `\`${i.file}\`: ` : ""}${i.detail}`).join("\n");
}

/** Stable identity of a set of issues, to tell "the same problem again" from a new one. */
export function issuesKey(issues: IntegrityIssue[]): string {
  return issues
    .map((i) => `${i.kind}|${i.file}|${i.detail}`)
    .sort()
    .join("\n");
}
