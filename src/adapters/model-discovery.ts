import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJsonlProcess } from "./process.js";
import type { AgentContainer } from "../agent-container.js";
import type { AgentId, ModelCatalog, ModelInfo } from "./types.js";
export interface DiscoveryContext {
    cwd?: string;
    agentContainer?: AgentContainer;
    isolatedAgy?: boolean;
}
/** Official CLI control protocols only. No user prompt, inference call, auth file or token export. */
export async function discoverModels(provider: AgentId, context: DiscoveryContext = {}): Promise<ModelCatalog> {
    if (provider !== "claude" && provider !== "codex")
        throw new Error("Model discovery is unsupported by this adapter");
    const temporary = context.cwd ? undefined : await mkdtemp(join(tmpdir(), "codeflow-models-"));
    const cwd = context.cwd ?? temporary!;
    const args = provider === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome", "--tools", "", "--settings", '{"disableAllHooks":true,"disableWorkflows":true,"ultracode":false}'];
    let sequence = 0, bytes = 0;
    const pending = new Map<string, {
        resolve(value: any): void;
        reject(error: Error): void;
    }>();
    const process = startJsonlProcess({ command: provider, args, cwd, timeoutMs: 12000, interactive: true, ...(context.agentContainer ? { agentContainer: { config: context.agentContainer, mode: "read" as const } } : {}), onText: () => { }, onJson(value: any) {
            bytes += JSON.stringify(value).length;
            if (bytes > 2000000) {
                process.kill();
                return;
            }
            const response = provider === "claude" ? value.type === "control_response" ? value.response : undefined : value;
            const id = response?.request_id ?? response?.id;
            const waiter = pending.get(String(id));
            if (!waiter)
                return;
            pending.delete(String(id));
            if (response.error || response.subtype === "error")
                waiter.reject(new Error("Provider rejected model discovery"));
            else
                waiter.resolve(provider === "claude" ? response.response : response.result);
        } });
    // Never include provider stderr in catalog state: authentication diagnostics may contain identifiers.
    const request = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
        const id = String(++sequence);
        pending.set(id, { resolve, reject });
        process.send(provider === "codex" ? { id, method, params } : { type: "control_request", request_id: id, request: { subtype: method, ...params } });
    });
    void process.outcome.then(() => { for (const waiter of pending.values())
        waiter.reject(new Error("Model discovery unavailable or timed out")); pending.clear(); });
    try {
        const init = await request("initialize", provider === "codex" ? { clientInfo: { name: "code_flow_catalog", version: "0.1.0" } } : {});
        let raw: any[], account: unknown, source: string;
        if (provider === "codex") {
            process.send({ method: "initialized", params: {} });
            account = (await request("account/read", { refreshToken: false }).catch(() => undefined))?.account;
            raw = [];
            let cursor: string | undefined;
            for (let page = 0; page < 8; page++) {
                const response = await request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
                if (!Array.isArray(response?.data))
                    throw new Error("Invalid model discovery response");
                raw.push(...response.data);
                cursor = response.nextCursor;
                if (!cursor)
                    break;
                if (page === 7)
                    throw new Error("Model discovery exceeds the bounded catalog");
            }
            source = "codex app-server model/list";
        }
        else {
            raw = init?.models;
            account = init?.account;
            source = "claude initialize models";
        }
        if (!Array.isArray(raw) || raw.length > 800)
            throw new Error("Invalid model discovery response");
        const models: ModelInfo[] = [];
        let defaultModel: string | undefined;
        for (const m of raw) {
            if (m.hidden === true)
                continue;
            const id = provider === "claude" ? m.resolvedModel ?? m.value : m.model ?? m.id;
            if (typeof id !== "string" || !/^[A-Za-z0-9][\w.:[\]/@-]{0,199}$/.test(id))
                continue;
            const effortList = provider === "claude" ? m.supportedEffortLevels : m.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort);
            const efforts = Array.isArray(effortList) ? effortList.filter((e: any) => typeof e === "string" && /^[a-z]{2,12}$/.test(e) && e !== "ultracode") : m.supportsEffort === false ? [] : undefined;
            const entry: ModelInfo = { id, label: typeof m.displayName === "string" ? m.displayName.slice(0, 120) : id, efforts, defaultEffort: m.defaultReasoningEffort, aliases: provider === "claude" && m.value !== id ? [m.value] : [], discovery: { source, confidence: "reported", verifiedAt: Date.now() } };
            const existing = models.find(x => x.id === id);
            if (existing)
                existing.aliases = [...new Set([...(existing.aliases ?? []), ...(entry.aliases ?? [])])];
            else
                models.push(entry);
            if (m.isDefault || m.value === "default")
                defaultModel = id;
        }
        if (!models.length)
            throw new Error("Provider reported no selectable models");
        return { models, efforts: [...new Set(models.flatMap(m => m.efforts ?? []))], defaultModel, allowCustom: true, discovery: { source, confidence: "reported", verifiedAt: Date.now() }, accountKey: account ? createHash("sha256").update(JSON.stringify(account)).digest("hex") : undefined };
    }
    finally {
        process.kill();
        await process.outcome;
        if (temporary)
            await rm(temporary, { recursive: true, force: true });
    }
}
