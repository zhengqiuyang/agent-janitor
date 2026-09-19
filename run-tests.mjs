// Portable test launcher: enumerates dist/test/*.test.js itself and passes
// explicit files to `node --test` (glob arguments would need Node 21+).
// Build is expected to have run first (`npm test` builds before invoking this).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(projectRoot, 'dist', 'test');

let files;
try {
  files = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(testDir, f))
    .sort();
} catch {
  console.error('run-tests: cannot read dist/test - did the build run? (`npm run build`)');
  process.exit(1);
}

if (files.length === 0) {
  console.error('run-tests: no *.test.js files found in dist/test');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(res.status ?? 1);
