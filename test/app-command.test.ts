import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCommand } from "../src/app-command.js";

test("preview discovers common package scripts, allocated ports and explicit worktree configuration", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cf-app-command-"));
  try {
    assert.equal(await appCommand(folder), undefined);
    await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.equal(await appCommand(folder), undefined, "a test command is not a web preview");
    await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "node server.js" } }));
    assert.equal((await appCommand(folder))?.command, 'npm run dev -- --port "$PORT"');
    await writeFile(join(folder, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { dev: "next dev" } }));
    assert.equal((await appCommand(folder))?.command, 'pnpm run dev --port "$PORT"');
    await writeFile(join(folder, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    assert.equal((await appCommand(folder))?.command, "npm run start");
    await mkdir(join(folder, ".codeflow"));
    await writeFile(join(folder, ".codeflow/config.json"), JSON.stringify({ run: { command: "node newly-configured.js", port: 8080 } }));
    assert.deepEqual(await appCommand(folder, { command: "node old.js" }), { command: "node newly-configured.js", port: 8080 });
    await writeFile(join(folder, ".codeflow/config.json"), "{");
    await assert.rejects(appCommand(folder), /config.json/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
