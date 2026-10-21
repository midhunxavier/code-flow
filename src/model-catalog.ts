import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { CODEFLOW_HOME } from "./config.js";
import { getAdapter, type AgentId, type ModelCatalog, type AgentSettings } from "./adapters/index.js";
import type { DiscoveryContext } from "./adapters/model-discovery.js";
import { researchModels, validateDocumentation, type ModelDocumentation } from "./model-research.js";
const TTL = 10 * 60000;
const ID = /^[A-Za-z0-9][\w.:[\]/@-]{0,199}$/;
const effortValid = (v: unknown): v is string => typeof v === "string" && /^[a-z]{2,12}$/.test(v) && v !== "ultracode";
export interface CatalogObservation {
    runId: string;
    at: number;
    ok: boolean;
    effort: string;
    durationMs: number;
    errorKind?: string;
}
export interface CapabilityModel {
    id: string;
    label: string;
    aliases: string[];
    /** null is unknown; [] means the provider explicitly reports no effort control. */
    efforts: string[] | null;
    defaultEffort?: string;
    availability: "reported" | "unavailable";
    compatibility: "advertised" | "unknown";
    source: string;
    verifiedAt: number;
    confidence: "reported";
    documented?: ModelDocumentation;
    researchAttemptedAt?: number;
    observations: CatalogObservation[];
}
export interface CapabilityCatalog {
    schemaVersion: 1;
    revision: number;
    provider: AgentId;
    environment: string;
    accountKey?: string;
    defaultModel?: string;
    discoveredAt: number;
    attemptedAt: number;
    state: "current" | "stale" | "unknown";
    issue?: "discovery-unavailable" | "offline";
    models: CapabilityModel[];
}
export interface ModelAssignment {
    provider: AgentId;
    model: string;
    effort: string;
    rationale: string;
    catalogRevision: number;
    environment: string;
    verifiedAt: number;
    source: string;
    stale: boolean;
}
export function modelEnvironment(context: DiscoveryContext = {}, remote?: string): string {
    return createHash("sha256").update(JSON.stringify({ host: hostname(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, claudeHome: process.env.CLAUDE_CONFIG_DIR, path: process.env.PATH, container: context.agentContainer, ...(context.isolatedAgy ? { isolation: "agy-macos-file-only-v1/1.4.4" } : {}), remote })).digest("hex");
}
export function validateCapabilityCatalog(value: unknown): CapabilityCatalog {
    const c = value as CapabilityCatalog;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["schemaVersion", "revision", "provider", "environment", "accountKey", "defaultModel", "discoveredAt", "attemptedAt", "state", "issue", "models"].includes(k)))
        throw new Error("Invalid capability catalog fields");
    if (!c || c.schemaVersion !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 0 || typeof c.provider !== "string" || !ID.test(c.provider) || !/^[a-f0-9]{64}$/.test(c.environment) || !["current", "stale", "unknown"].includes(c.state) || !Number.isFinite(c.discoveredAt) || !Number.isFinite(c.attemptedAt) || !Array.isArray(c.models) || c.models.length > 800 || (c.accountKey !== undefined && !/^[a-f0-9]{64}$/.test(c.accountKey)))
        throw new Error("Invalid capability catalog");
    const seen = new Set<string>();
    for (const m of c.models) {
        if (!m || Object.keys(m).some(k => !["id", "label", "aliases", "efforts", "defaultEffort", "availability", "compatibility", "source", "verifiedAt", "confidence", "documented", "researchAttemptedAt", "observations"].includes(k)) || typeof m.id !== "string" || !ID.test(m.id) || seen.has(m.id) || typeof m.label !== "string" || m.label.length > 120 || !Array.isArray(m.aliases) || m.aliases.length > 30 || m.aliases.some(a => typeof a !== "string" || !ID.test(a)) || !(m.efforts === null || Array.isArray(m.efforts) && m.efforts.length <= 20 && m.efforts.every(effortValid)) || m.defaultEffort !== undefined && !m.efforts?.includes(m.defaultEffort) || !["reported", "unavailable"].includes(m.availability) || !["advertised", "unknown"].includes(m.compatibility) || m.confidence !== "reported" || typeof m.source !== "string" || m.source.length > 120 || !Number.isFinite(m.verifiedAt) || !Array.isArray(m.observations) || m.observations.length > 30)
            throw new Error("Invalid model capability record");
        seen.add(m.id);
        if (m.researchAttemptedAt !== undefined && (!Number.isFinite(m.researchAttemptedAt) || m.researchAttemptedAt < 0))
            throw new Error("Invalid research timestamp");
        if (m.documented)
            validateDocumentation(m.documented, c.provider, m.id);
        for (const o of m.observations)
            if (!o || Object.keys(o).some(k => !["runId", "at", "ok", "effort", "durationMs", "errorKind"].includes(k)) || typeof o.runId !== "string" || o.runId.length > 200 || !Number.isFinite(o.at) || typeof o.ok !== "boolean" || typeof o.effort !== "string" || o.effort.length > 12 || !Number.isFinite(o.durationMs) || o.durationMs < 0 || o.errorKind !== undefined && !/^[a-z_]{1,40}$/.test(o.errorKind))
                throw new Error("Invalid model observation");
    }
    const aliases = new Map<string,string>();
    for (const model of c.models) for (const alias of model.aliases) {
        if (seen.has(alias) && alias !== model.id || aliases.has(alias) && aliases.get(alias) !== model.id) throw new Error("Ambiguous model alias");
        aliases.set(alias,model.id);
    }
    if (c.defaultModel !== undefined && !seen.has(c.defaultModel))
        throw new Error("Unknown default model");
    return c;
}
export function assignmentProblem(c: CapabilityCatalog, model: string, effort: string): string | undefined {
    const entry = c.models.find(m => m.id === (model || c.defaultModel) || m.aliases.includes(model));
    if (!entry || entry.availability !== "reported" || entry.compatibility !== "advertised")
        return `Model ${model || "default"} is not reported by ${c.provider} in this execution environment. Refresh its catalog or choose an eligible model.`;
    if (effort && !entry.efforts?.includes(effort))
        return `${entry.id} does not report support for effort ${effort}; choose a listed setting or leave effort at its default`;
}
export function resolveModelAssignment(c: CapabilityCatalog, model: string, effort: string, rationale: string): ModelAssignment {
    const problem = assignmentProblem(c, model, effort);
    if (problem)
        throw new Error(problem);
    const m = c.models.find(m => m.id === (model || c.defaultModel) || m.aliases.includes(model))!;
    return { provider: c.provider, model: m.id, effort, rationale: rationale.slice(0, 2000), catalogRevision: c.revision, environment: c.environment, verifiedAt: m.verifiedAt, source: m.source, stale: c.state !== "current" };
}
/** Check current user constraints again at dispatch, including journaled assignments. */
export function workerConstraintProblem(c: CapabilityCatalog, assignment: ModelAssignment, providers?: AgentId[], pin?: NonNullable<AgentSettings[AgentId]>): string | undefined {
    if (assignment.provider !== c.provider || providers && !providers.includes(assignment.provider))
        return "Worker provider is outside the allowed pool";
    if (!pin)
        return;
    const choices = pin.variants?.length ? [pin, ...pin.variants] : [pin];
    const permits = choices.some(choice => {
        const pinnedModel = choice.model || (pin.variants?.length ? c.defaultModel : undefined);
        const exact = pinnedModel && c.models.find(m => m.id === pinnedModel || m.aliases.includes(pinnedModel))?.id;
        return (!pinnedModel || exact === assignment.model) && (!choice.effort || choice.effort === assignment.effort);
    });
    if (!permits)
        return "Worker assignment does not preserve the user's model/effort pins";
}
/** Persistent per-environment discovery. A failed refresh never replaces verified entries with guesses. */
export class ModelCatalogStore {
    private tail: Promise<unknown> = Promise.resolve();
    private flights = new Map<string, Promise<CapabilityCatalog>>();
    constructor(readonly home = CODEFLOW_HOME, private discover = (id: AgentId, context: DiscoveryContext) => {
        const adapter = getAdapter(id);
        if (!adapter.discoverModels)
            return Promise.reject(new Error("Unsupported discovery"));
        return adapter.discoverModels(context);
    }, private now = Date.now) { }
    private path(provider: AgentId, environment: string) { return join(this.home, "model-catalogs", createHash("sha256").update(provider + environment).digest("hex") + ".json"); }
    async read(provider: AgentId, environment: string): Promise<CapabilityCatalog | undefined> {
        try {
            const text = await readFile(this.path(provider, environment), "utf8");
            if (text.length > 4000000)
                throw new Error("Catalog too large");
            const c = validateCapabilityCatalog(JSON.parse(text));
            if (c.provider !== provider || c.environment !== environment)
                throw new Error("Catalog identity mismatch");
            return c;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return;
            throw error;
        }
    }
    private save(c: CapabilityCatalog) {
        const work = async () => {
            const latest = await this.read(c.provider, c.environment);
            if (latest?.accountKey === c.accountKey)
                for (const m of c.models) {
                    const observations = [...(latest?.models.find(v => v.id === m.id)?.observations ?? []), ...m.observations];
                    m.observations = [...new Map(observations.map(o => [`${o.runId}:${o.at}:${o.effort}`, o])).values()].sort((a, b) => a.at - b.at).slice(-30);
                }
            if (latest && latest.revision > c.revision) {
                for (const m of latest.models)
                    if (latest.accountKey === c.accountKey)
                        m.observations = c.models.find(v => v.id === m.id)?.observations ?? m.observations;
                c = latest;
            }
            validateCapabilityCatalog(c);
            const dir = join(this.home, "model-catalogs");
            await mkdir(dir, { recursive: true });
            const path = this.path(c.provider, c.environment), temp = path + "." + randomUUID();
            try {
                const file = await open(temp, "wx", 0o600);
                try {
                    await file.writeFile(JSON.stringify(c));
                    await file.sync();
                }
                finally {
                    await file.close();
                }
                await rename(temp, path);
                // Immutable discovery/documentation evidence; observations remain in the current projection.
                if (c.revision > 0) {
                    const snapshot = path.replace(/\.json$/, `.v${c.revision}.json`);
                    try {
                        const evidence = await open(snapshot, "wx", 0o600);
                        try {
                            await evidence.writeFile(JSON.stringify(c));
                            await evidence.sync();
                        }
                        finally {
                            await evidence.close();
                        }
                    }
                    catch (e) {
                        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
                            throw e;
                    }
                }
                const folder = await open(dir, "r");
                try {
                    await folder.sync();
                }
                finally {
                    await folder.close();
                }
            }
            finally {
                await rm(temp, { force: true });
            }
        };
        const promise = this.tail.then(work);
        this.tail = promise.catch(() => { });
        return promise;
    }
    async settings(allowResearch?: boolean): Promise<{
        allowResearch: boolean;
    }> {
        const path = join(this.home, "model-catalog-settings.json");
        if (allowResearch !== undefined) {
            await mkdir(this.home, { recursive: true });
            const temp = path + "." + randomUUID();
            await (await import("node:fs/promises")).writeFile(temp, JSON.stringify({ allowResearch }), { mode: 0o600 });
            await rename(temp, path);
        }
        return readFile(path, "utf8").then(text => ({ allowResearch: JSON.parse(text).allowResearch === true })).catch(() => ({ allowResearch: false }));
    }
    get(provider: AgentId, options: {
        context?: DiscoveryContext;
        environment?: string;
        force?: boolean;
        offline?: boolean;
        reported?: ModelCatalog;
    } = {}): Promise<CapabilityCatalog> {
        const environment = options.environment ?? modelEnvironment(options.context), key = provider + environment;
        if (options.offline || process.env.CODEFLOW_MODEL_NETWORK === "offline")
            return this.refresh(provider, environment, { ...options, offline: true });
        const active = this.flights.get(key);
        if (active)
            return active;
        const work = this.refresh(provider, environment, options);
        this.flights.set(key, work);
        void work.finally(() => this.flights.delete(key)).catch(() => { });
        return work;
    }
    private async refresh(provider: AgentId, environment: string, options: {
        context?: DiscoveryContext;
        force?: boolean;
        offline?: boolean;
        reported?: ModelCatalog;
    }): Promise<CapabilityCatalog> {
        const prior = await this.read(provider, environment), now = this.now();
        const offline = options.offline || process.env.CODEFLOW_MODEL_NETWORK === "offline";
        if (prior && !options.force && now - prior.attemptedAt < TTL && !offline)
            return { ...prior, state: !prior.discoveredAt ? "unknown" : now - prior.discoveredAt < TTL ? "current" : "stale" };
        if (offline)
            return prior ? { ...prior, state: "stale", issue: "offline" } : { schemaVersion: 1, revision: 0, provider, environment, models: [], discoveredAt: 0, attemptedAt: now, state: "unknown", issue: "offline" };
        let reported: ModelCatalog;
        try {
            reported = options.reported ?? await this.discover(provider, options.context ?? {});
        }
        catch {
            const failed: CapabilityCatalog = prior ? { ...prior, attemptedAt: now, state: "stale", issue: "discovery-unavailable" } : { schemaVersion: 1, revision: 0, provider, environment, models: [], discoveredAt: 0, attemptedAt: now, state: "unknown", issue: "discovery-unavailable" };
            await this.save(failed);
            return failed;
        }
        const sameAccount = prior?.accountKey === reported.accountKey;
        const entries: CapabilityModel[] = reported.models.map(m => {
            const old = sameAccount ? prior?.models.find(p => p.id === m.id) : undefined;
            return { id: m.id, label: m.label, aliases: m.aliases ?? [], efforts: m.efforts ?? null, ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}), availability: "reported", compatibility: reported.discovery ? "advertised" : "unknown", source: reported.discovery?.source ?? "legacy catalog (account access unknown)", verifiedAt: now, confidence: "reported", documented: old?.documented, researchAttemptedAt: old?.researchAttemptedAt, observations: old?.observations ?? [] };
        });
        const result: CapabilityCatalog = { schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, provider, environment, accountKey: reported.accountKey, defaultModel: reported.defaultModel, models: entries, discoveredAt: now, attemptedAt: now, state: "current" };
        validateCapabilityCatalog(result);
        if ((await this.settings()).allowResearch && !options.context?.agentContainer && !options.reported) {
            const pending = entries.filter(m => (!m.documented || now - m.documented.verifiedAt > 7 * 86400000) && (!m.researchAttemptedAt || now - m.researchAttemptedAt > 7 * 86400000)).slice(0, provider === "codex" ? 4 : 800);
            const proposals = await researchModels(provider, pending.map(m => m.id)).catch(() => []);
            for (const m of pending)
                m.researchAttemptedAt = now;
            for (const proposal of proposals) {
                const m = entries.find(m => m.id === proposal.model);
                if (m)
                    m.documented = validateDocumentation(proposal, provider, m.id);
            }
        }
        await this.save(result);
        return result;
    }
    async observe(assignment: ModelAssignment, observation: CatalogObservation) {
        await this.tail;
        const c = await this.read(assignment.provider, assignment.environment);
        if (!c)
            return;
        const m = c.models.find(m => m.id === assignment.model);
        if (!m)
            return;
        m.observations = [...m.observations, observation].slice(-30);
        await this.save(c);
    }
}
export const modelCatalogStore = new ModelCatalogStore();
