#!/usr/bin/env node
import { loadWorkerConfig, ProvisionedWorker } from "../src/remote-workers/worker.js";
import { serveWorker } from "../src/remote-workers/stdio.js";

const args = process.argv.slice(2);
const path = args[0] === "--config" && args.length === 2 ? args[1] : args.length === 0 ? process.env.CODEFLOW_WORKER_CONFIG_FILE : undefined;
if (!path) throw new Error("Configure a provisioned worker with --config /absolute/worker.json or CODEFLOW_WORKER_CONFIG_FILE");
await serveWorker(new ProvisionedWorker(await loadWorkerConfig(path)));
