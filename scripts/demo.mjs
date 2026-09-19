#!/usr/bin/env node
// End-to-end demo: builds a fixture repo in os.tmpdir(), then runs
// scan -> plan -> verify-plan -> apply --mode archive -> rescan, printing
// every output. Cleans up after itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(projectRoot, 'dist', 'src', 'cli.js');

if (!fs.existsSync(cli)) {
  console.error('demo: dist/src/cli.js not found - run "npm run build" first.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-janitor-demo-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);

const globalCfg = path.join(tmp, 'gitconfig');
fs.writeFileSync(globalCfg, '');

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: globalCfg,
};

const gitDate = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} 12:00:00 +0000`;
};

function git(args, extraEnv = {}) {
  const res = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: repo,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    console.error(`demo: git ${args.join(' ')} failed:\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout;
}

function commit(message, daysAgo) {
  const date = { GIT_AUTHOR_DATE: gitDate(daysAgo), GIT_COMMITTER_DATE: gitDate(daysAgo) };
  git(['add', '-A']);
  git(['commit', '-m', message], date);
}

function section(title) {
  console.log('');
  console.log(`=== ${title} ===`);
}

function runCli(args) {
  section(`$ agent-janitor ${args.join(' ')}`);
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`demo: agent-janitor ${args.join(' ')} exited with ${res.status}`);
    process.exit(1);
  }
  return res;
}

function write(rel, content) {
  const abs = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

try {
  // ---- fixture repo -------------------------------------------------------
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'janitor@example.com']);
  git(['config', 'user.name', 'Demo Janitor']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);

  write('agent-janitor.yaml', [
    'minAgeDays: 14',
    'protected:',
    '  - docs/architecture.md',
    'categories:',
    '  custom:',
    '    include:',
    '      - docs/architecture.md',
    '',
  ].join('\n'));
  write('docs/architecture.md', '# Architecture\n\nThis doc is protected in agent-janitor.yaml.\n');
  write('README.md', 'Rollout is described in plans/auth-refactor.plan.md.\n');
  write('plans/auth-refactor.plan.md', '# Auth refactor plan\n\nStill referenced from the README.\n');
  write('plans/feature-x.plan.md', '# Feature X plan\n\nDone and merged; nobody links to this file.\n');
  write('scripts/scratch-cleanup.py', 'print("temporary migration helper")\n');
  write('scripts/scratch-keep.js', 'module.exports = {};\n');
  write('src/legacy.ts', 'import { helper } from "../scripts/scratch-keep.js";\n');
  git(['add', '-A']);
  commit('seed repo with agent artifacts', 40);

  write('src/feature.js', '// the actual feature x implementation\n');
  commit('implement feature-x', 20);

  write('HANDOFF-notes.md', '# Handoff\n\nWritten yesterday by the nightly agent.\n');
  commit('add handoff notes', 1);

  console.log('agent-janitor demo');
  console.log(`fixture repo: ${repo}`);
  console.log('(seeded with plan docs, a handoff, scratch scripts, code references, and protected paths)');

  // ---- the workflow -------------------------------------------------------
  runCli(['scan', repo]);
  runCli(['plan', repo]);

  const planDir = path.join(repo, '.agent-janitor');
  const planFile = fs
    .readdirSync(planDir)
    .filter((n) => /^plan-\d{8}-\d{6}\.json$/.test(n))
    .sort()
    .pop();
  runCli(['verify-plan', path.join(planDir, planFile)]);

  runCli(['apply', '--plan', path.join(planDir, planFile), '--mode', 'archive']);

  section('$ git status --porcelain');
  console.log(git(['status', '--porcelain']));

  runCli(['scan', repo]);

  const moved = fs.existsSync(path.join(repo, '.agent-janitor', 'archive')) &&
    !fs.existsSync(path.join(repo, 'plans', 'feature-x.plan.md')) &&
    !fs.existsSync(path.join(repo, 'scripts', 'scratch-cleanup.py'));
  const survivors =
    fs.existsSync(path.join(repo, 'plans', 'auth-refactor.plan.md')) &&
    fs.existsSync(path.join(repo, 'scripts', 'scratch-keep.js')) &&
    fs.existsSync(path.join(repo, 'docs', 'architecture.md'));

  section('result');
  if (moved && survivors) {
    console.log('ok: safe-to-remove items were archived under .agent-janitor/archive/,');
    console.log('    needs-review/keep/protected/recent items were left untouched.');
  } else {
    console.error('demo: unexpected end state');
    process.exitCode = 1;
  }
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // best effort on Windows (read-only git objects)
  }
}
