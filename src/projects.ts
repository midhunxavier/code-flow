import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentSettings } from "./adapters/types.js";
import { CODEFLOW_HOME } from "./config.js";
import { repoRoot } from "./git.js";

/**
 * Projects group runs: a name and the repositories its runs work in. A run records its project
 * when it starts (see `place`), so the sidebar, Insights and automations can work per project.
 *
 * Runs from before projects existed record none: they belong to the first project holding their
 * repo. A run whose project was deleted belongs to none. Nothing in the run logs is rewritten.
 */

/** The team you last picked for a pattern in this project: an agent (or "auto") per role, and models per role. */
export interface ProjectTeam {
  roles: Record<string, string[]>;
  roleSettings?: Record<string, AgentSettings>;
}

/** What the composer starts from in this project: the last run you started here. */
export interface ProjectDefaults {
  pattern: string;
  teams: Record<string, ProjectTeam>;
  agentSettings?: AgentSettings;
}

export interface Project {
  id: string;
  name: string;
  /** Repository roots. Every run in the project works in one of them. */
  repos: string[];
  createdAt: number;
  defaults?: ProjectDefaults;
}

const MAX_NAME = 60;
const MAX_REPOS = 50;

/** The project a run belongs to (its id), or undefined for none. */
export function projectOf(run: { project?: string; repo: string }, projects: Project[]): string | undefined {
  if (run.project) return projects.some((p) => p.id === run.project) ? run.project : undefined;
  return projects.find((p) => p.repos.includes(run.repo))?.id;
}

export class Projects {
  private projects: Project[] = [];
  private saving: Promise<unknown> = Promise.resolve();
  /** Runs are placed one at a time, so two runs starting in a new repo make one project, not two. */
  private placing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = join(CODEFLOW_HOME, "projects.json")) {}

  /**
   * Read the projects. The first time (no file yet), every repo that already has runs gets a
   * project named after it, so the runs you have are grouped from the start.
   */
  async load(runs: { repo: string; createdAt: number }[] = []) {
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(await readFile(this.file, "utf8"));
        this.projects = Array.isArray(saved) ? saved.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.repos)) : [];
      } catch {
        this.projects = [];
      }
      return;
    }
    const firstRun = new Map<string, number>();
    for (const r of [...runs].sort((a, b) => a.createdAt - b.createdAt)) if (!firstRun.has(r.repo)) firstRun.set(r.repo, r.createdAt);
    for (const [repo, at] of firstRun) this.add(repo, at);
    await this.save();
  }

  list(): Project[] {
    return this.projects.map(copy);
  }

  get(id: string): Project | undefined {
    const p = this.find(id);
    return p && copy(p);
  }

  /** The project a repo's runs go in when none is named: the first one holding it. */
  forRepo(repo: string): Project | undefined {
    const p = this.projects.find((x) => x.repos.includes(repo));
    return p && copy(p);
  }

  async create(input: { name: unknown; repos?: unknown[] }): Promise<Project> {
    const project: Project = { id: `p-${randomBytes(4).toString("hex")}`, name: this.checkName(input.name), repos: await checkRepos(input.repos ?? []), createdAt: Date.now() };
    this.projects.push(project);
    await this.save();
    return copy(project);
  }

  /** Rename a project or change its repos. Runs already in it stay, even in a repo you take out. */
  async update(id: string, patch: { name?: unknown; repos?: unknown[] }): Promise<Project> {
    const p = this.require(id);
    const name = patch.name !== undefined ? this.checkName(patch.name, id) : p.name;
    const repos = patch.repos !== undefined ? await checkRepos(patch.repos, p.repos) : p.repos;
    p.name = name;
    p.repos = repos;
    await this.save();
    return copy(p);
  }

  /** Delete a project. Its runs are kept and belong to no project. */
  async remove(id: string) {
    this.require(id);
    this.projects = this.projects.filter((p) => p.id !== id);
    await this.save();
  }

  /**
   * The project a new run in `repo` goes in: the one asked for, else the project of the run it
   * continues, else the repo's project, else (the first run in a repo no project holds) a new
   * project named after the repo. The repo joins the project if it isn't in it yet, so a
   * project's runs always work in its repos.
   *
   * A project that was asked for but no longer exists is an error, unless `lenient` (an
   * automation saved before you deleted it): then the repo decides.
   */
  place(repo: string, opts: { requested?: string; parent?: string; lenient?: boolean } = {}): Promise<{ project: Project; created: boolean; added: boolean }> {
    const next = this.placing.then(async () => {
      let project = opts.requested ? this.find(opts.requested) : undefined;
      if (opts.requested && !project && !opts.lenient) throw new Error("That project no longer exists; pick another one");
      project ??= (opts.parent ? this.find(opts.parent) : undefined) ?? this.projects.find((p) => p.repos.includes(repo));
      const created = !project;
      project ??= this.add(repo);
      const added = !created && !project.repos.includes(repo);
      if (added) project.repos.push(repo);
      if (created || added) await this.save();
      return { project: copy(project), created, added };
    });
    this.placing = next.catch(() => undefined);
    return next;
  }

  /** A run moved into a project brings its repo with it. */
  async include(id: string, repo: string): Promise<{ project: Project; added: boolean }> {
    const p = this.require(id);
    const added = !p.repos.includes(repo);
    if (added) {
      p.repos.push(repo);
      await this.save();
    }
    return { project: copy(p), added };
  }

  /** Remember the pattern and team of a run you started here: the composer starts from them next time. */
  async remember(id: string, run: { pattern: string; roles: Record<string, string[]>; roleSettings?: Record<string, AgentSettings>; agentSettings?: AgentSettings }) {
    const p = this.find(id);
    if (!p) return;
    const team: ProjectTeam = { roles: run.roles };
    if (run.roleSettings && Object.keys(run.roleSettings).length) team.roleSettings = run.roleSettings;
    p.defaults = {
      pattern: run.pattern,
      teams: { ...(p.defaults?.teams ?? {}), [run.pattern]: team },
      agentSettings: run.agentSettings && Object.keys(run.agentSettings).length ? run.agentSettings : undefined,
    };
    await this.save();
  }

  private find(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  private require(id: string): Project {
    const p = this.find(id);
    if (!p) throw new Error("Project not found");
    return p;
  }

  /** A new project for a repo, named after it (or its parent folder too, if the name is taken). */
  private add(repo: string, createdAt = Date.now()): Project {
    const base = basename(repo) || repo;
    const taken = (name: string) => this.projects.some((p) => p.name.toLowerCase() === name.toLowerCase());
    let name = taken(base) ? `${base} (${basename(dirname(repo))})` : base;
    for (let i = 2; taken(name); i++) name = `${base} ${i}`;
    const project: Project = { id: `p-${randomBytes(4).toString("hex")}`, name: name.slice(0, MAX_NAME), repos: [repo], createdAt };
    this.projects.push(project);
    return project;
  }

  private checkName(input: unknown, self?: string): string {
    const name = String(input ?? "").replace(/\s+/g, " ").trim();
    if (!name) throw new Error("Name the project");
    if (name.length > MAX_NAME) throw new Error(`Keep the name under ${MAX_NAME} characters`);
    if (this.projects.some((p) => p.id !== self && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a project called “${name}”`);
    return name;
  }

  private save() {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(this.projects, null, 2), { mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((err: Error) => console.error(`code-flow couldn't save projects: ${err.message}`));
    return this.saving;
  }
}

/** Repository roots for a project; repos it already has are kept as they are (even if moved since). */
async function checkRepos(input: unknown[], current: string[] = []): Promise<string[]> {
  if (!Array.isArray(input)) throw new Error("Repositories must be a list of folders");
  if (input.length > MAX_REPOS) throw new Error(`A project holds at most ${MAX_REPOS} repositories`);
  const repos: string[] = [];
  for (const raw of input) {
    const path = String(raw ?? "").trim();
    if (current.includes(path)) {
      if (!repos.includes(path)) repos.push(path);
      continue;
    }
    if (!path.startsWith("/")) throw new Error("Repositories must be absolute paths");
    const root = await repoRoot(path).catch(() => {
      throw new Error(`${path} isn't a git repository`);
    });
    if (!repos.includes(root)) repos.push(root);
  }
  return repos;
}

function copy(p: Project): Project {
  return structuredClone(p);
}
