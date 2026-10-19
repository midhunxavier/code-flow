#!/usr/bin/env node
// Detector and opt-in certificate fixture. Tests never query the user's tailnet.
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "cert" && process.env.FAKE_TAILSCALE_CERT && process.env.FAKE_TAILSCALE_KEY) {
  if (process.env.TAILSCALE_BE_CLI !== "1" || !args.includes("--min-validity=720h")) process.exit(2);
  const cert = args.find((arg) => arg.startsWith("--cert-file="))?.slice(12);
  const key = args.find((arg) => arg.startsWith("--key-file="))?.slice(11);
  if (!cert || !key) process.exit(2);
  fs.copyFileSync(process.env.FAKE_TAILSCALE_CERT, cert);
  fs.copyFileSync(process.env.FAKE_TAILSCALE_KEY, key);
  process.exit(0);
}
if (process.argv.slice(2).join(" ") !== "status --json --peers=false" || process.env.TAILSCALE_BE_CLI !== "1") process.exit(2);
if (process.env.FAKE_TAILSCALE_STATUS) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_TAILSCALE_STATUS));
} else {
  process.stdout.write(JSON.stringify({ BackendState: "Stopped" }));
}
