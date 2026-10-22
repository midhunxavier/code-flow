#!/usr/bin/env node
import "../scripts/check-node.mjs";
import { launch } from "./launcher.mjs";

launch().catch((error) => {
  console.error(`Code Flow: ${error.message}`);
  process.exitCode = 1;
});
