import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { prepareDockerDesktop } from './prepare-desktop-docker.mjs';
const { root, desktop } = await prepareDockerDesktop();
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [desktop], { env: { ...process.env, CODEFLOW_DESKTOP_DOCKER: '1', CODEFLOW_DESKTOP_DATA: process.env.CODEFLOW_DESKTOP_DATA || join(root, 'output/windows/dev-ui') }, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
