// Fixed SSH lifecycle operation. The only removable directory is this account's
// dedicated team-server installation; repository paths are never followed.
import { readFile, lstat, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function removeTeamServer(options = {}) {
  const home = options.home ?? homedir();
  const root = join(home, ".codeflow", "team-server");
  const exists = async path => lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  for (const path of [join(home, ".codeflow"), root]) {
    const stat = await exists(path);
    if (stat?.isSymbolicLink()) throw new Error("Team server storage is a symbolic link. Remove it manually after checking its target.");
  }
  const unitPath = join(home, ".config/systemd/user/codeflow-team-server.service");
  const unit = await exists(unitPath);
  if (!await exists(root)) {
    if (unit) throw new Error("The startup service exists without team storage. Check it manually before deleting the installation.");
    return { removed: true };
  }
  if (unit && (unit.isSymbolicLink() || !(await readFile(unitPath, "utf8")).startsWith("# Managed by Code Flow team server setup\n"))) throw new Error("The startup service is not managed by Code Flow. No team data was deleted.");
  // Share bootstrap's atomic lock so setup cannot launch a backend during deletion.
  const bootId = process.platform === "linux" ? await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(value => value.trim()).catch(() => undefined) : undefined;
  const lock = join(root, bootId ? `bootstrap.${bootId}.lock` : "bootstrap.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Team server setup or deletion is already running. Wait, then retry.");
    throw error;
  }
  try {
    const runtime = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
    if (runtime?.protocol !== 1 || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535
      || !Number.isInteger(runtime.pid) || runtime.pid <= 0 || !/^[a-f0-9]{64}$/.test(runtime.token ?? "")
      || !/^[a-f0-9]{32}$/.test(runtime.instance ?? "")) throw new Error("Cannot verify the team server process. No team data was deleted.");
    const request = options.request ?? fetch;
    const get = (path, method = "GET") => request(`http://127.0.0.1:${runtime.port}${path}`, {
      method, headers: { authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(5000), redirect: "error",
    });
    let identity;
    try { const response = await get("/api/team-host-runtime"); if (response.ok) identity = await response.json(); } catch { /* A stopped installation can be removed once its PID is gone. */ }
    if (identity) {
      if (identity.instance !== runtime.instance) throw new Error("The server identity changed. No team data was deleted.");
      const stopped = await get("/api/team-host-runtime/stop", "POST");
      if (!stopped.ok) throw new Error("Finish running team work and close terminals before deleting the team server.");
    }
    const alive = options.alive ?? (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } });
    // Do not force-kill a process, including a recycled PID.
    for (let attempt = 0; alive(runtime.pid); attempt++) {
      if (attempt >= 50) throw new Error("The team server is still shutting down. Wait, then retry deletion. No team data was deleted.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (unit) {
      const execute = promisify(execFile);
      const run = options.run ?? (async args => {
        const uid = process.getuid?.();
        const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
        await execute("systemctl", ["--user", "--no-ask-password", ...args], { timeout: 10000, env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus` } });
      });
      await run(["disable", "--now", "codeflow-team-server.service"]);
      await rm(unitPath);
      await run(["daemon-reload"]);
    }
    await rm(root, { recursive: true });
  } finally { await rm(lock, { recursive: true, force: true }); }

  return { removed: true };
}
