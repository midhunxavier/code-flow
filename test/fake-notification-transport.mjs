// Explicit test preload only: no production environment flag intercepts network requests.
import { appendFile, readFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "notifications-fixture.invalid") return originalFetch(input, options);
  if (url.protocol !== "https:" || options?.method !== "POST" || options.redirect !== "error") throw new Error("Invalid fixture request");
  if (new Headers(options.headers).get("authorization") !== `Bearer ${process.env.NOTIFICATION_FIXTURE_CREDENTIAL}`) return new Response("forbidden", { status: 403 });
  const mode = await readFile(process.env.NOTIFICATION_FIXTURE_MODE, "utf8").catch(() => "200");
  const status = Number(mode.trim());
  await appendFile(process.env.NOTIFICATION_FIXTURE_REQUESTS, JSON.stringify({ payload: JSON.parse(String(options.body)), status }) + "\n");
  return new Response("fixture response", { status });
};
