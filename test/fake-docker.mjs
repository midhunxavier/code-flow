#!/usr/bin/env node
// Stand-in for `docker` in tests: records the arguments, then runs the command on the host in
// the container's working directory, so checks behave as they would inside the container.
// FAKE_DOCKER_DOWN=1: the CLI is there but its daemon isn't, as with Docker Desktop stopped;
// FAKE_DOCKER_DOWN=run: the daemon answered when the run started, then stopped.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const down = process.env.FAKE_DOCKER_DOWN;
const unreachable = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n";
if (args[0] === "rm") process.exit(0);
if (args[0] === "info" || args[0] === "version") {
  if (down === "1") { process.stderr.write(unreachable); process.exit(1); }
  process.stdout.write("27.0.0\n");
  process.exit(0);
}
if (args[0] === "run" && (down === "1" || down === "run")) { process.stderr.write(unreachable); process.exit(1); }
if (args[0] !== "run") {
  process.stderr.write(`fake docker: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
if (process.env.FAKE_RECORD_DIR) writeFileSync(`${process.env.FAKE_RECORD_DIR}/docker-${Date.now()}-${randomUUID().slice(0, 6)}.json`, JSON.stringify({ vendor: "docker", args }));
const cwd = args[args.indexOf("-w") + 1];
const command = args[args.length - 1];
const result = spawnSync("/bin/sh", ["-c", command], { cwd, stdio: "inherit", env: { PATH: process.env.PATH, CI: "1", IN_FAKE_CONTAINER: "1" } });
process.exit(result.status ?? 1);
