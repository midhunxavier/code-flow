#!/usr/bin/env node
// Stand-in for `docker` in tests: records the arguments, then runs the command on the host in
// the container's working directory, so checks behave as they would inside the container.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args[0] === "rm") process.exit(0);
if (args[0] !== "run") {
  process.stderr.write(`fake docker: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
if (process.env.FAKE_RECORD_DIR) writeFileSync(`${process.env.FAKE_RECORD_DIR}/docker-${Date.now()}-${randomUUID().slice(0, 6)}.json`, JSON.stringify({ vendor: "docker", args }));
const cwd = args[args.indexOf("-w") + 1];
const command = args[args.length - 1];
const result = spawnSync("/bin/sh", ["-c", command], { cwd, stdio: "inherit", env: { PATH: process.env.PATH, CI: "1", IN_FAKE_CONTAINER: "1" } });
process.exit(result.status ?? 1);
