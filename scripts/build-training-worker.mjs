import './check-node.mjs';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildTrainingWorker(output = resolve(root, 'dist/training-worker.json')) {
  const built = await build({ absWorkingDir: root, entryPoints: ['src/training-worker/main.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22.13', write: false, logLevel: 'warning' });
  const files = { 'worker.mjs': built.outputFiles[0].text };
  for (const name of ['recipe.py', 'predict.py', 'requirements.txt']) files[name] = await readFile(resolve(root, 'training/recipes/tabular-autogluon', name), 'utf8');
  for (const [name, source] of Object.entries({ 'llm_recipe.py': 'recipe.py', 'llm_predict.py': 'predict.py', 'llm_requirements.txt': 'requirements.txt' })) files[name] = await readFile(resolve(root, 'training/recipes/llm-sft-lora', source), 'utf8');
  files["inference.py"] = await readFile(resolve(root, "training/inference.py"), "utf8");
  files["holdout.py"] = await readFile(resolve(root, "training/holdout.py"), "utf8");
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  await mkdir(dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify({ protocol: 1, version, files }));
  await rename(temporary, output);
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildTrainingWorker(process.argv[2]);
