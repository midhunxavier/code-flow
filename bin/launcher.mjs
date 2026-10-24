import { execFile, spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { homedir, release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
const usage = `Code Flow preview — your coding agents, one workspace.

Usage: codeflow [start] [--port NUMBER] [--no-open]
       codeflow client <command> [arguments]
       codeflow --version

Starts a local server and opens your browser. Keep this terminal open;
press Ctrl+C to stop. Settings and history live in ~/.codeflow.

  --port NUMBER  Use a different local port (default: PORT or 4317)
  --no-open      Print the sign-in link without opening a browser
  -h, --help     Show this help
  -v, --version  Show the installed version

Requires Node.js 22.13+, Git 2.38+, and a signed-in agent CLI.
Windows: run inside WSL2 with your repository and CLIs installed there.
Set CODEFLOW_HOME to use a separate data directory.
`;

export function parseOptions(args, env = process.env) {
  const options = { open: true, port: env.PORT || "4317" };
  const rest = args[0] === "start" ? args.slice(1) : [...args];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--no-open") options.open = false;
    else if (rest[i] === "--port") options.port = rest[++i];
    else throw new Error(`Unknown option: ${rest[i]}. Run codeflow --help.`);
  }
  if (!/^\d+$/.test(options.port ?? "") || Number(options.port) < 1 || Number(options.port) > 65534)
    throw new Error("Choose an integer port from 1 to 65534 with --port.");
  return { ...options, port: String(Number(options.port)) };
}

export function browserCommand(url, platform = process.platform, wsl = /microsoft/i.test(release())) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "localhost" || parsed.username || parsed.password)
    throw new Error("The browser link must be a local Code Flow HTTP URL.");
  if (platform === "darwin") return ["open", [url]];
  if (platform === "linux" && wsl) {
    // Encoded PowerShell avoids cmd.exe/shell interpretation of the owner link.
    const command = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]];
  }
  return ["xdg-open", [url]];
}

export async function openBrowser(url) {
  const [command, args] = browserCommand(url);
  await promisify(execFile)(command, args, { timeout: 10_000, windowsHide: true });
}

export async function launch(args = process.argv.slice(2)) {
  if (args.length === 1 && ["-h", "--help", "help"].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length === 1 && ["-v", "--version"].includes(args[0])) {
    console.log(JSON.parse(await readFile(new URL("package.json", root), "utf8")).version);
    return;
  }
  if (process.platform === "win32") throw new Error("This preview runs on macOS and Linux. On Windows, use WSL2 and install Node, Git and your agent CLIs inside WSL.");
  if (args[0] === "client") {
    const client = spawn(process.execPath, [fileURLToPath(new URL("scripts/codeflow.mjs", root)), ...args.slice(1)], { stdio: "inherit" });
    await supervise(client);
    return;
  }
  const options = parseOptions(args);
  const server = fileURLToPath(new URL("src/server.js", root));
  await access(server).catch(() => { throw new Error("The release files are missing. From a source checkout, run npm run package:npm, then node dist/npm/bin/codeflow.mjs."); });
  const child = spawn(process.execPath, [server], {
    cwd: homedir(),
    env: { ...process.env, ...(process.env.CODEFLOW_HOME ? { CODEFLOW_HOME: resolve(process.env.CODEFLOW_HOME) } : {}), PORT: options.port, CODEFLOW_LAUNCHER: "1" },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  let announced = false;
  child.on("message", (message) => {
    if (announced || message?.type !== "codeflow-ready" || typeof message.url !== "string") return;
    announced = true;
    if (process.env.CODEFLOW_DESKTOP === "1") console.log(`CODEFLOW_READY ${JSON.stringify({ url: message.url })}`);
    if (options.open) void openBrowser(message.url).catch(() => {
      console.error("Could not open a browser automatically. Open the sign-in link printed above.");
    });
  });
  console.log("Starting Code Flow preview… Press Ctrl+C to stop.");
  await supervise(child, process.env.CODEFLOW_DESKTOP === "1");
}

async function supervise(child, watchParent = false) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  const handlers = signals.map((signal) => {
    const handler = () => stop(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  const disconnected = () => stop("SIGTERM");
  process.once("disconnect", disconnected);
  const parentPid = process.ppid;
  const parentWatch = watchParent ? setInterval(() => {
    if (process.ppid !== parentPid) stop("SIGTERM");
  }, 1000).unref() : undefined;
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = code ?? (stopping ? 0 : signal === "SIGINT" ? 130 : 1);
        resolve();
      });
    });
  } finally {
    clearInterval(parentWatch);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off("disconnect", disconnected);
  }
}
