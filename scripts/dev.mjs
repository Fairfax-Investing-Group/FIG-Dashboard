import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('Set up the backend first: python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt');
  process.exit(1);
}
const api = spawn(python, ['-m', 'server.app'], { cwd: root, stdio: 'inherit' });
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' });
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM');
  vite.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of [api, vite]) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
