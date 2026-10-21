import { createHash } from "node:crypto";
import type { AgentId } from "./adapters/types.js";
export interface ModelDocumentation {
    model: string;
    contextTokens: number | null;
    maxOutputTokens: number | null;
    capabilities: string[] | null;
    pricing: {
        currency: "USD";
        inputPerMillion: number;
        outputPerMillion: number;
    } | null;
    source: string;
    digest: string;
    verifiedAt: number;
    confidence: "documented";
}
const origins = new Set(["developers.openai.com", "platform.openai.com", "learn.chatgpt.com", "platform.claude.com", "code.claude.com", "docs.cloud.google.com", "ai.google.dev", "antigravity.google", "www.antigravity.google"]);
export function validateDocumentation(value: unknown, provider: AgentId, model: string): ModelDocumentation {
    const d = value as ModelDocumentation;
    const allowed = provider === "codex" ? ["developers.openai.com", "platform.openai.com", "learn.chatgpt.com"] : provider === "claude" ? ["platform.claude.com", "code.claude.com"] : ["docs.cloud.google.com", "ai.google.dev", "antigravity.google", "www.antigravity.google"];
    let url: URL;
    try {
        url = new URL(d.source);
    }
    catch {
        throw new Error("Invalid documentation source");
    }
    if (!d || Object.keys(d).some(k => !["model", "contextTokens", "maxOutputTokens", "capabilities", "pricing", "source", "digest", "verifiedAt", "confidence"].includes(k)) || d.model !== model || url.protocol !== "https:" || !allowed.includes(url.hostname) || url.username || url.password || url.port || !/^[a-f0-9]{64}$/.test(d.digest) || !Number.isFinite(d.verifiedAt) || d.confidence !== "documented" || d.capabilities !== null && (!Array.isArray(d.capabilities) || d.capabilities.length > 12 || d.capabilities.some(c => !["text", "image", "audio", "tools", "structured-output"].includes(c))))
        throw new Error("Invalid documentation proposal");
    for (const n of [d.contextTokens, d.maxOutputTokens])
        if (n !== null && (!Number.isSafeInteger(n) || n < 1 || n > 100000000))
            throw new Error("Invalid documented token limit");
    if (d.pricing !== null && (!d.pricing || Object.keys(d.pricing).sort().join() !== "currency,inputPerMillion,outputPerMillion" || d.pricing.currency !== "USD" || [d.pricing.inputPerMillion, d.pricing.outputPerMillion].some(n => !Number.isFinite(n) || n < 0 || n > 100000)))
        throw new Error("Invalid documented price");
    return d;
}
/** Only exact model pages and recognized labels become facts; other material stays unknown. */
export function proposeDocumentation(provider: AgentId, model: string, source: string, text: string, now = Date.now()): ModelDocumentation | undefined {
    if (!text.includes(model))
        return;
    const plain = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    const number = (pattern: RegExp) => { const found = plain.match(pattern)?.[1]; return found ? Number(found.replaceAll(",", "")) : null; };
    // A page listing multiple models cannot safely associate a nearby number with this model.
    const exactPage = provider === "codex" && new URL(source).pathname.replace(/\/$/, "").endsWith("/" + model);
    const contextTokens = exactPage ? number(/([\d,]+)\s+(?:token\s+)?context window/i) : null;
    const maxOutputTokens = exactPage ? number(/([\d,]+)\s+(?:max(?:imum)?\s+output|output limit)/i) : null;
    const price = exactPage ? plain.match(/Input\s*\$([\d.]+)[\s\S]{0,160}?Output\s*\$([\d.]+)/i) : null;
    const d: ModelDocumentation = { model, contextTokens, maxOutputTokens, capabilities: null, pricing: price && /per\s+(?:1M|million)\s+tokens/i.test(plain) ? { currency: "USD", inputPerMillion: Number(price[1]), outputPerMillion: Number(price[2]) } : null, source, digest: createHash("sha256").update(text).digest("hex"), verifiedAt: now, confidence: "documented" };
    return validateDocumentation(d, provider, model);
}
async function officialText(source: string, fetcher: typeof fetch): Promise<{
    source: string;
    text: string;
}> {
    let url = new URL(source);
    for (let i = 0; i < 4; i++) {
        if (url.protocol !== "https:" || !origins.has(url.hostname) || url.username || url.password || url.port)
            throw new Error("Research must stay on official documentation origins");
        const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { Accept: "text/markdown, text/html, text/plain" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location)
                throw new Error("Invalid redirect");
            url = new URL(location, url);
            continue;
        }
        if (!response.ok || !response.body)
            throw new Error("Documentation unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                bytes += value.length;
                if (bytes > 2000000)
                    throw new Error("Documentation too large");
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel();
        }
        return { source: url.href, text: Buffer.concat(chunks).toString("utf8") };
    }
    throw new Error("Too many documentation redirects");
}
/** Bounded deterministic research: no page instructions or executable text enter the coordinator prompt. */
export async function researchModels(provider: AgentId, models: string[], fetcher: typeof fetch = fetch): Promise<ModelDocumentation[]> {
    const result: ModelDocumentation[] = [];
    const pages = provider === "codex" ? models.filter(m => /^[\w.-]+$/.test(m)).slice(0, 4).map(m => ({ source: `https://developers.openai.com/api/docs/models/${m}`, models: [m] })) : [{ source: provider === "claude" ? "https://platform.claude.com/docs/en/about-claude/models/overview" : "https://antigravity.google/docs/models", models }];
    await Promise.all(pages.map(async (page) => { try {
        const { source, text } = await officialText(page.source, fetcher);
        for (const model of page.models) {
            const d = proposeDocumentation(provider, model, source, text);
            if (d)
                result.push(d);
        }
    }
    catch { /* Missing evidence remains unknown. */ } }));
    return result;
}
