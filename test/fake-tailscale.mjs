#!/usr/bin/env node
// Read-only detector fixture. Normal test runs must never query the user's tailnet.
import fs from "node:fs";
if (process.argv.slice(2).join(" ") !== "status --json --peers=false" || process.env.TAILSCALE_BE_CLI !== "1") process.exit(2);
if (process.env.FAKE_TAILSCALE_STATUS) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_TAILSCALE_STATUS));
} else {
  process.stdout.write(JSON.stringify({ BackendState: "Stopped" }));
}
