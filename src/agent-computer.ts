import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionNotPerformed } from "./agent-action-error.js";
import { CODEFLOW_HOME } from "./config.js";

let compiling: Promise<string> | undefined;
function run(file: string, args: string[], input?: unknown, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { signal, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { let message = stderr.trim() || error.message; try { message = JSON.parse(stdout).error || message; } catch {} reject(new Error(message)); }
      else resolve(stdout);
    });
    child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function helper(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Native computer tools currently support macOS. Use browser tools or a configured computer-use MCP server on this platform.");
  if (!compiling) compiling = (async () => {
    const packaged = fileURLToPath(new URL("../scripts/computer-use", import.meta.url));
    if (await stat(packaged).then(info => info.isFile() && !!(info.mode & 0o111), () => false)) return packaged;
    const source = fileURLToPath(new URL("../scripts/computer-use.swift", import.meta.url));
    const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 16);
    const dir = join(CODEFLOW_HOME, "helpers"), binary = join(dir, `computer-${hash}`);
    if (await stat(binary).then(() => true, () => false)) return binary;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${binary}-${randomBytes(4).toString("hex")}`;
    try { await run("/usr/bin/swiftc", [source, "-o", temporary]); await rename(temporary, binary); }
    catch (error) { await rm(temporary, { force: true }); throw new Error(`Computer helper is unavailable: ${(error as Error).message}`); }
    return binary;
  })().catch(error => { compiling = undefined; throw error; });
  return compiling;
}
/** Whole-computer input is serialized globally. A fresh screenshot must ground every action. */
export class AgentComputer {
  private screenshot?: { id: string; at: number; width: number; height: number; pointWidth: number; pointHeight: number; app: string; generation: number };
  private static generation = 0;
  private static queue: Promise<unknown> = Promise.resolve();
  constructor(private execute = async (input: unknown, signal: AbortSignal) => JSON.parse(await run(await helper(), [], input, signal))) {}
  call(name: string, args: Record<string, any>, signal: AbortSignal): Promise<any> {
    const work = AgentComputer.queue.catch(() => {}).then(async () => {
      if (signal.aborted) throw new Error("This computer turn has ended");
      if (name === "computer_screenshot") {
        const result = await this.execute({ action: "screenshot", ...(args.app ? { expectedApp: args.app } : {}) }, signal);
        const id = randomBytes(12).toString("hex");
        this.screenshot = { id, at: Date.now(), width: result.width, height: result.height, pointWidth: result.pointWidth, pointHeight: result.pointHeight, app: result.app, generation: AgentComputer.generation };
        return { content: [{ type: "text", text: JSON.stringify({ screenshot: id, width: result.width, height: result.height, app: result.app, note: "Coordinates default to these screenshot pixels. Set coordinateSpace=normalized explicitly for 0–1000 coordinates. Capture again after every action." }) }, { type: "image", mimeType: "image/png", data: result.data }] };
      }
      if (name !== "computer_action") throw new Error("Unknown computer tool");
      const seen = this.screenshot;
      if (!seen || args.screenshot !== seen.id || Date.now() - seen.at > 60_000 || seen.generation !== AgentComputer.generation) throw new ActionNotPerformed("Take a fresh computer_screenshot before acting");
      const request = { ...args }; delete request.screenshot; delete request.coordinateSpace;
      if (args.action === "click") {
        const width = args.coordinateSpace === "normalized" ? 1000 : seen.width, height = args.coordinateSpace === "normalized" ? 1000 : seen.height;
        if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0 || args.x >= width || args.y >= height) throw new ActionNotPerformed("Coordinates are outside the screenshot");
        request.x = args.x * seen.pointWidth / width; request.y = args.y * seen.pointHeight / height;
      }
      this.screenshot = undefined; AgentComputer.generation++;
      request.expectedApp = seen.app;
      return this.execute(request, signal);
    });
    AgentComputer.queue = work; return work;
  }
}
