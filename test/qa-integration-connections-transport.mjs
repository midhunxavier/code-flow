import { readFileSync } from "node:fs";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return nativeFetch(input, options);
  if (!["source-fixture.invalid", "linear-fixture.invalid", "jira-fixture.invalid"].includes(url.hostname)) throw new Error("QA forbids external network requests");
  const state = JSON.parse(readFileSync(process.env.FAKE_CONNECTIONS_STATE, "utf8"));
  if (state.fail) return new Response("fixture refusal", { status: 401 });
  if (url.hostname === "linear-fixture.invalid") {
    const item = { id: "fixture", identifier: "ENG-7", title: "Linear fixture", description: "Controlled issue", url: "https://linear-fixture.invalid/ENG-7", team: { key: "ENG" }, state: { name: "Open" } };
    return Response.json({ data: { issue: item, issues: { nodes: [item], pageInfo: { hasNextPage: false } } } });
  }
  if (url.hostname === "jira-fixture.invalid") {
    const item = { key: "APP-7", fields: { summary: "Jira fixture", description: "Controlled issue", status: { name: "Open" } } };
    return Response.json(url.pathname.includes("/issue/") ? item : { issues: [item] });
  }
  const key = url.pathname.match(/\/(?:issues|merge_requests)\/(\d+)$/)?.[1], pr = url.pathname.includes("merge_requests");
  const item = number => ({ iid: number, title: `Fixture ${pr ? "PR" : "issue"} ${number}`, description: "Controlled source", web_url: `https://source-fixture.invalid/org/repo/issues/${number}`, state: "opened", source_branch: "feature", target_branch: "main", sha: "a".repeat(40) });
  if (key) return Response.json(item(Number(key)));
  const page = Number(url.searchParams.get("page") || 1), size = Number(url.searchParams.get("per_page") || 50), count = pr ? 1 : state.count;
  const rows = Array.from({ length: Math.max(0, Math.min(size, count - (page - 1) * size)) }, (_, i) => item((page - 1) * size + i + 1));
  return Response.json(rows, { headers: { "x-next-page": page * size < count ? String(page + 1) : "" } });
};
