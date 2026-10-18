import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { validSshHost } from "./transport.js";

/** Discover concrete aliases only. OpenSSH remains the authority for actual config resolution. */
export async function sshAliases(file = join(homedir(), ".ssh/config")): Promise<string[]> {
  const aliases = new Set<string>(), visited = new Set<string>();
  async function expand(pattern: string): Promise<string[]> {
    let paths = [isAbsolute(pattern) ? sep : dirname(file)];
    for (const part of pattern.split(sep).filter(Boolean)) {
      if (!/[?*]/.test(part)) { paths = paths.map((path) => join(path, part)); continue; }
      const match = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
      const matches = await Promise.all(paths.map(async (path) => (await readdir(path).catch(() => [])).filter((name) => match.test(name)).map((name) => join(path, name))));
      paths = matches.flat().slice(0, 128);
    }
    return paths;
  }
  async function visit(path: string, depth = 0): Promise<void> {
    path = resolve(path); if (depth > 8 || visited.size >= 128 || visited.has(path)) return; visited.add(path);
    const text = await readFile(path, "utf8").catch(() => ""); if (text.length > 1024 * 1024) return;
    for (const line of text.split(/\r?\n/)) {
      const words = line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s=]+/g)?.map((word) => word.replace(/^['"]|['"]$/g, ""));
      if (!words) continue;
      const key = words.shift()!.toLowerCase();
      if (key === "host") for (const name of words) { if (name.startsWith("#")) break; if (validSshHost(name)) aliases.add(name); }
      if (key === "include") for (const pattern of words) { if (pattern.startsWith("#")) break; for (const included of await expand(pattern.replace(/^~(?=\/)/, homedir()))) await visit(included, depth + 1); }
    }
  }
  await visit(file); return [...aliases].sort();
}
