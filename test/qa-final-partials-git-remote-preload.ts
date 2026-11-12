// Explicit test-only preload: retain real server/service/Git paths while faulting the
// launch acknowledgement boundary. No production environment switch is installed.
import { RunManager } from "../src/engine.js";
const start = RunManager.prototype.start;
RunManager.prototype.start = async function (input) {
  const run = await start.call(this, input);
  // Legacy native source receipt for the explicit local-validation confirmation UI.
  // New source imports use containment or an earlier explicit host authorization.
  if (input.task === "QA_LEGACY_SOURCE_VALIDATION") {
    while (run.status === "running") await new Promise(resolve => setTimeout(resolve, 20));
    run.lockdown = "QA legacy untrusted source fixture";
    run.lockdownOnHost = false;
    delete run.loop.container;
  }
  return run;
};
