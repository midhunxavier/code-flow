import { git, gitError, PATCH_PATHS, quoteGitPath, type GitCwd } from "./git.js";

/**
 * Test integrity: the check only proves something if the tests it runs are still the tests.
 * An agent stuck on a failing test can make the check pass by deleting or skipping the test,
 * weakening its assertions, or changing what the check command runs. code-flow looks for that
 * in every change it commits and hands what it finds to the agents and to you.
 */

export interface IntegrityIssue {
  /** unverified: git couldn't show the change, so nothing could be checked. */
  kind: "deleted-test" | "skipped-test" | "weakened-test" | "test-config" | "test-script" | "fewer-tests" | "unverified";
  file: string;
  detail: string;
  /** high: very likely to make a failing check pass without fixing anything. */
  severity: "high" | "medium";
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?|e2e)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs|swift|scala)$|_spec\.rb$/i;
const WORKFLOW = /(^|\/)\.github\/workflows\//;
const TEST_CONFIG =
  /(^|\/)(jest|vitest|vite|playwright|cypress|karma|ava|babel)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc(\.[a-z]+)?$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|\.coveragerc|phpunit\.xml(\.dist)?)$|(^|\/)\.github\/workflows\//;
/**
 * Lines that skip a test, focus others (so the rest don't run), mark one as expected to fail, or
 * run it only when a condition holds: `it.skip(`, `test.skip.each(`, `it.skipIf(`, `test.runIf(`,
 * `test.fails(`, `this.skip()`, pytest's and unittest's skips, `{ skip: true }`…
 */
const SKIP =
  /\b(?:describe|it|test|context|suite|bench)(?:\.(?:concurrent|sequential|each))*\.(?:skip|only|todo|skipIf|runIf|fails|failing)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|\bthis\.skip\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|\bself\.skipTest\s*\(|@unittest\.(?:skip\w*|expectedFailure)\b|@(?:Disabled|Ignore)\b|\bt\.(?:Skip(?:Now|f)?|skip|todo)\s*\(|#\[ignore\]|\{\s*(?:skip|todo)\s*:\s*(?:true\b|["'`])/;
const ASSERTION =
  /\b(assert\w*|expect|should|t\.(?:Error|Fatal|Fail)\w*|require\.\w+|deepEqual|strictEqual|notEqual|toBe\w*|toEqual|toMatch\w*|toThrow\w*|toHave\w*|toContain\w*)\b/;

export const isTestFile = (path: string) => TEST_FILE.test(path);

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|rb|cs|swift|php|c|cc|cpp|h|hpp|m|mm|ex|exs|dart|lua|vue|svelte)$/i;
/** Fixtures and expected outputs a test compares against: changing them makes a test pass too. */
const FIXTURE = /(^|\/)(__snapshots__|__fixtures__|fixtures?|testdata|test-data|golden|snapshots?)\/|\.snap$/i;

/**
 * Code that isn't a test, a test's config, or a fixture: a stub a tester added so its tests can
 * import something is this kind, and the builder's to fill in. Anything else the tester wrote
 * (snapshots, golden files, conftest.py) is part of the tests.
 */
export const isPlainSource = (path: string) => SOURCE.test(path) && !TEST_FILE.test(path) && !TEST_CONFIG.test(path) && !FIXTURE.test(path);

/** A test runner's own settings, which decide what it collects (not a build's, like vite.config). */
const RUNNER_CONFIG = /(^|\/)(jest|vitest|playwright|cypress|karma|ava)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc(\.[a-z]+)?$|(^|\/)(pytest\.ini|conftest\.py)$/;

/**
 * The tests side of a change: test files, their fixtures and the runner's settings. A
 * fail-to-pass proof puts these onto the base code, so they run there as they do on the change.
 */
export const isTestSide = (path: string) => TEST_FILE.test(path) || FIXTURE.test(path) || RUNNER_CONFIG.test(path);

/** A test runner's own config file (see RUNNER_CONFIG): nothing in it is anyone's but the tests'. */
export const isRunnerConfig = (path: string) => RUNNER_CONFIG.test(path);

/** Files that hold a test runner's settings among other things: package.json (`jest`…), pyproject.toml (`[tool.pytest…]`). */
const SHARED_CONFIG = /(^|\/)(package\.json|pyproject\.toml)$/;

/**
 * A change to what the test runner collects or how the check runs it: the runner's own config,
 * its settings in package.json or pyproject.toml, or the script the check runs. Build config the
 * tests also read (vite.config, babel) and CI workflows are left out: a change can need those.
 */
export const changesRunner = (i: IntegrityIssue) => i.kind === "test-script" || (i.kind === "test-config" && (RUNNER_CONFIG.test(i.file) || SHARED_CONFIG.test(i.file)));

/**
 * The check found nothing only means something if it could look: when git fails, that is the
 * issue (fail closed), so a pass isn't accepted as clean on no evidence.
 */
export function unverifiedIssue(reason: string): IntegrityIssue {
  return { kind: "unverified", file: "", detail: `couldn't verify test integrity: ${reason.split("\n")[0]!.slice(0, 300)}`, severity: "high" };
}

/** npm/pnpm/yarn script names a check command runs, e.g. `npm test` → test, `npm run test:unit` → test:unit. */
function scriptsRun(check?: string): string[] {
  const names = new Set(["test"]);
  for (const m of (check ?? "").matchAll(/\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/g)) names.add(m[1]!);
  return [...names];
}

function parseJson(raw?: string) {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** package.json keys test runners read their settings from (which tests to collect, which to ignore…). */
const RUNNER_KEYS = ["jest", "vitest", "mocha", "ava"];

/**
 * pytest's settings in a pyproject.toml: its `[tool.pytest.ini_options]` table (or `[tool.pytest]`,
 * and any table under them), without blank lines and comments. Undefined when there are none.
 */
function pytestSettings(toml?: string): string | undefined {
  if (toml === undefined) return undefined;
  const lines: string[] = [];
  let inside = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const header = /^\[\[?([^\]]+)\]\]?(?:\s*#.*)?$/.exec(line);
    if (header) inside = /^tool\.pytest(\.|$)/.test(header[1]!.replace(/[\s"']/g, ""));
    if (inside && line && !line.startsWith("#")) lines.push(line);
  }
  return lines.length ? lines.join("\n") : undefined;
}

async function fileAt(cwd: GitCwd, ref: string, path: string): Promise<string | undefined> {
  const res = await git(["show", "--no-textconv", `${ref}:${path}`], cwd);
  return res.code === 0 ? res.stdout : undefined;
}

/**
 * What a change (`from`..`to`) did to the tests. `tests` compares how many tests ran before and
 * after (from the check's summary), which catches skips the patterns above don't know about.
 */
export async function inspectChanges(
  cwd: GitCwd,
  from: string,
  to = "HEAD",
  opts: { check?: string; tests?: { before?: number; after?: number } } = {},
): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const range = `${from}..${to}`;
  // git's own diff, never an external program or textconv (see RAW_DIFF in git.ts).
  const statusArgs = ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-M", "-z", range];
  const status = await git(statusArgs, cwd);
  if (status.code !== 0) return [unverifiedIssue(gitError(statusArgs, status))];
  const tokens = status.stdout.split("\0").filter(Boolean);
  const changes: { code: string; path: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]![0]!;
    if (code === "R" || code === "C") {
      const [from, to] = [tokens[i + 1]!, tokens[i + 2]!];
      // Renamed out of the test runner's sight (foo.test.ts → foo.ts): the test is gone.
      if (code === "R" && isTestFile(from) && !isTestFile(to)) {
        issues.push({ kind: "deleted-test", file: from, detail: `test file renamed to \`${to}\`, so it no longer runs as a test`, severity: "high" });
      }
      changes.push({ code: "R", path: to });
      i += 2;
    } else {
      changes.push({ code, path: tokens[i + 1]! });
      i += 1;
    }
  }

  for (const { code, path } of changes) {
    if (code === "D" && isTestFile(path)) issues.push({ kind: "deleted-test", file: path, detail: "test file deleted", severity: "high" });
    else if (TEST_CONFIG.test(path)) {
      const what = WORKFLOW.test(path) ? "CI workflow" : "test configuration";
      issues.push({ kind: "test-config", file: path, detail: code === "D" ? `${what} deleted` : `${what} changed`, severity: code === "D" ? "high" : "medium" });
    }
  }

  // Added lines that skip tests, and test files that lost assertions.
  const added = new Set(changes.filter((c) => c.code === "A").map((c) => c.path));
  // A file's `+++` line, matched exactly to its path (git adds a tab after a name with a space).
  const targets = new Map(changes.map((c) => [quoteGitPath(`b/${c.path}`), c.path]));
  const patchArgs = [...PATCH_PATHS.config, "diff", "--no-ext-diff", "--no-textconv", "-U0", "--no-color", "-M", ...PATCH_PATHS.prefixes, range];
  const patch = await git(patchArgs, cwd);
  if (patch.code !== 0) return [...issues, unverifiedIssue(gitError(patchArgs, patch))];
  let file = "";
  let header = false;
  let lineNo = 0;
  const skips: AddedLine[] = [];
  const counts = new Map<string, { removed: number; added: number }>();
  for (const line of patch.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      continue;
    }
    if (line.startsWith("@@")) {
      header = false;
      lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
      continue;
    }
    if (header) {
      if (line.startsWith("+++ ")) file = targets.get(line.slice(4).replace(/\t$/, "")) ?? "";
      continue;
    }
    if (line.startsWith("+")) {
      const text = line.slice(1);
      if (SKIP.test(text)) skips.push({ file, line: lineNo, text });
      if (isTestFile(file) && ASSERTION.test(text)) bump(counts, file, "added");
      lineNo++;
    } else if (line.startsWith("-") && isTestFile(file) && ASSERTION.test(line.slice(1))) {
      bump(counts, file, "removed");
    }
  }
  for (const { file, text } of await codeSkips(cwd, to, skips)) {
    issues.push({ kind: "skipped-test", file, detail: `adds \`${text.trim().slice(0, 120)}\``, severity: added.has(file) ? "medium" : "high" });
  }
  for (const [path, c] of counts) {
    if (!added.has(path) && c.removed > c.added) {
      issues.push({ kind: "weakened-test", file: path, detail: `${c.removed} assertion line(s) removed, ${c.added} added`, severity: "medium" });
    }
  }

  // What the tests run can be changed without touching a test or a config file of its own: the
  // check's script and the runner's settings in package.json, pytest's in pyproject.toml.
  for (const { path } of changes) {
    if (/(^|\/)package\.json$/.test(path)) {
      const [before, after] = await Promise.all([fileAt(cwd, from, path).then(parseJson), fileAt(cwd, to, path).then(parseJson)]);
      // The check runs the root package's scripts.
      for (const name of path === "package.json" ? scriptsRun(opts.check) : []) {
        const was = before?.scripts?.[name];
        const now = after?.scripts?.[name];
        if (was !== undefined && was !== now) {
          issues.push({ kind: "test-script", file: path, detail: `scripts.${name} changed from \`${was}\` to \`${now ?? "(removed)"}\``, severity: "high" });
        }
      }
      for (const key of RUNNER_KEYS) {
        const [was, now] = [before?.[key], after?.[key]].map((v) => (v === undefined ? undefined : JSON.stringify(v)));
        if (was === now) continue;
        const detail = was === undefined ? `adds \`${key}\` settings: ${now!.slice(0, 160)}` : now === undefined ? `\`${key}\` settings removed` : `\`${key}\` settings changed to ${now.slice(0, 160)}`;
        issues.push({ kind: "test-config", file: path, detail, severity: now === undefined ? "high" : "medium" });
      }
    } else if (/(^|\/)pyproject\.toml$/.test(path)) {
      const [was, now] = await Promise.all([fileAt(cwd, from, path).then(pytestSettings), fileAt(cwd, to, path).then(pytestSettings)]);
      if (was === now) continue;
      const detail = was === undefined ? "adds pytest settings ([tool.pytest…])" : now === undefined ? "pytest settings ([tool.pytest…]) removed" : "pytest settings ([tool.pytest…]) changed";
      issues.push({ kind: "test-config", file: path, detail, severity: now === undefined ? "high" : "medium" });
    }
  }

  const { before, after } = opts.tests ?? {};
  if (before !== undefined && after !== undefined && after < before) {
    issues.push({ kind: "fewer-tests", file: "", detail: `${before} tests ran before, ${after} after`, severity: "high" });
  }
  return issues;
}

/** An added line, at its line number in the changed file. */
interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/**
 * The skip markers that are code. A test of a guard against skipped tests writes a skipping test
 * into a fixture, as a string: that line matches SKIP but skips nothing. For Python and JS/TS the
 * file is read as a whole, so strings spanning lines (docstrings, template literals) count too.
 */
async function codeSkips(cwd: GitCwd, ref: string, found: AddedLine[]): Promise<AddedLine[]> {
  const code = new Map<string, Promise<string[] | undefined>>();
  const linesOf = (file: string) => {
    const lang = /\.pyi?$/i.test(file) ? "py" : /\.[cm]?[jt]sx?$/i.test(file) ? "js" : undefined;
    if (!lang) return undefined;
    if (!code.has(file)) code.set(file, fileAt(cwd, ref, file).then((src) => src === undefined ? undefined : blankStrings(src, lang).split("\n")));
    return code.get(file);
  };
  const kept: AddedLine[] = [];
  for (const f of found) {
    const line = (await linesOf(f.file))?.[f.line - 1];
    if (line === undefined || SKIP.test(line)) kept.push(f);
  }
  return kept;
}

/** JS: a `/` after one of these (or at the start) begins a regex literal, not a division. */
const BEFORE_REGEX = /^$|[(,=:[!&|?{};+\-*%<>~^]/;

/**
 * `src` with what's inside string literals and comments blanked out (newlines kept, so lines
 * still line up with the diff), leaving only code. Python or JavaScript/TypeScript; not a full
 * tokenizer, but strings, template literals with `${…}`, comments and regex literals are told apart.
 */
function blankStrings(src: string, lang: "py" | "js"): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < Math.min(to, n); k++) if (out[k] !== "\n") out[k] = " ";
  };
  const upTo = (text: string, from: number) => {
    const j = src.indexOf(text, from);
    return j < 0 ? n : j;
  };
  /** Where quote `q` closes (or the line ends, for a one-line string left open). */
  const closing = (from: number, q: string, multiline: boolean) => {
    let j = from;
    while (j < n && !src.startsWith(q, j) && (multiline || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
    return Math.min(j, n);
  };
  // Open `${` interpolations in template literals, each with its depth of nested braces.
  const braces: number[] = [];
  /** Template text from `from` to the closing backtick or the next `${`; returns where code resumes. */
  const template = (from: number) => {
    let j = from;
    while (j < n && src[j] !== "`" && !src.startsWith("${", j)) j += src[j] === "\\" ? 2 : 1;
    blank(from, j);
    if (src.startsWith("${", j)) {
      braces.push(0);
      return j + 2;
    }
    return j + 1;
  };
  const regexEnd = (from: number) => {
    let j = from;
    for (let inClass = false; j < n && src[j] !== "\n"; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "[") inClass = true;
      else if (src[j] === "]") inClass = false;
      else if (src[j] === "/" && !inClass) break;
    }
    return j;
  };

  let prev = "";
  for (let i = 0; i < n; ) {
    const c = src[i]!;
    let next: number | undefined;
    if (lang === "py" ? c === "#" : src.startsWith("//", i)) {
      next = upTo("\n", i);
      blank(i, next);
    } else if (lang === "js" && src.startsWith("/*", i)) {
      next = Math.min(upTo("*/", i + 2) + 2, n);
      blank(i, next);
    } else if (c === '"' || c === "'") {
      const q = lang === "py" && src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = closing(i + q.length, q, q.length === 3);
      blank(i + q.length, end);
      next = src.startsWith(q, end) ? end + q.length : end;
      prev = c;
    } else if (lang === "js" && c === "`") {
      next = template(i + 1);
      prev = c;
    } else if (lang === "js" && c === "}" && braces.at(-1) === 0) {
      braces.pop();
      next = template(i + 1);
      prev = "`";
    } else if (lang === "js" && c === "/" && BEFORE_REGEX.test(prev)) {
      const end = regexEnd(i + 1);
      blank(i + 1, end);
      next = end + 1;
      prev = "/";
    }
    if (next !== undefined) {
      i = next;
      continue;
    }
    if (braces.length && c === "{") braces[braces.length - 1]!++;
    if (braces.length && c === "}") braces[braces.length - 1]!--;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
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
