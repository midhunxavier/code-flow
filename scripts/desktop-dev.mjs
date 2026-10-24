import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, ['scripts/package-macos.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync('open', [join(root, 'output/macos', process.arch, 'Code Flow.app')], { stdio: 'inherit' });
