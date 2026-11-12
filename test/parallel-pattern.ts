import type { Pattern } from "../src/engine.js";

/**
 * A workflow for engine tests: every writer does the task in a worktree of its own, side by side.
 * A writer's failed turn is part of the result; each finished candidate is checked, and all are
 * published in order, so the first is the run's primary result.
 */
export const parallelPattern: Pattern = {
  id: "test-parallel",
  name: "Parallel candidates",
  summary: "",
  description: "",
  roles: [{ id: "writers", label: "Writers", description: "", multiple: true, default: ["claude", "codex"] }],
  options: [],
  async run(ctx) {
    const entries = await ctx.parallel(ctx.participants("writers"), async ({ agent, settings, identity }, i) => {
      const label = "ABCDEFGH"[i] ?? String(i + 1);
      const wt = await ctx.worktree(`candidate-${label.toLowerCase()}`);
      const result = await ctx.ask({ title: `Candidate ${label}`, role: "writers", agent, settings, identity, mode: "write", cwd: wt, allowFailure: true, prompt: ctx.task });
      await ctx.commit(wt, `candidate ${label}`);
      const check = result.ok ? await ctx.check(wt, `Check candidate ${label}`) : null;
      return { label, wt, ok: result.ok, check };
    });
    const finished = entries.filter((e) => e.ok);
    if (!finished.length) throw new Error("No candidate finished");
    for (const e of entries) await ctx.artifact(`Candidate ${e.label}`, e.wt);
    if (ctx.hasCheck) ctx.setVerdict(finished[0]!.check?.ok ? "passed" : "failing");
    return `Finished: ${finished.map((e) => `Candidate ${e.label}`).join(", ")}`;
  },
};

/** `find`, plus the parallel workflow, so a resume can look it up. */
export const withParallel = (find: (id: string) => Pattern | undefined) => (id: string) => (id === parallelPattern.id ? parallelPattern : find(id));
