import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { killGroup, trackGroup, untrackGroup } from "./adapters/process.js";

/**
 * The "done when" check: a command code-flow runs itself (never an agent) in a worktree,
 * so loops end on evidence — tests passing — rather than on an agent saying it is done.
 */

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout/stderr, trimmed to the end (where failures usually are). */
  output: string;
  /** Tests that ran (passed + failed), when the runner's summary says. */
  tests?: number;
}

const KEEP_OUTPUT = 20_000;

/** Best guess at the repo's test command; the user can always edit it. */
export async function detectCheckCommand(repo: string): Promise<{ command: string; source: string } | null> {
  const has = (file: string) => existsSync(join(repo, file));

  if (has("package.json")) {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8").catch(() => "{}"));
    const test: unknown = pkg?.scripts?.test;
    if (typeof test === "string" && test.trim() && !/no test specified/.test(test)) {
      const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun run" : "npm";
      return { command: `${runner} test`, source: "package.json" };
    }
  }
  if (has("Cargo.toml")) return { command: "cargo test", source: "Cargo.toml" };
  if (has("go.mod")) return { command: "go test ./...", source: "go.mod" };
  if (has("pytest.ini") || has("conftest.py") || has("tox.ini")) return { command: "python3 -m pytest -q", source: "pytest config" };
  if (has("pyproject.toml")) {
    const pyproject = await readFile(join(repo, "pyproject.toml"), "utf8").catch(() => "");
    if (/pytest/.test(pyproject) || has("tests")) return { command: "python3 -m pytest -q", source: "pyproject.toml" };
  }
  if (has("Makefile")) {
    const makefile = await readFile(join(repo, "Makefile"), "utf8").catch(() => "");
    if (/^test\s*:/m.test(makefile)) return { command: "make test", source: "Makefile" };
  }
  return null;
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
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
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
    }, opts.timeoutMs);
    const onAbort = () => stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackGroup(child.pid);
      opts.signal?.removeEventListener("abort", onAbort);
      const trimmed = output.length > KEEP_OUTPUT ? `…\n${output.slice(-KEEP_OUTPUT)}` : output;
      resolve({
        command,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output: timedOut ? `${trimmed}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]` : trimmed,
        tests: countTests(output),
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
 * How many tests ran, read from the runner's summary (node --test, Jest, Vitest, Mocha, pytest,
 * cargo, Go). Skipped tests don't count: a drop between two runs means tests were removed or
 * skipped. Undefined when the output has no summary code-flow recognizes.
 */
export function countTests(output: string): number | undefined {
  const tail = output.slice(-20_000);
  const last = (re: RegExp) => {
    const all = [...tail.matchAll(re)];
    return all.length ? all[all.length - 1]! : undefined;
  };
  const n = (s: string | undefined) => (s ? Number(s) : 0);
  // node --test: "# pass 12" / "# fail 1" (TAP) or "ℹ pass 12" / "ℹ fail 1" (spec reporter)
  const nodePass = last(/^(?:#|ℹ) pass (\d+)/gm);
  if (nodePass) return n(nodePass[1]) + n(last(/^(?:#|ℹ) fail (\d+)/gm)?.[1]);
  // Jest: "Tests:       1 failed, 2 skipped, 10 passed, 13 total"
  const jest = last(/^Tests:\s+(.*\d+ total)/gm);
  if (jest) return n(jest[1]!.match(/(\d+) passed/)?.[1]) + n(jest[1]!.match(/(\d+) failed/)?.[1]);
  // Vitest: "Tests  2 failed | 10 passed (12)"
  const vitest = last(/^\s*Tests\s+(.*\(\d+\))/gm);
  if (vitest) return n(vitest[1]!.match(/(\d+) passed/)?.[1]) + n(vitest[1]!.match(/(\d+) failed/)?.[1]);
  // cargo: "test result: ok. 10 passed; 0 failed; 1 ignored" (one line per test binary)
  const cargo = [...tail.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return cargo.reduce((sum, m) => sum + n(m[1]) + n(m[2]), 0);
  // pytest: "===== 2 failed, 10 passed, 1 skipped in 0.12s ====="
  const pytest = last(/^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s/gm);
  if (pytest) return n(pytest[1]!.match(/(\d+) passed/)?.[1]) + n(pytest[1]!.match(/(\d+) failed/)?.[1]);
  // Mocha: "  10 passing" / "  2 failing"
  const mocha = last(/^\s+(\d+) passing/gm);
  if (mocha) return n(mocha[1]) + n(last(/^\s+(\d+) failing/gm)?.[1]);
  // go test -v: one line per test
  const go = tail.match(/^--- (?:PASS|FAIL): /gm);
  if (go) return go.length;
  return undefined;
}

const TEST_RUNNER =
  /^(npm (run )?test|npm run test:[\w:-]+|pnpm (run )?test|yarn (run )?test|bun (run )?test|npx (jest|vitest|mocha|ava|playwright test)|node --test|deno test|python3? -m (pytest|unittest)|pytest|cargo test|go test|make test|mvn test|gradle test|\.\/gradlew test|dotnet test|bundle exec rspec|rspec|mix test|swift test)(\s|$)/;

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
