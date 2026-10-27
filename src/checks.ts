import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCKER_UNREACHABLE, killGroup, trackGroup, untrackGroup } from "./adapters/process.js";
import { timerMs } from "./config.js";
import { childEnv } from "./env.js";

/**
 * The "done when" check: a command code-flow runs itself (never an agent) in a worktree,
 * so loops end on evidence — tests passing — rather than on an agent saying it is done.
 */

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Cancellation never counts as a successful check, even if the child exits zero. */
  aborted?: boolean;
  durationMs: number;
  /** Combined stdout/stderr, trimmed to the end (where failures usually are). */
  output: string;
  /** Tests that ran (passed + failed), when the runner's summary says. */
  tests?: number;
  /** Tests that failed (pytest: and errored), when the runner's summary says. */
  failed?: number;
  /** Ran in a Docker container: Docker's own failures (a stopped daemon) aren't the command's. */
  container?: boolean;
}

const KEEP_OUTPUT = 20_000;

export interface DetectedCheck {
  command: string;
  /** Why it was picked, for "Detected from …". */
  source: string;
  /** Installs the project's dependencies in each new worktree, before agents start. */
  setup?: string;
}

/** Best guess at the repo's test command (and setup); the user can always edit it. */
export async function detectCheckCommand(repo: string): Promise<DetectedCheck | null> {
  return (await detectCheck(repo)).check;
}

/**
 * `detectCheckCommand`, and what it had to skip on the way: a package.json that isn't valid JSON
 * says nothing about its test script, so the other runners are still tried, and the warning
 * tells you why its script wasn't used.
 */
export async function detectCheck(repo: string): Promise<{ check: DetectedCheck | null; warning?: string }> {
  const has = (file: string) => existsSync(join(repo, file));
  const read = (file: string) => readFile(join(repo, file), "utf8").catch(() => "");

  let warning: string | undefined;
  if (has("package.json")) {
    let pkg: { scripts?: Record<string, unknown> } | undefined;
    // npm itself reads a package.json that starts with a byte-order mark.
    try { pkg = JSON.parse((await read("package.json")).replace(/^\uFEFF/, "") || "{}"); }
    catch { warning = "package.json is not valid JSON, so its test script was skipped"; }
    const test: unknown = pkg?.scripts?.test;
    if (typeof test === "string" && test.trim() && !/no test specified/.test(test)) {
      const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun run" : "npm";
      return { check: { command: `${runner} test`, source: "package.json" } };
    }
  }
  const found = (check: DetectedCheck | null) => ({ check, ...(warning ? { warning } : {}) });
  if (has("Cargo.toml")) return found({ command: "cargo test", source: "Cargo.toml" });
  if (has("go.mod")) return found({ command: "go test ./...", source: "go.mod" });
  const pytest = await detectPytest(has, read);
  if (pytest) return found(pytest);
  if (has("Makefile")) {
    const makefile = await read("Makefile");
    if (/^test\s*:/m.test(makefile)) return found({ command: "make test", source: "Makefile" });
  }
  return found(null);
}

/**
 * pytest, run the way the project installs its dependencies: system Python doesn't have a uv or
 * Poetry project's packages, so its tests can't even be collected there. Setup installs them
 * once per worktree, outside the agents' sandboxes (Codex has no network in Standard mode); the
 * check then runs without syncing. When the pytest config lives only in tests/ (a workspace
 * member of its own), the check runs from there.
 */
async function detectPytest(has: (file: string) => boolean, read: (file: string) => Promise<string>): Promise<DetectedCheck | null> {
  const pyproject = has("pyproject.toml") ? await read("pyproject.toml") : "";
  const configured = /^\[tool\.pytest\b/m;
  const rootConfig = has("pytest.ini") || has("conftest.py") || has("tox.ini") || configured.test(pyproject);
  const testsConfig = has("tests/pytest.ini") ? "tests/pytest.ini" : has("tests/pyproject.toml") && configured.test(await read("tests/pyproject.toml")) ? "tests/pyproject.toml" : "";
  const source =
    has("pytest.ini") || has("conftest.py") || has("tox.ini")
      ? "pytest config"
      : !rootConfig && testsConfig
        ? testsConfig
        : pyproject && (/pytest/.test(pyproject) || has("tests"))
          ? "pyproject.toml"
          : "";
  if (!source) return null;
  const cd = !rootConfig && testsConfig ? "cd tests && " : "";
  if (has("uv.lock")) {
    const workspace = /^\[tool\.uv\.workspace\]/m.test(pyproject);
    return {
      command: `${cd}uv run --no-sync pytest -q`,
      setup: workspace ? "uv sync --all-packages" : "uv sync",
      source: `${source} and uv.lock${workspace ? " (a uv workspace)" : ""}`,
    };
  }
  if (has("poetry.lock")) return { command: `${cd}poetry run pytest -q`, setup: "poetry install", source: `${source} and poetry.lock` };
  return { command: `${cd}python3 -m pytest -q`, source };
}

/**
 * Run commands in a throwaway Docker container instead of on your machine (unattended runs).
 * Only the worktree is mounted read-write (plus the repo's .git read-only, so git works);
 * none of your environment variables or home directory are visible inside.
 */
export interface Container {
  image: string;
  /** false = no network inside the container. */
  network?: boolean;
  /** Extra host paths mounted read-only at the same path. */
  readOnly?: string[];
}

export function dockerArgs(cwd: string, command: string, container: Container, name: string): string[] {
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "-v",
    `${cwd}:${cwd}`,
    ...(container.readOnly ?? []).flatMap((p) => ["-v", `${p}:${p}:ro`]),
    "-w",
    cwd,
    "-e",
    "CI=1",
    "-e",
    "FORCE_COLOR=0",
    "-e",
    "NO_COLOR=1",
    "-e",
    "HOME=/tmp",
    ...user,
    ...(container.network === false ? ["--network", "none"] : []),
    container.image,
    "/bin/sh",
    "-c",
    command,
  ];
}

/** Run a shell command in `cwd` with a timeout; the whole process group is killed on timeout/abort. */
export function runCheck(cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal; container?: Container }): Promise<CheckResult> {
  const started = Date.now();
  if (opts.signal?.aborted) return Promise.resolve({ command, ok: false, exitCode: null, timedOut: false, aborted: true, durationMs: 0, output: "[check cancelled before starting]" });
  const env: NodeJS.ProcessEnv = { ...childEnv(), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  // Inherited from whatever runs code-flow; a nested `node --test` would silently skip every
  // test and exit 0 — a false pass.
  delete env.NODE_TEST_CONTEXT;
  const containerName = `codeflow-${randomBytes(5).toString("hex")}`;
  const [bin, args] = opts.container ? ["docker", dockerArgs(cwd, command, opts.container, containerName)] : ["/bin/sh", ["-c", command]];
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      detached: true, // own process group, so test runners' children die with it
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    trackGroup(child.pid);
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > KEEP_OUTPUT * 2) output = output.slice(-KEEP_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const stop = () => {
      killGroup(child.pid);
      // Stopping the docker client doesn't always stop the container.
      if (opts.container) spawn("docker", ["rm", "-f", containerName], { stdio: "ignore" }).on("error", () => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timerMs(opts.timeoutMs, 1));
    const onAbort = () => { aborted = true; stop(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackGroup(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      const trimmed = output.length > KEEP_OUTPUT ? `…\n${output.slice(-KEEP_OUTPUT)}` : output;
      const summary = testCounts(output);
      resolve({
        command,
        ok: exitCode === 0 && !timedOut && !aborted && !(summary.failed ?? 0),
        exitCode,
        timedOut,
        ...(aborted ? { aborted: true } : {}),
        durationMs: Date.now() - started,
        output: timedOut ? `${trimmed}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]` : trimmed,
        ...summary,
        ...(opts.container ? { container: true } : {}),
      });
    };
    child.on("error", (err) => {
      output += opts.container && /ENOENT/.test(err.message) ? "\nDocker isn't installed or not on PATH" : `\n${err.message}`;
      finish(null);
    });
    // Leftover background processes (a server a test started) would hold the pipes open.
    child.on("exit", (code) => {
      killGroup(child.pid, 2_000);
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 3_000).unref();
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * How many tests ran and how many of them failed, read from the runner's summary (node --test,
 * Jest, Vitest, Mocha, pytest, cargo, Go). Skipped tests don't count: a drop in tests between two
 * runs means tests were removed or skipped. Empty when the output has no summary code-flow
 * recognizes.
 */
export function testCounts(output: string): { tests?: number; failed?: number } {
  const tail = output.slice(-20_000);
  const last = (re: RegExp) => {
    const all = [...tail.matchAll(re)];
    return all.length ? all[all.length - 1]! : undefined;
  };
  const n = (s: string | undefined) => (s ? Number(s) : 0);
  const counts = (passed: number, failed: number) => ({ tests: passed + failed, failed });
  // node --test: "# pass 12" / "# fail 1" (TAP) or "ℹ pass 12" / "ℹ fail 1" (spec reporter)
  const nodePass = last(/^(?:#|ℹ) pass (\d+)/gm);
  if (nodePass) return counts(n(nodePass[1]), n(last(/^(?:#|ℹ) fail (\d+)/gm)?.[1]));
  // Jest: "Tests:       1 failed, 2 skipped, 10 passed, 13 total"
  const jest = last(/^Tests:\s+(.*\d+ total)/gm);
  if (jest) return counts(n(jest[1]!.match(/(\d+) passed/)?.[1]), n(jest[1]!.match(/(\d+) failed/)?.[1]));
  // Vitest: "Tests  2 failed | 10 passed (12)"
  const vitest = last(/^\s*Tests\s+(.*\(\d+\))/gm);
  if (vitest) return counts(n(vitest[1]!.match(/(\d+) passed/)?.[1]), n(vitest[1]!.match(/(\d+) failed/)?.[1]));
  // cargo: "test result: ok. 10 passed; 0 failed; 1 ignored" (one line per test binary)
  const cargo = [...tail.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return counts(cargo.reduce((sum, m) => sum + n(m[1]), 0), cargo.reduce((sum, m) => sum + n(m[2]), 0));
  // pytest: "===== 2 failed, 10 passed, 1 skipped, 1 error in 0.12s =====", or the same without the
  // bars under -q. An error (in a fixture, or a module that doesn't import) is a test that ran
  // and didn't pass, so "9 passed, 1 error" is 10 tests, and "1 error in 0.07s" is a summary too.
  const pytest = [...tail.matchAll(/^=*\s*(\d+ [a-z]+(?:, \d+ [a-z]+)*) in [\d.]+s\b/gm)].filter((m) => /\d+ (?:passed|failed|errors?)\b/.test(m[1]!)).pop();
  if (pytest) {
    const failed = n(pytest[1]!.match(/(\d+) failed/)?.[1]) + n(pytest[1]!.match(/(\d+) errors?\b/)?.[1]);
    return counts(n(pytest[1]!.match(/(\d+) passed/)?.[1]), failed);
  }
  // Mocha: "  10 passing" / "  2 failing"
  const mocha = last(/^\s+(\d+) passing/gm);
  if (mocha) return counts(n(mocha[1]), n(last(/^\s+(\d+) failing/gm)?.[1]));
  // go test -v: one line per test
  const go = tail.match(/^--- (?:PASS|FAIL): /gm);
  if (go) return { tests: go.length, failed: go.filter((l) => l.includes("FAIL")).length };
  return {};
}

/** How many tests ran, from the runner's summary (see `testCounts`). */
export function countTests(output: string): number | undefined {
  return testCounts(output).tests;
}

const TEST_RUNNER =
  /^(npm (run )?test|npm run test:[\w:-]+|pnpm (run )?test|yarn (run )?test|bun (run )?test|npx (jest|vitest|mocha|ava|playwright test)|node --test|deno test|python3? -m (pytest|unittest)|pytest|(uv run (--no-sync )?|poetry run )(python3? -m )?pytest|cargo test|go test|make test|mvn test|gradle test|\.\/gradlew test|dotnet test|bundle exec rspec|rspec|mix test|swift test)(\s|$)/;

/**
 * Agents can suggest a test command (e.g. the tester in Test-first). code-flow runs that outside
 * the agent's sandbox, so only accept a plain invocation of a known test runner: no shell
 * operators, substitutions or redirects.
 */
export function isPlainTestCommand(command: string): boolean {
  const c = command.trim();
  return c.length > 0 && c.length < 300 && !/[;&|`$<>\n\\]/.test(c) && TEST_RUNNER.test(c);
}

const FAILURE_LINE = /\b(fail(ed|ing|ure)?|errors?|exception|panic(ked)?|assert(ion)?|expected|traceback)\b|✗|✕|×|not ok\b/i;

/**
 * The part of a check's output an agent needs: when it's too long to pass whole, the lines
 * around each failure (wherever they are in the output) plus the end, where runners print
 * their summary. Cutting from the end alone loses the first failures of a long test run.
 */
export function failureExcerpt(output: string, max = 6_000): string {
  const text = output.trim();
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE_LINE.test(lines[i]!)) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 6); j++) keep.add(j);
  }
  // Always keep the summary at the end.
  const tailBudget = Math.floor(max / 3);
  let tailStart = lines.length;
  for (let size = 0; tailStart > 0 && size + lines[tailStart - 1]!.length + 1 <= tailBudget; ) size += lines[--tailStart]!.length + 1;
  const parts: string[] = [];
  let size = 0;
  let previous = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i >= tailStart) break;
    const line = lines[i]!.length > 500 ? `${lines[i]!.slice(0, 500)}…` : lines[i]!;
    if (size + line.length + 1 > max - tailBudget) break;
    if (i !== previous + 1) parts.push("…");
    parts.push(line);
    size += line.length + 1;
    previous = i;
  }
  parts.push("…", ...lines.slice(tailStart));
  return parts.join("\n");
}

/** Comparable fingerprint of a failure, ignoring timings and other noise, to detect "no progress". */
export function failureFingerprint(result: CheckResult): string {
  return result.output
    .slice(-4_000)
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why a failed check couldn't run at all — the environment is wrong, not the code: the command
 * isn't installed, Python has neither pytest nor the project's own package, pytest couldn't load
 * conftest.py or collected nothing. Returns the line that says so (the first error line), or
 * undefined when the check ran: passing, failing tests, or a timeout.
 */
export function cantRunReason(result: CheckResult): string | undefined {
  if (result.ok || result.timedOut) return undefined;
  const output = result.output;
  const lines = output
    .split("\n")
    .map((l) => l.replace(/^E\s+/, "").trim())
    .filter(Boolean);
  const first = (...res: RegExp[]) => {
    for (const re of res) {
      const line = lines.find((l) => re.test(l));
      if (line) return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }
    return undefined;
  };
  const missingModule = /ModuleNotFoundError|No module named/;
  const code = result.exitCode;

  const noRunner = runnerMissing(result);
  if (noRunner) return noRunner;

  if (!/\bpytest\b/.test(result.command) && !/^=+ .*(test session starts|no tests ran)|^rootdir: |while loading conftest/m.test(output)) return undefined;
  // 4: conftest.py failed to import, or a usage error; 5: nothing collected.
  if (code === 4) return first(missingModule, /ImportError/, /^ERROR\b/) ?? "pytest couldn't start (exit code 4)";
  if (code === 5) return first(/no tests ran/i, /collected 0 items/) ?? "pytest collected no tests (exit code 5)";
  // Test modules that can't import the project's own package: it isn't installed here.
  if (/errors? during collection/.test(output) && missingModule.test(output)) return first(missingModule);
  return undefined;
}

/**
 * The test runner itself isn't there: the shell couldn't find (126: couldn't execute) the
 * command (`uv`, `poetry`, `pytest`…), `python3 -m pytest` without pytest, or uv or Poetry with
 * nothing installed in the environment. In a container, Docker itself couldn't run it: its
 * daemon isn't running or reachable, or `docker run` failed (exit 125: no such image, a bad
 * mount). Returns the line that says so.
 */
export function runnerMissing(result: CheckResult): string | undefined {
  if (result.ok || result.timedOut) return undefined;
  const lines = result.output
    .split("\n")
    .map((l) => l.replace(/^E\s+/, "").trim())
    .filter(Boolean);
  const first = (...res: RegExp[]) => {
    for (const re of res) {
      const line = lines.find((l) => re.test(l));
      if (line) return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }
    return undefined;
  };
  const code = result.exitCode;
  if (result.container) {
    const docker = first(DOCKER_UNREACHABLE, /^Docker isn't installed/);
    if (docker) return docker;
    if (code === 125) return first(/^docker: /i, /^Unable to find image/i) ?? "Docker couldn't start the container (exit code 125)";
  }
  if (code === 127 || code === 126) return first(/not found/i, /cannot execute|permission denied|no such file/i) ?? `command not found (exit code ${code})`;
  return first(/No module named '?pytest'?$/, /^error: Failed to spawn: /, /^Command not found: /);
}

/**
 * What a fail-to-pass proof's run says: the check on the base code, with the change's tests put
 * onto it. Failing there is the point (a test needs the change); passing means none does. A run
 * that couldn't get as far as the tests (no test runner, nothing collected, a timeout) says
 * neither. A test that can't import code only the change adds does fail for the change, but only
 * shows the code is there, not that it works: failing only that way is a weak proof.
 */
export function proofOutcome(result: CheckResult): { status: "proven" | "weak" | "unproven" | "unverified"; detail: string } {
  if (result.ok) return { status: "unproven", detail: `\`${result.command}\` passes on the base code too, with this change's tests` };
  const unknown = inconclusive(result, "on the base code");
  if (unknown) return { status: "unverified", detail: unknown };
  return { status: onlyLoadErrors(result) ? "weak" : "proven", detail: failureExcerpt(result.output, 1_500) || `exit code ${result.exitCode}` };
}

/** The tests couldn't load: a module, file or name they import isn't there, or doesn't build. */
const LOAD_ERROR =
  /ModuleNotFoundError|ImportError|No module named|errors? during collection|ERROR collecting|Cannot find module|ERR_MODULE_NOT_FOUND|Failed to (?:load url|resolve import)|does not provide an export named|is not exported by|error TS(?:2305|2307|2614|2724)\b|unresolved import|cannot find (?:function|struct|type|value|module|crate|macro)|\[build failed\]|^\S+\.go:\d+:\d+: undefined: /m;
/** A test that ran and failed on what it checks: an assertion, an expected value, a failed test by name. */
const TEST_FAILURE = /AssertionError|[Aa]ssert(?:ion)? failed|^\s*E\s+assert\b|\bexpect\(|^\s*(?:Expected|Received)\b|\bexpected .+ to\b|^--- FAIL: |^FAILED \S+::|panicked at .*assert/;

/**
 * Whether a failing run failed only because its tests couldn't load (see LOAD_ERROR), with no
 * test failing on what it checks. The source lines a runner quotes around an error (`> 3 | …`)
 * aren't failures, so they're left out.
 */
export function onlyLoadErrors(result: CheckResult): boolean {
  if (result.ok || !LOAD_ERROR.test(result.output)) return false;
  const quoted = /^\s*>?\s*\d+\s*\|/;
  return !result.output.split("\n").some((line) => !quoted.test(line) && TEST_FAILURE.test(line));
}

/**
 * What a run of a reviewer's repro (a test that should fail because of the bug it reports) says
 * about the result: failing there confirms the bug, passing refutes it. A run that never got as
 * far as the tests says neither.
 */
export function reproOutcome(result: CheckResult): { status: "confirmed" | "refuted" | "unverified"; detail: string } {
  if (result.ok) return { status: "refuted", detail: `\`${result.command}\` passes with the reviewer's test` };
  const unknown = inconclusive(result, "on the result");
  if (unknown) return { status: "unverified", detail: unknown };
  return { status: "confirmed", detail: failureExcerpt(result.output, 1_500) || `exit code ${result.exitCode}` };
}

/** Why a failing run didn't get as far as the tests (no test runner, nothing collected, a timeout); else undefined. */
function inconclusive(result: CheckResult, where: string): string | undefined {
  if (result.timedOut) return `\`${result.command}\` timed out ${where}`;
  const missing = runnerMissing(result);
  if (missing) return `the test runner didn't start ${where}: ${missing}`;
  if (/^(code-flow couldn't run it|Cancelled before it started)/.test(result.output)) return result.output.split("\n")[0]!;
  if (result.exitCode === 5 && /\bpytest\b/.test(result.command)) return `pytest collected no tests ${where}`;
  return undefined;
}

/** A command's time limit as people read it: "45 s", "5 min", "4.5 min". */
export function formatTimeout(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 6_000) / 10} min`;
}

/** What to tell you when the check can't run; the fix is setting it up for this repo. */
export function cantRunMessage(reason: string): string {
  return `The check can't run here: ${reason}. Set \`setup\` and \`check\` in .codeflow/config.json`;
}
