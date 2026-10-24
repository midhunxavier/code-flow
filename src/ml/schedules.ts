import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { nextFire } from "../automation.js";
import { canonical, hash } from "../training-worker/files.js";
import { cycleTerminal, type Cycle } from "./cycle-model.js";
import { id, integer, MlBusyError, MlError, object, string, terminal } from "./model.js";
import { cadence, type TrainingSchedule } from "./schedule-model.js";
import type { MlService } from "./service.js";
import type { MlState } from "./store.js";

export class MlSchedules {
  private flight?: Promise<void>;
  private operations = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private service: MlService, private now: () => number = Date.now) {}
  active() { return !!this.flight || this.operations.size > 0 || this.service.store.read().schedules.some(s => s.state === "enabled"); }
  private async track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new MlError("Training controller is closing", 409);
    const task = work(); this.operations.add(task);
    try { return await task; } finally { this.operations.delete(task); }
  }
  private get(value: string) { const s = this.service.store.read().schedules.find(s => s.id === value); if (!s) throw new MlError("Training schedule not found", 404); return s; }
  private pinned(schedule: TrainingSchedule, state = this.service.store.read()) {
    this.service.assertTarget(schedule.template.target, state);
    const target = state.targets.find(t => t.id === schedule.template.target.id);
    if (!target || canonical(target) !== canonical(schedule.template.target)) throw new MlError("Training computer changed; create a new schedule with reviewed settings", 409);
  }
  private busy(schedule: TrainingSchedule, state = this.service.store.read()) {
    if (this.service.deployments.busy(schedule.template.target.workerId)) return true;
    const { project, target } = schedule.template;
    return state.cycles.some(c => !cycleTerminal(c) && (c.template.project === project || c.template.target.workerId === target.workerId)) || state.experiments.some(e => !terminal(e.status.state) && (e.project === project || e.target.workerId === target.workerId));
  }
  async recover() {
    if (!this.service.store.read().schedules.some(s => s.pending || s.candidate)) return;
    await this.service.store.change(state => { for (const s of state.schedules) if (s.pending || s.candidate) {
      s.pending = undefined; s.candidate = undefined;
      if (s.state === "enabled") { s.nextAt = this.now(); s.lastOutcome = "Controller restarted; checking the latest data again"; }
    } });
  }
  async close() { this.closing = true; await Promise.allSettled([...this.operations, ...(this.flight ? [this.flight] : [])]); }
  create(raw: unknown) { return this.track(() => this.createPolicy(raw)); }
  private async createPolicy(raw: unknown) {
    const v = object(raw, ["search", "source", "cadence", "stabilitySeconds", "maxCycles"], "training schedule");
    const search = object(v.search, ["training", "objective", "planner", "limits"], "search");
    const operationId = id(search.training?.operationId), requestHash = hash(canonical(v));
    const existing = this.service.store.read().schedules.find(s => s.operationId === operationId);
    if (existing) { await this.service.authorize(existing.template.project, existing.template.repo); if (existing.requestHash !== requestHash) throw new MlError("Schedule operation inputs changed", 409); return existing; }
    const source = object(v.source, ["path", "location"], "dataset source");
    const path = string(source.path, "dataset path", 4096);
    if (!isAbsolute(path) || !["target", "controller"].includes(source.location)) throw new MlError("Choose an absolute dataset path and its computer");
    const calendar = cadence(v.cadence), stabilitySeconds = integer(v.stabilitySeconds, 60, 3600, "Stable data seconds"), maxCycles = integer(v.maxCycles, 1, 100, "Maximum scheduled runs");
    const prepared = await this.service.cycles.prepare(search), template = prepared.template;
    const capability = await this.service.probe(template.target.id);
    if (capability.dataWatch !== 1) throw new MlError("Update this training worker before scheduling data checks", 409);
    const observed = await this.service.fingerprint({ project: template.project, repo: template.repo, target: template.target.id, path, location: source.location });
    if (observed.hash !== template.intent.dataset!.hash || observed.format !== template.intent.dataset!.format) throw new MlError("The source differs from the prepared dataset; prepare the current file before scheduling", 409);
    const now = this.now();
    const schedule: TrainingSchedule = { id: randomUUID(), revision: 1, operationId, requestHash, name: template.name, template, datasetId: id(search.training.dataset), ...(search.training.model ? { modelId: id(search.training.model) } : {}), objective: prepared.objective, planner: prepared.planner, limits: prepared.limits, source: { path, location: source.location }, cadence: calendar, stabilitySeconds, maxCycles, createdAt: now, nextAt: nextFire(calendar, now), state: "enabled", runs: [], lastOutcome: "Waiting for new data; the prepared version is the starting point" };
    await this.service.authorize(template.project, template.repo);
    return this.service.store.change(state => {
      const same = state.schedules.find(s => s.operationId === operationId);
      if (same) { if (same.requestHash !== requestHash) throw new MlError("Schedule operation inputs changed", 409); return same; }
      if (this.closing || !this.service.enabled()) throw new MlError("Scheduled training is unavailable", 409);
      this.pinned(schedule, state);
      if (state.schedules.length >= 32) throw new MlError("At most 32 saved training schedules are supported", 409);
      if (state.schedules.some(s => s.state === "enabled" && s.template.project === template.project && s.template.target.id === template.target.id && canonical(s.source) === canonical(schedule.source))) throw new MlError("This source already has an enabled training schedule", 409);
      state.schedules.push(schedule); return schedule;
    });
  }
  update(value: string, action: "pause" | "resume" | "check", raw: unknown) { return this.track(async () => {
    const v = object(raw, action === "pause" ? ["revision", "stopActive"] : ["revision"]);
    integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "Schedule revision");
    if (v.stopActive !== undefined && typeof v.stopActive !== "boolean") throw new MlError("Invalid stop option");
    const before = this.get(value);
    // Pausing and cancellation remain available after feature disablement or membership revocation.
    if (action !== "pause") { if (!this.service.enabled()) throw new MlError("Scheduled training is disabled", 409); await this.service.authorize(before.template.project, before.template.repo); if (action === "resume" && this.service.monitors.usesSchedule(value)) throw new MlError("Pause its monitor and finish the active action before resuming this schedule", 409); this.pinned(before); }
    await this.service.store.change(state => {
      const s = state.schedules.find(s => s.id === value)!;
      if (s.revision !== v.revision) throw new MlError("Schedule changed; reload before saving", 409);
      if (action === "pause") { s.state = s.runs.length >= s.maxCycles ? "exhausted" : "paused"; s.reason = "Paused by user"; s.pending = undefined; s.candidate = undefined; }
      else {
        if (s.runs.length >= s.maxCycles) throw new MlError("Lifetime run limit reached; this schedule cannot resume", 409);
        if (action === "check" && s.state !== "enabled") throw new MlError("Resume the schedule before checking", 409);
        if (action === "resume") {
          if (this.service.monitors.usesSchedule(value)) throw new MlError("Pause its monitor and finish the active action before resuming this schedule", 409);
          if (s.state !== "paused") throw new MlError("Only a paused schedule can resume", 409);
          if (state.schedules.some(other => other.id !== s.id && other.state === "enabled" && other.template.project === s.template.project && other.template.target.id === s.template.target.id && canonical(other.source) === canonical(s.source))) throw new MlError("This source already has an enabled training schedule", 409);
          s.state = "enabled"; s.candidate = undefined; s.pending = undefined;
        }
        s.reason = undefined; s.nextAt = this.now();
      }
      // A check request must not invalidate a check already in progress.
      if (action !== "check") s.revision++;
    });
    if (action === "pause" && v.stopActive) for (const run of this.get(value).runs) {
      const cycle = this.service.store.read().cycles.find(c => c.id === run.cycleId)!;
      if (!cycleTerminal(cycle)) await this.service.cycles.stop(cycle.id);
    }
    return this.get(value);
  }); }
  /** Reuses the schedule ledger and original limits; no second budget or duplicate data version. */
  async triggerFromMonitor(value: string, revision: number, datasetId: string, occurrence: string, guard: (state: MlState) => void, admitted: (state: MlState, cycle: Cycle) => void) {
    const schedule = this.get(value), snapshot = this.service.store.read().datasets.find(d => d.id === datasetId);
    if (!snapshot || snapshot.project !== schedule.template.project || snapshot.repo !== schedule.template.repo || snapshot.target.workerId !== schedule.template.target.workerId) throw new MlError("Monitoring snapshot belongs to another training scope", 409);
    const training = { project: schedule.template.project, repo: schedule.template.repo, name: schedule.name, dataset: datasetId, operationId: occurrence, spec: schedule.template.intent.spec, ...(schedule.template.intent.recipe ? { recipe: schedule.template.intent.recipe, model: schedule.modelId } : {}) };
    return this.service.cycles.create({ training, objective: schedule.objective, planner: schedule.planner, limits: schedule.limits }, (state, cycle) => {
      guard(state); const s = state.schedules.find(p => p.id === value)!;
      if (this.closing || !this.service.enabled() || s.revision !== revision || s.state !== "paused" || s.runs.length >= s.maxCycles || s.runs.some(r => r.hash === snapshot.dataset.hash) || snapshot.dataset.hash === s.template.intent.dataset!.hash) throw new MlError("Monitoring training admission changed or data was already handled", 409);
      this.pinned(s, state); cycle.schedule = { id: s.id, occurrence };
      s.runs.push({ cycleId: cycle.id, occurrence, hash: snapshot.dataset.hash, at: this.now() }); s.lastOutcome = "Monitoring started a bounded search for changed data";
      if (s.runs.length === s.maxCycles) { s.state = "exhausted"; s.reason = "Lifetime run limit reached"; s.revision++; }
      admitted(state, cycle);
    });
  }
  async tick() {
    if (this.flight || this.closing) return this.flight;
    this.flight = (async () => {
      for (const s of this.service.store.read().schedules) if (!this.closing && s.state === "enabled" && s.nextAt <= this.now()) {
        try { await this.check(s); }
        catch (error) {
          await this.service.store.change(state => {
            const current = state.schedules.find(v => v.id === s.id)!;
            if (current.state !== "enabled" || current.revision !== s.revision) return;
            current.pending = undefined;
            if (error instanceof MlBusyError && this.service.enabled()) { current.nextAt = Math.min(nextFire(current.cadence, this.now()), this.now() + 60000); current.lastOutcome = "Waiting for active or unresolved work"; }
            else { current.state = "paused"; current.reason = (error as Error).message.slice(0, 2000); current.revision++; }
          });
        }
      }
    })();
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async check(schedule: TrainingSchedule) {
    if (!this.service.enabled()) throw new MlError("Scheduled training is disabled; resume after enabling it");
    await this.service.authorize(schedule.template.project, schedule.template.repo); this.pinned(schedule);
    const occurrence = randomUUID();
    const claimed = await this.service.store.change(state => {
      const s = state.schedules.find(s => s.id === schedule.id)!;
      if (this.closing || s.state !== "enabled" || s.revision !== schedule.revision || s.nextAt > this.now() || s.pending) return false;
      s.nextAt = nextFire(s.cadence, this.now());
      if (this.busy(s, state)) { s.nextAt = Math.min(s.nextAt, this.now() + 60000); s.lastOutcome = "Waiting for active or unresolved work"; return false; }
      s.pending = { id: occurrence, startedAt: this.now() }; return true;
    });
    if (!claimed) return;
    const current = () => { const s = this.get(schedule.id); return !this.closing && s.state === "enabled" && s.revision === schedule.revision && s.pending?.id === occurrence; };
    const source = { project: schedule.template.project, repo: schedule.template.repo, target: schedule.template.target.id, ...schedule.source };
    const observed = await this.service.fingerprint(source);
    if (!current()) return;
    let stable = false;
    await this.service.store.change(state => {
      const s = state.schedules.find(s => s.id === schedule.id)!;
      if (s.pending?.id !== occurrence) return;
      s.lastCheckedAt = this.now();
      if (observed.hash === s.template.intent.dataset!.hash || s.runs.some(run => run.hash === observed.hash)) {
        s.lastOutcome = "No unhandled data version"; s.candidate = undefined;
      } else if (s.candidate?.hash !== observed.hash) {
        s.candidate = { ...observed, firstSeenAt: this.now() }; s.lastOutcome = "New data found; waiting for a stable file";
      } else if (this.now() - s.candidate.firstSeenAt >= s.stabilitySeconds * 1000) stable = true;
      if (s.candidate && !stable) s.nextAt = Math.min(s.nextAt, s.candidate.firstSeenAt + s.stabilitySeconds * 1000);
      if (!stable) s.pending = undefined;
    });
    if (!stable || !current()) return;
    const snapshot = await this.service.snapshot(source);
    if (!current()) return;
    if (snapshot.dataset.hash !== observed.hash) {
      await this.service.store.change(state => { const s = state.schedules.find(s => s.id === schedule.id)!; if (s.pending?.id !== occurrence) return; s.pending = undefined; s.candidate = undefined; s.lastOutcome = "Data changed during preparation; checking again before training"; s.nextAt = this.now() + s.stabilitySeconds * 1000; }); return;
    }
    const original = schedule.template.intent.dataset!, fresh = snapshot.dataset;
    if (original.format !== fresh.format || original.schema !== fresh.schema || canonical([...original.columns].sort()) !== canonical([...fresh.columns].sort())) throw new MlError("Dataset columns or format changed; review and create a new schedule");
    const training = { project: schedule.template.project, repo: schedule.template.repo, name: schedule.name, dataset: snapshot.id, operationId: occurrence, spec: schedule.template.intent.spec, ...(schedule.template.intent.recipe ? { recipe: schedule.template.intent.recipe, model: schedule.modelId } : {}) };
    await this.service.cycles.create({ training, objective: schedule.objective, planner: schedule.planner, limits: schedule.limits }, (state: MlState, cycle: Cycle) => {
      const s = state.schedules.find(s => s.id === schedule.id)!;
      if (this.closing || !this.service.enabled() || s.state !== "enabled" || s.revision !== schedule.revision || s.pending?.id !== occurrence || s.runs.length >= s.maxCycles || s.runs.some(r => r.hash === observed.hash)) throw new MlError("Schedule admission changed", 409);
      this.pinned(s, state);
      // This ledger and the bounded search become durable in the same write.
      cycle.schedule = { id: s.id, occurrence };
      s.runs.push({ cycleId: cycle.id, occurrence, hash: observed.hash, at: this.now() });
      s.pending = undefined; s.candidate = undefined; s.nextAt = nextFire(s.cadence, this.now()); s.lastOutcome = "Started a bounded search for new data";
      if (s.runs.length === s.maxCycles) { s.state = "exhausted"; s.reason = "Lifetime run limit reached"; s.revision++; }
    });
  }
}
