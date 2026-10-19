// No project code, configuration, plugins or external files are executed or loaded here.
import { parentPort, workerData } from 'node:worker_threads';
import ts from 'typescript';
import { dirname, relative } from 'node:path';

const { root } = workerData;
const files = new Map();
let revision = 0;
const options = { allowJs: true, checkJs: false, noLib: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
const host = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...files.keys()],
  getScriptVersion: (name) => String(files.get(name)?.version ?? 0),
  getProjectVersion: () => String(revision),
  getScriptSnapshot: (name) => files.has(name) ? ts.ScriptSnapshot.fromString(files.get(name).text) : undefined,
  getCurrentDirectory: () => root,
  getDefaultLibFileName: () => '/__codeflow_no_external_lib__.d.ts',
  fileExists: (name) => files.has(name),
  readFile: (name) => files.get(name)?.text,
  readDirectory: () => [...files.keys()],
  directoryExists: (name) => [...files.keys()].some((file) => dirname(file) === name),
  getDirectories: () => [],
  useCaseSensitiveFileNames: () => true,
};
const service = ts.createLanguageService(host);
function location(fileName, span, extras = {}) {
  const file = files.get(fileName); if (!file) return;
  const source = service.getProgram()?.getSourceFile(fileName); if (!source) return;
  const { line, character } = source.getLineAndCharacterOfPosition(span.start);
  const starts = source.getLineStarts();
  const text = file.text.slice(starts[line], Math.min(starts[line] + 500, starts[line + 1] ?? file.text.length)).replace(/[\r\n]+$/, '');
  return { path: relative(root, fileName).replaceAll('\\', '/'), line: line + 1, column: character + 1, text, ...extras };
}
parentPort.on('message', ({ sources, removed, request }) => {
try {
  revision++;
  for (const name of removed) files.delete(name);
  for (const file of sources) files.set(file.absolute, { ...file, version: revision });
  let hits = [], total = 0;
  if (request.kind === 'symbols') {
    const items = service.getNavigateToItems(request.query, 201, undefined, true);
    total = items.length;
    hits = items.slice(0, 200).map((item) => location(item.fileName, item.textSpan, { symbol: item.name, kind: item.kind })).filter(Boolean);
  } else {
    const file = files.get(request.file);
    if (!file) throw new Error('Choose an inspected JavaScript or TypeScript file');
    const source = service.getProgram()?.getSourceFile(request.file);
    if (!source) throw new Error('Could not parse the selected source file');
    const starts = source.getLineStarts();
    const start = starts[request.line - 1];
    const end = starts[request.line] ?? source.text.length;
    if (start === undefined || start + request.column - 1 >= end) throw new Error('Choose a valid one-based line and UTF-16 column in the saved file');
    const position = start + request.column - 1;
    const seen = new Set();
    for (const group of service.findReferences(request.file, position) ?? []) for (const ref of group.references) {
      const key = `${ref.fileName}:${ref.textSpan.start}`; if (seen.has(key)) continue; seen.add(key); total++;
      if (hits.length < 200) { const hit = location(ref.fileName, ref.textSpan, { kind: 'reference', definition: !!ref.isDefinition, write: !!ref.isWriteAccess }); if (hit) hits.push(hit); }
    }
  }
  parentPort.postMessage({ hits, truncated: total > 200, engine: `TypeScript language service ${ts.version}`, note: 'Symbols and references cover bounded saved JavaScript/TypeScript sources. External libraries, project plugins, generated output and credential selections are not loaded.' });
} catch (error) { parentPort.postMessage({ error: error.message }); }
});
parentPort.on("close", () => service.dispose());
