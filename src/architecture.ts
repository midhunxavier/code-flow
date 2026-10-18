import ts from "typescript";
import { posix } from "node:path";
import { git, repoRoot } from "./git.js";
import { readEditableFile } from "./workspace.js";
import { sensitiveContextPath } from "./context-inspection.js";
import { redactExport } from "./privacy.js";

export interface ArchitectureEdge { from: string; to: string; specifier: string; kind: "static" | "dynamic" | "module" }
export interface ArchitectureGraph {
  nodes: string[]; edges: ArchitectureEdge[]; truncated: boolean; language: string;
  languages: string[]; packages: { manifest: string; name: string; version: string; kind: string }[];
  unresolved: { from: string; specifier: string; reason: string }[];
  dynamic: { from: string; line: number; reason: string }[];
  cycles: string[][]; components: { directory: string; files: number; incoming: number; outgoing: number }[];
  scannedBytes: number; note: string;
}
const languageOf = (path: string) => /\.[cm]?[jt]sx?$/.test(path) ? "JavaScript/TypeScript" : path.endsWith(".py") ? "Python" : path.endsWith(".go") ? "Go" : path.endsWith(".rs") ? "Rust" : path.endsWith(".java") ? "Java" : undefined;
const ignored = (path: string) => sensitiveContextPath(path) || /(^|\/)(?:node_modules|vendor|dist|build|target|\.git|\.worktrees)\//.test(path);
const manifest = (path: string) => /(^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml)$/.test(path);

/** Static inspection only: never imports project code or runs a compiler, package manager or build hook. */
export async function inspectArchitecture(repo: string, signal?: AbortSignal): Promise<ArchitectureGraph> {
  signal?.throwIfAborted();
  const root = await repoRoot(repo), listing = await git(["ls-files", "-z"], root, { signal });
  signal?.throwIfAborted();
  if (listing.code !== 0) throw new Error("Cannot list repository files");
  const eligible = [...new Set(listing.stdout.split("\0").filter((path) => path && !ignored(path) && (languageOf(path) || manifest(path))))].sort();
  const graph: ArchitectureGraph = { nodes: [], edges: [], truncated: eligible.length > 600, language: "Static multi-language imports", languages: [], packages: [], unresolved: [], dynamic: [], cycles: [], components: [], scannedBytes: 0, note: "Saved tracked files only. JavaScript/TypeScript uses syntax parsing; Python, Go, Rust and Java use conservative static declarations. Runtime imports, macros, conditional compilation, path aliases, generated code and installed dependency trees may require manual inspection. Unresolved entries are not proof of missing packages." };
  const sources = new Map<string, string>();
  for (const path of eligible.slice(0, 600)) {
    signal?.throwIfAborted();
    const file = await readEditableFile(root, path).catch(() => undefined);
    if (!file) continue;
    if (graph.scannedBytes + file.bytes > 8 * 1024 * 1024) { graph.truncated = true; break; }
    graph.scannedBytes += file.bytes;
    if (manifest(path)) readPackages(graph, path, file.text); else { graph.nodes.push(path); sources.set(path, file.text); }
  }
  const all = new Set(graph.nodes), java = new Map<string, string>(), goModules: { root: string; name: string }[] = [];
  for (const [path, source] of sources) {
    if (path.endsWith(".java")) { const name = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]; if (name) java.set(`${name}.${posix.basename(path, ".java")}`, path); }
  }
  for (const pkg of graph.packages) if (pkg.kind === "module" && pkg.manifest.endsWith("go.mod")) goModules.push({ root: posix.dirname(pkg.manifest), name: pkg.name });
  const edge = (from: string, candidates: string[], specifier: string, kind: ArchitectureEdge["kind"] = "static") => {
    const to = candidates.map((path) => posix.normalize(path)).find((path) => all.has(path));
    if (to) { if (graph.edges.length < 4000) graph.edges.push({ from, to, specifier, kind }); else graph.truncated = true; }
    else if (graph.unresolved.length < 500) graph.unresolved.push({ from, specifier: specifier.slice(0, 300), reason: specifier.startsWith(".") ? "Local target was not resolved within scanned files" : "External package or unresolved local module" });
    else graph.truncated = true;
  };
  const dynamic = (from: string, line: number) => { if (graph.dynamic.length < 200) graph.dynamic.push({ from, line, reason: "Import target is computed at runtime" }); else graph.truncated = true; };
  for (const [path, source] of sources) {
    signal?.throwIfAborted(); const language = languageOf(path)!;
    if (!graph.languages.includes(language)) graph.languages.push(language);
    const dir = posix.dirname(path);
    if (language === "JavaScript/TypeScript") {
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        let value: ts.Expression | undefined, kind: ArchitectureEdge["kind"] = "static";
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) value = node.moduleReference.expression;
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) { value = node.arguments[0]; kind = "dynamic"; if (!value || !ts.isStringLiteralLike(value)) dynamic(path, file.getLineAndCharacterOfPosition(node.getStart()).line + 1); }
        if (value && ts.isStringLiteralLike(value)) {
          const specifier = value.text;
          const base = posix.normalize(posix.join(dir, specifier)), stem = base.replace(/\.[cm]?js$/, "");
          edge(path, specifier.startsWith(".") ? [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => stem + extension), ...["ts", "tsx", "js", "mjs"].map((extension) => `${base}/index.${extension}`)] : [], specifier, kind);
        }
        ts.forEachChild(node, visit);
      }; visit(file);
    } else if (language === "Python") {
      const module = (specifier: string) => {
        const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
        const module = specifier.slice(dots).replaceAll(".", "/");
        const base = dots ? posix.join(dir, ...Array(Math.max(0, dots - 1)).fill(".."), module) : module;
        edge(path, [`${base}.py`, `${base}/__init__.py`, `src/${base}.py`, `src/${base}/__init__.py`], specifier);
      };
      for (const line of source.split("\n")) {
        const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)/);
        if (from) { const base = from[1]!; const names = from[2]!.replace(/[()]/g, "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!).filter((name) => /^[A-Za-z_]\w*$/.test(name)); if (/^\.+$/.test(base) && names.length) for (const name of names) module(base + name); else module(base); }
        else { const imported = line.match(/^\s*import\s+(.+)/); if (imported) for (const name of imported[1]!.split(",")) { const value = name.trim().split(/\s+as\s+/)[0]!; if (/^[\w.]+$/.test(value)) module(value); } }
      }
      for (const match of source.matchAll(/(?:\b__import__|\bimportlib\.import_module)\s*\(\s*([^\n)]*)/g)) { const literal = match[1]!.match(/^["']([\w.]+)["']/); if (literal) module(literal[1]!); else dynamic(path, source.slice(0, match.index).split("\n").length); }
    } else if (language === "Go") {
      const declarations = [...source.matchAll(/^\s*import\s+(?:\(([\s\S]*?)\)|((?:\w+\s+|[._]\s+)?["`][^"`]+["`]))/gm)];
      for (const declaration of declarations) for (const match of (declaration[1] ?? declaration[2] ?? "").matchAll(/["`]([^"`]+)["`]/g)) {
        const specifier = match[1]!, own = goModules.filter((module) => specifier === module.name || specifier.startsWith(module.name + "/")).sort((a, b) => b.name.length - a.name.length)[0];
        const targetDir = own ? posix.normalize(posix.join(own.root, specifier.slice(own.name.length))) : undefined;
        const targets = targetDir ? graph.nodes.filter((node) => node.endsWith(".go") && posix.dirname(node) === targetDir && !node.endsWith("_test.go")) : [];
        if (targets.length) for (const target of targets) edge(path, [target], specifier); else edge(path, [], specifier);
      }
    } else if (language === "Rust") {
      for (const match of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) { const name = match[1]!, base = /\/(?:mod|lib|main)\.rs$/.test(`/${path}`) ? dir : path.slice(0, -3); edge(path, [`${base}/${name}.rs`, `${base}/${name}/mod.rs`], name, "module"); }
      for (const match of source.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|self|super)::)?([\w:]+)/gm)) { const prefix = match[1], name = match[2]!.split("::")[0]!; if (!prefix) edge(path, [], match[2]!); else { const rootDir = prefix === "crate::" ? (path.match(/^(.*?\/src)\//)?.[1] ?? "src") : prefix === "super::" ? posix.dirname(dir) : dir; edge(path, [`${rootDir}/${name}.rs`, `${rootDir}/${name}/mod.rs`], match[0]!.trim()); } }
    } else if (language === "Java") for (const match of source.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm)) { const name = match[1]!, target = java.get(name) ?? java.get(name.slice(0, name.lastIndexOf("."))); edge(path, target ? [target] : [], name); }
  }
  graph.edges = [...new Map(graph.edges.map((value) => [`${value.from}\0${value.to}\0${value.kind}`, value])).values()];
  const groups = new Map<string, ArchitectureGraph["components"][number]>();
  for (const path of graph.nodes) { const directory = posix.dirname(path); const component = groups.get(directory) ?? { directory, files: 0, incoming: 0, outgoing: 0 }; component.files++; groups.set(directory, component); }
  for (const edge of graph.edges) { const from = posix.dirname(edge.from), to = posix.dirname(edge.to); if (from !== to) { groups.get(from)!.outgoing++; groups.get(to)!.incoming++; } }
  graph.components = [...groups.values()].sort((a, b) => b.incoming + b.outgoing - a.incoming - a.outgoing || a.directory.localeCompare(b.directory));
  graph.cycles = strongComponents(graph.nodes, graph.edges).filter((group) => group.length > 1 || graph.edges.some((edge) => edge.from === group[0] && edge.to === group[0]));
  return redactExport(graph);
}

function readPackages(graph: ArchitectureGraph, path: string, source: string) {
  const add = (name: string, version: string, kind: string) => { if (graph.packages.length < 1000 && name.length <= 300) graph.packages.push({ manifest: path, name, version: version.slice(0, 200), kind }); else graph.truncated = true; };
  if (path.endsWith("package.json")) { try { const value = JSON.parse(source); for (const kind of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) if (value[kind] && typeof value[kind] === "object" && !Array.isArray(value[kind])) for (const [name, version] of Object.entries(value[kind])) if (typeof version === "string") add(name, version, kind); } catch { graph.unresolved.push({ from: path, specifier: "package.json", reason: "Invalid JSON manifest" }); } }
  else if (path.endsWith("go.mod")) { const module = source.match(/^\s*module\s+(\S+)/m)?.[1]; if (module) add(module, "", "module"); for (const match of source.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+(v[\w.+-]+)/gm)) add(match[1]!, match[2]!, "require"); }
  else if (path.endsWith("Cargo.toml")) { let section = ""; for (const line of source.split("\n")) { const heading = line.match(/^\s*\[([^\]]+)\]/); if (heading) section = heading[1]!; else if (/^(?:dev-|build-)?dependencies$/.test(section)) { const match = line.match(/^\s*([\w-]+)\s*=\s*(.+)/); if (match) add(match[1]!, match[2]!, section); } } }
  else if (/requirements[^/]*\.txt$/.test(path)) for (const line of source.split("\n")) { const match = line.match(/^\s*([A-Za-z0-9][\w.-]*)([^#]*)/); if (match && !line.trim().startsWith("-")) add(match[1]!, match[2]!.trim(), "requirement"); }
  else if (path.endsWith("pyproject.toml")) { const block = source.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1]; if (block) for (const match of block.matchAll(/["']([A-Za-z0-9][\w.-]*)([^"']*)["']/g)) add(match[1]!, match[2]!, "dependency"); }
  else if (path.endsWith("pom.xml")) for (const match of source.matchAll(/<dependency>\s*([\s\S]*?)<\/dependency>/g)) { const name = match[1]!.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1], group = match[1]!.match(/<groupId>([^<]+)<\/groupId>/)?.[1], version = match[1]!.match(/<version>([^<]+)<\/version>/)?.[1] ?? ""; if (name) add(`${group ?? ""}:${name}`, version, "dependency"); }
}
function strongComponents(nodes: string[], edges: ArchitectureEdge[]): string[][] {
  const adjacency = new Map(nodes.map((node) => [node, [] as string[]])); for (const edge of edges) adjacency.get(edge.from)!.push(edge.to);
  let index = 0; const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>(), groups: string[][] = [];
  const visit = (node: string) => { indices.set(node, index); low.set(node, index++); stack.push(node); active.add(node); for (const next of adjacency.get(node)!) { if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); } else if (active.has(next)) low.set(node, Math.min(low.get(node)!, indices.get(next)!)); } if (low.get(node) === indices.get(node)) { const group: string[] = []; let next: string; do { next = stack.pop()!; active.delete(next); group.push(next); } while (next !== node); groups.push(group.sort()); } };
  for (const node of nodes) if (!indices.has(node)) visit(node); return groups;
}
