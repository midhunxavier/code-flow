import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
/** Private build output and runtime inputs for final parallel browser replays. */
export function copyFinalQaApp(source: string, target: string) {
  mkdirSync(target, { recursive: true });
  for (const folder of ["src", "ui", "scripts", "training", "docs", "public", "test/fake-bin"]) if (existsSync(join(source, folder))) cpSync(join(source, folder), join(target, folder), { recursive: true });
  for (const file of readdirSync(join(source, "test")).filter(name => name.startsWith("fake-") && name.endsWith(".mjs"))) cpSync(join(source, "test", file), join(target, "test", file));
  mkdirSync(join(target, "integrations/vscode"), { recursive: true });
  for (const file of ["integrations/vscode/README.md", "tsconfig.json", "package.json"]) cpSync(join(source, file), join(target, file));
  symlinkSync(join(source, "node_modules"), join(target, "node_modules"), "dir");
}
