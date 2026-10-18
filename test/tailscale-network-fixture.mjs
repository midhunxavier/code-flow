// Test-only network adapter: no OS aliases, tailnet changes or production bind overrides.
// A real HTTP listener and browser proxy stand in for the encrypted Tailscale transport.
import { Server } from "node:net";
import { appendFileSync } from "node:fs";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (args[1] === "100.101.102.103" || args[1] === "100.101.102.104") {
    if (process.env.FAKE_TAILSCALE_BIND_LOG) appendFileSync(process.env.FAKE_TAILSCALE_BIND_LOG, `${args[1]}\n`);
    args[1] = "127.0.0.1";
  }
  return listen.apply(this, args);
};
