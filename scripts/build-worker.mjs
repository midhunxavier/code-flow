import "./check-node.mjs";
import { build } from "esbuild";
await build({ entryPoints: ["scripts/remote-worker.ts"], outfile: process.argv[2] ?? "dist/remote-worker.mjs", bundle: true, platform: "node", format: "esm", target: "node22.13", logLevel: "warning" });
