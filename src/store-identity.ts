import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";

export const OWNER_PROTOCOL_VERSION = 2;
export type StoreEnvironment = "native-macos" | "native-linux" | "native-windows" | `wsl:${string}` | `docker:${string}` | `remote:${string}`;
export interface StoreRecord {
  storeId: string;
  name: string;
  createdAt: string;
  environment: StoreEnvironment;
  /** The preferred browser port; owner lifecycle code can persist collision resolution here. */
  port: number;
}
export type OwnerStartedBy = "desktop" | "cli" | "start" | "service";
export type OwnerLifetime = "service" | "attached";
export interface OwnerIdentity {
  storeId: string;
  environment: StoreEnvironment;
  origin: string;
  protocol: number;
  startedBy: OwnerStartedBy;
  lifetime: OwnerLifetime;
}
export function detectStoreEnvironment(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; host?: string; kernel?: string; docker?: boolean } = {}): StoreEnvironment {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform, host = options.host ?? hostname();
  const explicit = env.CODEFLOW_STORE_ENVIRONMENT;
  if (explicit) {
    if (!/^(native-(macos|linux|windows)|(wsl|docker|remote):[^\s]+)$/.test(explicit)) throw new Error("Invalid CODEFLOW_STORE_ENVIRONMENT");
    return explicit as StoreEnvironment;
  }
  if (env.WSL_DISTRO_NAME || platform === "linux" && /microsoft/i.test(options.kernel ?? release())) return `wsl:${env.WSL_DISTRO_NAME || "unknown"}`;
  if (env.CODEFLOW_DESKTOP_DOCKER === "1" || env.container || (options.docker ?? existsSync("/.dockerenv"))) return `docker:${env.CODEFLOW_DOCKER_ID || host}`;
  if (env.CODEFLOW_SSH_HOST || env.SSH_CONNECTION) return `remote:${env.CODEFLOW_SSH_HOST || host}`;
  return platform === "darwin" ? "native-macos" : platform === "win32" ? "native-windows" : "native-linux";
}
export function separateStore(environment: string) { return /^(wsl|docker):/.test(environment); }

export async function readStore(home = CODEFLOW_HOME): Promise<StoreRecord | undefined> {
  let raw: string;
  try { raw = await readFile(join(home, "store.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const store = JSON.parse(raw) as StoreRecord;
  if (!store || typeof store.storeId !== "string" || !store.storeId || typeof store.name !== "string" || !store.name.trim() ||
    typeof store.createdAt !== "string" || !Number.isFinite(Date.parse(store.createdAt)) ||
    typeof store.environment !== "string" || !/^(native-(macos|linux|windows)|(wsl|docker|remote):[^\s]+)$/.test(store.environment) ||
    !Number.isInteger(store.port) || store.port < 1 || store.port > 65535) throw new Error(`Invalid store identity at ${join(home, "store.json")}`);
  return store;
}
/** Publish a complete record exclusively: concurrent launchers all read the winning identity. */
export async function ensureStore(home = CODEFLOW_HOME): Promise<StoreRecord> {
  const existing = await readStore(home); if (existing) return existing;
  await mkdir(home, { recursive: true });
  const environment = detectStoreEnvironment();
  const store: StoreRecord = { storeId: randomUUID(), name: `${hostname()} Code Flow`, createdAt: new Date().toISOString(), environment, port: 4317 };
  const file = join(home, "store.json"), temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try { await link(temp, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return (await readStore(home))!;
  } finally { await unlink(temp).catch(() => undefined); }
}
