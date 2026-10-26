import { randomUUID } from "node:crypto";
import { canonical, hash } from "../training-worker/files.js";
import { id, intent, MlBusyError, MlError, object, string, terminal, type Experiment } from "./model.js";
import { cycleTerminal, cycleLimitReason, gain, plannerConfig, proposal, searchLimits, type Cycle } from "./cycle-model.js";
import { planExperiment, type SearchPlanner } from "./planner.js";
import type { MlState } from "./store.js";
import type { MlService } from "./service.js";

export class MlCycles {
  private flight?: Promise<void>;
  private closing = false;
  private planners = new Map<string, AbortController>();
  constructor(private service: MlService, private planner: SearchPlanner = planExperiment) {}
  private get(id: string) { const c = this.service.store.read().cycles.find(c => c.id === id); if (!c) throw new MlError("Search not found", 404); return c; }
  async recover() {
    if (!this.service.store.read().cycles.some(c => c.trials.some(t => t.state === "planning"))) return;
    await this.service.store.change(s => { for (const c of s.cycles) for (const t of c.trials) if (t.state === "planning") { t.state = "rejected"; t.reason = "Planner interrupted by controller restart; this iteration remains consumed"; if (!cycleTerminal(c) && c.state !== "stopping") { c.state = "paused"; c.reason = t.reason; } } });
  }
  async prepare(raw: unknown) {
    const v = object(raw, ["training", "objective", "planner", "limits"], "automatic search");
    const training = object(v.training, ["project", "repo", "name", "dataset", "spec", "operationId", "recipe", "model"]);
    const operationId = id(training.operationId), requestHash = hash(canonical(v));
    const limits = searchLimits(v.limits), planner = plannerConfig(v.planner), objective = string(v.objective, "search objective", 2000);
    const template = await this.service.startJob(training, false, true);
    if (limits.trainSeconds < template.intent.spec!.trainSeconds) throw new MlError("Total training budget must cover at least one trial");
    const now = Date.now();
    const cycle: Cycle = { id: randomUUID(), operationId, requestHash, name: template.name, objective, template, planner, limits, createdAt: now, expiresAt: now + limits.elapsedSeconds * 1000, state: "running", trials: [], reservedTrainSeconds: 0 };
    if (this.trialDeadline(cycle) < now + (template.intent.spec!.trainSeconds + 1) * 1000) throw new MlError("Elapsed budget must leave time for training and final evaluation");
    return cycle;
  }
  async create(raw: unknown, admit?: (state: MlState, cycle: Cycle) => void) {
    const v = object(raw, ["training", "objective", "planner", "limits"], "automatic search");
    const operationId = id(v.training?.operationId), requestHash = hash(canonical(v));
    const existing = this.service.store.read().cycles.find(c => c.operationId === operationId);
    if (existing) { await this.service.authorize(existing.template.project, existing.template.repo); if (existing.requestHash !== requestHash) throw new MlError("Search operation inputs changed", 409); return existing; }
    const cycle = await this.prepare(raw), { template, limits } = cycle;
    const result = await this.service.store.change(s => {
      const same = s.cycles.find(c => c.operationId === operationId);
      if (same) { if (same.requestHash !== requestHash) throw new MlError("Search operation inputs changed", 409); return same; }
      if (s.cycles.length >= 100 || s.experiments.length + limits.iterations + 1 > 200) throw new MlError("ML history has insufficient room for this search", 409);
      this.service.assertTarget(template.target, s);
      if (s.cycles.some(c => !cycleTerminal(c) && (c.template.project === template.project || c.template.target.workerId === template.target.workerId)) || s.experiments.some(e => !terminal(e.status.state) && (e.project === template.project || e.target.workerId === template.target.workerId))) throw new MlBusyError("This project or computer already has active or unresolved work");
      admit?.(s, cycle); s.cycles.push(cycle); return cycle;
    });
    void this.tick().catch(() => {}); return result;
  }
  async stop(value: string) {
    const c = this.get(value); if (cycleTerminal(c)) return c;
    await this.service.store.change(s => { const c = s.cycles.find(c => c.id === value)!; if (!cycleTerminal(c)) { c.state = "stopping"; c.reason = "Stopped by user"; } });
    this.planners.get(value)?.abort();
    for (const e of this.jobs(value)) if (!terminal(e.status.state)) await this.service.cancel(e.id);
    void this.tick().catch(() => {}); return this.get(value);
  }
  async resume(value: string) {
    const c = this.get(value); await this.service.authorize(c.template.project, c.template.repo);
    if (!this.service.enabled()) throw new MlError("Automatic training is disabled", 409);
    if (c.state !== "paused" || Date.now() >= c.expiresAt || c.finalJobId) throw new MlError("Only a paused search within its original deadline can resume", 409);
    if (this.jobs(value).some(e => !terminal(e.status.state))) throw new MlError("Reconcile the outstanding job before resuming", 409);
    await this.service.store.change(s => { const current = s.cycles.find(c => c.id === value)!; if (current.state !== "paused") throw new MlError("Search state changed", 409); current.state = "running"; current.reason = undefined; });
    void this.tick().catch(() => {}); return this.get(value);
  }
  private jobs(value: string) { return this.service.store.read().experiments.filter(e => e.intent.search?.cycleId === value); }
  private trialDeadline(c: Cycle) {
    const finalSeconds = Math.min(c.template.intent.recipe ? 1800 : 600, Math.ceil(c.limits.elapsedSeconds / 3));
    return Math.min(c.expiresAt - finalSeconds * 1000, Date.now() + (c.template.intent.spec!.trainSeconds + (c.template.intent.recipe ? 1800 : 600)) * 1000);
  }
  async close() { this.closing = true; for (const controller of this.planners.values()) controller.abort(); await this.flight; }
  async tick() {
    if (this.flight || this.closing) return this.flight;
    this.flight = (async () => {
      for (const c of this.service.store.read().cycles) if (!cycleTerminal(c) && !this.closing) {
        try { await this.advance(c.id); }
        catch (error) { await this.service.store.change(s => { const current = s.cycles.find(v => v.id === c.id)!; if (current.state === "running") { current.state = "paused"; current.reason = (error as Error).message.slice(0, 2000); } }); }
      }
    })();
    try { await this.flight; } finally { this.flight = undefined; }
  }
  private async advance(value: string) {
    let c = this.get(value);
    if (Date.now() >= c.expiresAt && c.state !== "stopping") {
      await this.service.store.change(s => { const c = s.cycles.find(v => v.id === value)!; c.state = "stopping"; c.reason = "Total elapsed time limit reached"; }); c = this.get(value);
    }
    if (c.state === "stopping") {
      for (const e of this.jobs(value)) if (!terminal(e.status.state)) await this.service.cancel(e.id);
      if (!this.jobs(value).some(e => !terminal(e.status.state)) && !this.planners.has(value)) await this.service.store.change(s => { const c = s.cycles.find(v => v.id === value)!; for (const t of c.trials) if (t.jobId) t.state = "done"; c.state = "stopped"; });
      return;
    }
    if (c.state === "paused") return;
    if (!this.service.enabled()) throw new MlError("Training disabled; search paused with its original deadline and limits");
    await this.service.authorize(c.template.project, c.template.repo);
    if (c.finalJobId) {
      const final = this.jobs(value).find(e => e.id === c.finalJobId)!;
      if (!terminal(final.status.state)) return;
      await this.service.store.change(s => { const c = s.cycles.find(v => v.id === value)!; if (c.state !== "running") return; c.state = "completed"; c.reason = final.status.state === "succeeded" ? (gain(final.status.evaluation!.candidate, final.status.evaluation!.baseline, final.status.evaluation!.direction) > c.limits.minImprovement ? "Selected model passed the final baseline comparison; export ready for review" : "Final test did not beat the baseline by the required margin; keep the baseline") : "Final test failed; no model recommended and no automatic retry"; }); return;
    }
    const last = c.trials.at(-1);
    if (last?.state === "running") {
      const job = this.jobs(value).find(e => e.id === last.jobId)!;
      if (job.status.state === "unknown") throw new MlError("Worker outcome unknown; reconcile before resuming. Its budget remains reserved.");
      if (!terminal(job.status.state)) return;
      const e = job.status.evaluation;
      if (job.status.state === "succeeded" && e) {
        const reference = this.jobs(value).find(j => j.id !== job.id && j.intent.search?.partition === "validation" && j.status.state === "succeeded")?.status.evaluation;
        if (e.partition !== "validation" || reference && (reference.splitHash !== e.splitHash || reference.metric !== e.metric || reference.direction !== e.direction || Math.abs(reference.baseline - e.baseline) > 0.000001 || reference.evaluatedTokens !== e.evaluatedTokens)) throw new MlError("Validation evidence is not comparable; search paused");
      }
      await this.service.store.change(s => {
        const c = s.cycles.find(v => v.id === value)!, t = c.trials.at(-1)!;
        t.state = "done";
        if (job.status.state !== "succeeded") t.reason = `Trial ${job.status.state}; reservation retained`;
        else if (e) {
          const best = s.experiments.find(j => j.id === c.bestJobId)?.status.evaluation;
          if (gain(e.candidate, best?.candidate ?? e.baseline, e.direction) > c.limits.minImprovement) c.bestJobId = job.id;
        }
      });
      c = this.get(value);
    }
    const reason = cycleLimitReason(c);
    if (reason) { await this.finish(c, reason); return; }
    // A durable iteration claim precedes even an agent call. Failed proposals consume a slot.
    const number = c.trials.length + 1;
    await this.service.store.change(s => { const c = s.cycles.find(v => v.id === value)!; if (c.state !== "running") throw new MlError("Search was stopped"); c.trials.push({ number, state: "planning" }); });
    const controller = new AbortController(); this.planners.set(value, controller);
    try {
      const output = await this.planner(this.get(value), this.jobs(value), controller.signal, this.service.store.directory);
      const next = proposal(output, c.template.intent.spec!);
      c = this.get(value);
      if (c.state !== "running" || this.closing || controller.signal.aborted) throw new MlError("Planning interrupted; iteration remains consumed");
      if (next.stop) {
        await this.service.store.change(s => { const t = s.cycles.find(v => v.id === value)!.trials.at(-1)!; t.state = "rejected"; t.reason = next.reason; });
        await this.finish(this.get(value), `Planner stopped: ${next.reason}`); return;
      }
      if (c.trials.some(t => t.spec && canonical(t.spec) === canonical(next.spec))) throw new MlError("Planner repeated an existing configuration");
      const deadline = this.trialDeadline(c);
      if (deadline < Date.now() + (next.spec!.trainSeconds + 1) * 1000) {
        await this.service.store.change(s => { const t = s.cycles.find(v => v.id === value)!.trials.at(-1)!; t.state = "rejected"; t.reason = "Remaining elapsed time reserved for final evaluation"; });
        await this.finish(this.get(value), "Planning exhausted the remaining trial time"); return;
      }
      const job = this.record(c, next.spec!, deadline, false);
      await this.service.submitRecord(job, s => {
        const c = s.cycles.find(v => v.id === value)!, t = c.trials.at(-1)!;
        if (c.state !== "running" || t.number !== number || t.state !== "planning" || Date.now() >= deadline || c.reservedTrainSeconds + next.spec!.trainSeconds > c.limits.trainSeconds) throw new MlError("Search reservation changed");
        c.reservedTrainSeconds += next.spec!.trainSeconds; t.state = "running"; t.spec = next.spec; t.reason = next.reason; t.jobId = job.id;
      });
    } catch (error) {
      await this.service.store.change(s => { const c = s.cycles.find(v => v.id === value)!, t = c.trials.at(-1)!; if (t?.state === "planning") { t.state = "rejected"; t.reason = (error as Error).message.slice(0, 2000); } if (c.state === "running") { c.state = "paused"; c.reason = (error as Error).message.slice(0, 2000); } });
    } finally { this.planners.delete(value); }
  }
  private record(c: Cycle, spec: NonNullable<Experiment["intent"]["spec"]>, deadline: number, final: boolean): Experiment {
    const now = Date.now(), jobId = randomUUID();
    const best = final ? this.jobs(c.id).find(e => e.id === c.bestJobId)! : undefined;
    const accepted = intent({ ...c.template.intent, id: jobId, createdAt: now, deadline, spec, search: { cycleId: c.id, partition: final ? "test" : "validation", ...(best ? { fromJob: { id: best.id, modelHash: best.status.evaluation!.modelHash } } : {}) } });
    return { ...c.template, id: jobId, operationId: jobId, requestHash: hash(canonical(accepted)), name: `${c.name} · ${final ? "final test" : `trial ${c.trials.length}`}`, intent: accepted, status: { id: jobId, state: "submitted", updatedAt: now } };
  }
  private async finish(c: Cycle, reason: string) {
    if (!c.bestJobId || Date.now() + 1000 >= c.expiresAt) {
      await this.service.store.change(s => { const current = s.cycles.find(v => v.id === c.id)!; if (current.state === "running") { current.state = "completed"; current.reason = `${reason}; ${c.bestJobId ? "no time for final test" : (this.jobs(c.id).some(job => job.intent.search?.partition === "validation" && job.status.state === "succeeded" && job.status.evaluation?.partition === "validation") ? "no candidate beat the validation baseline" : c.trials.every(t => !t.jobId) ? "every iteration ended in planning; no model was trained" : "no trial produced a validation result; keep the baseline")}`; } }); return;
    }
    const best = this.jobs(c.id).find(e => e.id === c.bestJobId)!;
    const job = this.record(c, best.intent.spec!, Math.min(c.expiresAt, Date.now() + (c.template.intent.recipe ? 1800 : 600) * 1000), true);
    await this.service.submitRecord(job, s => { const current = s.cycles.find(v => v.id === c.id)!; if (current.state !== "running" || current.finalJobId) throw new MlError("Search finalization changed"); current.finalJobId = job.id; current.reason = `${reason}; testing the selected model once`; });
  }
}
