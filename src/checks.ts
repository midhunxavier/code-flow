import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** Run a shell command in `cwd` with a timeout; the whole process group is killed on timeout/abort. */
export function runCheck(cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CheckResult> {
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  // Inherited from whatever runs code-flow; a nested `node --test` would silently skip every
  // test and exit 0 — a false pass.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true, // own process group, so test runners' children die with it
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > KEEP_OUTPUT * 2) output = output.slice(-KEEP_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = () => killGroup();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const trimmed = output.length > KEEP_OUTPUT ? `…\n${output.slice(-KEEP_OUTPUT)}` : output;
      resolve({
        command,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output: timedOut ? `${trimmed}\n[timed out after ${Math.round(opts.timeoutMs / 1000)}s]` : trimmed,
      });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
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

/** Comparable fingerprint of a failure, ignoring timings and other noise, to detect "no progress". */
export function failureFingerprint(result: CheckResult): string {
  return result.output
    .slice(-4_000)
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
