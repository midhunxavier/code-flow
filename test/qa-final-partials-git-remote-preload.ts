// Explicit test-only preload: retain real server/service/Git paths while faulting the
// launch acknowledgement boundary. No production environment switch is installed.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunManager } from "../src/engine.js";
const directory = process.env.QA_FINAL_GATE!;
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
  if (input.coordination && input.task.includes("QA_LATE_RECEIPT")) {
    writeFileSync(join(directory, "late-run"), run.id);
    while (!existsSync(join(directory, "release-late"))) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (input.coordination && input.task.includes("QA_UNKNOWN_RECEIPT")) {
    writeFileSync(join(directory, "unknown-run"), run.id);
    throw new Error("QA dropped launch acknowledgement after durable registration");
  }
  return run;
};
const list = RunManager.prototype.list;
RunManager.prototype.list = function (...args) {
  return list.apply(this, args).filter(run => !run.task.includes("QA_UNKNOWN_RECEIPT") || existsSync(join(directory, "discover-unknown")));
};
