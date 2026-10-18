// Imported explicitly by this feature's E2E child only. No production environment switch.
import { CodeHostGit } from "../src/code-host-git.js";
import { codeHostFixture } from "./code-host-fixture.js";
const fixture = codeHostFixture(process.env.FAKE_CODE_HOST_REMOTE!, process.env.FAKE_CODE_HOST_STATE!);
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); return ["gitlab-fixture.invalid", "bitbucket-fixture.invalid"].includes(url.hostname) ? fixture.fetch(input, options) : originalFetch(input, options); }) as typeof fetch;
for (const method of ["fetch", "push", "mergeCommit"] as const) { const original = CodeHostGit.prototype[method]; (CodeHostGit.prototype as any)[method] = function (...args: any[]) { (this as any).command = fixture.command; return (original as any).apply(this, args); }; }
