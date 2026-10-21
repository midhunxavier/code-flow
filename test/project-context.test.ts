import test from "node:test";
import assert from "node:assert/strict";
import { legacyDraftProject, projectDestination, projectReferenceKey, ProjectDraftStore } from "../ui/project-context.js";
import { hashFor, parseRouteHash, type Route } from "../ui/navigation.js";

const projects = [{ id: "a", name: "A", repos: ["/shared", "/a"], createdAt: 0 }, { id: "b", name: "B", repos: ["/shared", "/b"], createdAt: 0 }];
test("legacy drafts require unambiguous ownership and explicit destinations never fall back", () => {
  assert.equal(legacyDraftProject(projects, "", "/shared"), "");
  assert.equal(legacyDraftProject(projects, "b", "/shared"), "b");
  assert.equal(legacyDraftProject(projects, "deleted", "/a"), "a");
  assert.equal(legacyDraftProject(projects, "deleted", "/orphan"), "");
  assert.equal(projectDestination(projects, "missing", "/a").project, undefined);
  assert.match(projectDestination(projects, "a", "/b").problem, /no longer/);
  assert.equal(projectDestination(projects, "b", "/shared").project?.id, "b");
  assert.notEqual(projectReferenceKey({ computer: "local", project: "a" }), projectReferenceKey({ computer: "vm", project: "a" }));
});
test("project routes retain encoded repository and tool targets and reject unsupported sections", () => {
  const routes: Route[] = [
    { view: "project", id: "a/b", section: "runs" },
    { view: "project", id: "a/b", section: "repositories", repository: "/work/a #1", tool: "code" },
    { view: "project", id: "a", section: "repositories", tool: "history" },
    { view: "project", id: "a", section: "settings" },
    { view: "project", id: "a/b", section: "board" },
    { view: "project", id: "a/b", section: "people" },
    { view: "project", id: "a/b", section: "automation", kind: "missions" },
    { view: "team-people", project: "a/b" },
  ];
  for (const route of routes) assert.deepEqual(parseRouteHash(hashFor(route)), route);
  for (const hash of ["#/project/a/automation/unknown", "#/project/a/automation/missions/extra", "#/project/a/people/extra", "#/project/a/unknown", "#/project/a/runs/extra", "#/project/a/repositories/%2Fa/unknown", "#/project/a/repositories/%"]) assert.equal(parseRouteHash(hash).view, "invalid");
  assert.deepEqual(parseRouteHash(hashFor({ view: "composer", project: "a" })), { view: "composer", project: "a" });
  assert.deepEqual(parseRouteHash(hashFor({ view: "composer", project: "" })), { view: "composer", project: "" });
  assert.deepEqual(parseRouteHash("#/project/a/workspace"), { view: "workspace", project: "a" });
});
test("draft writes retain attachments, order and computer isolation across store instances", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
  const local = new ProjectDraftStore<{ task: string; attachments: string[] }>("local:", storage);
  const vm = new ProjectDraftStore<{ task: string; attachments: string[] }>("vm:", storage);
  const first = { task: "first", attachments: ["attachment"] };
  const saved = local.write("a", first); first.task = "mutated";
  await Promise.all([saved, local.write("b", { task: "other project", attachments: [] }), vm.write("a", { task: "remote", attachments: [] })]);
  await local.write("a", { task: "last edit", attachments: ["attachment"] });
  const reloaded = new ProjectDraftStore<{ task: string; attachments: string[] }>("local:", storage);
  assert.deepEqual(await reloaded.read("a"), { task: "last edit", attachments: ["attachment"] });
  assert.equal((await vm.read("a"))?.task, "remote");
  assert.equal((await local.read("b"))?.task, "other project");
});
test("storage failure is reported while retaining a recoverable in-tab draft", async () => {
  let fail = true;
  const storage = { getItem: () => null, setItem: () => { if (fail) throw new Error("quota"); } } as unknown as Storage;
  const drafts = new ProjectDraftStore<{ task: string }>("local:", storage);
  await assert.rejects(drafts.write("a", { task: "keep me" }), /quota/);
  assert.deepEqual(await drafts.read("a"), { task: "keep me" });
  fail = false;
  await drafts.write("b", { task: "another project" });
  assert.deepEqual(drafts.unsavedKeys, ["a"], "saving another project cannot hide the failed draft");
  await drafts.write("a", { task: "keep me" });
  assert.deepEqual(drafts.unsavedKeys, []);
});

test("denied and blocked IndexedDB opens restore and save drafts through localStorage", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    for (const failure of ["throw", "error", "blocked"]) {
      const values = new Map([["local:a", JSON.stringify({ task: "saved before reload" })]]);
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
      Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
        if (failure === "throw") throw new Error("Storage denied");
        const request: any = { error: new Error("Storage denied") };
        queueMicrotask(() => failure === "blocked" ? request.onblocked() : request.onerror());
        return request;
      } } });
      const drafts = new ProjectDraftStore<{ task: string }>("local:", storage);
      assert.deepEqual(await drafts.read("a"), { task: "saved before reload" }, failure);
      await Promise.all([drafts.write("a", { task: "first edit" }), drafts.write("a", { task: "last edit" })]);
      const reloaded = new ProjectDraftStore<{ task: string }>("local:", storage);
      assert.deepEqual(await reloaded.read("a"), { task: "last edit" }, failure);
      assert.deepEqual(drafts.unsavedKeys, []);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
