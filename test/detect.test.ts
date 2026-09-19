import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, Fixture } from './helpers.js';
import { detectArtifacts, detectFromFiles, filterScannable, listWorktreeFiles, matchGlob } from '../src/detect.js';
import { loadConfig } from '../src/config.js';

const SEED_FILES: Array<[string, string]> = [
  ['.agents/plans/p1.md', 'agent plans'],
  ['.claude/plans/p2.md', 'claude plans'],
  ['.handoff/h1.md', 'handoff dir'],
  ['PLAN.md', 'root plan'],
  ['PLAN-v2.md', 'root plan v2'],
  ['HANDOFF.md', 'root handoff'],
  ['docs/plans/p4.md', 'docs plan'],
  ['feature.plan.md', 'dot plan at root'],
  ['nested/feature2.plan.md', 'dot plan nested'],
  ['plans/p3.md', 'plan'],
  ['plans/keep.md', 'keep me'],
  ['sub/HANDOFF-auth.md', 'handoff nested'],
  ['scripts/scratch-migrate.py', 'print("hi")'],
  ['tmp.js', 'module.exports = 1;'],
  ['one-off.sh', 'echo hi'],
  ['my.temp.ts', 'export {};'],
  ['throwaway.ps1', 'Write-Output "hi"'],
  ['tools/temp.cmd', 'echo hi'],
  ['deep/oneoff.cjs', 'exports.x = 1;'],
  ['scratchy.js', 'not a scratch file'],
  ['mytemplate.ts', 'not scratch either'],
  ['notes/scratch.md', 'markdown scratch is not a script'],
  ['notes/scratch.txt', 'text scratch is not a script'],
  ['node_modules/tmp.js', 'dependency file'],
  ['.agent-janitor/plans/old.plan.md', 'janitor plumbing'],
  ['README.md', 'readme'],
];

const EXPECTED_PLAN_DOCS = [
  '.agents/plans/p1.md',
  '.claude/plans/p2.md',
  '.handoff/h1.md',
  'HANDOFF.md',
  'PLAN-v2.md',
  'PLAN.md',
  'docs/plans/p4.md',
  'feature.plan.md',
  'nested/feature2.plan.md',
  'plans/keep.md',
  'plans/p3.md',
  'sub/HANDOFF-auth.md',
];

const EXPECTED_SCRATCH = [
  'deep/oneoff.cjs',
  'my.temp.ts',
  'one-off.sh',
  'scripts/scratch-migrate.py',
  'throwaway.ps1',
  'tmp.js',
  'tools/temp.cmd',
];

test('detect: built-in plan-doc and scratch-script conventions', () => {
  const fx: Fixture = createFixture('detect');
  try {
    for (const [rel, content] of SEED_FILES) fx.write(rel, content);
    fx.commitAll('seed', 40);
    const artifacts = detectArtifacts(fx.root, loadConfig(fx.root));
    const paths = artifacts.map((a) => a.path).sort();
    assert.deepEqual(paths, [...EXPECTED_PLAN_DOCS, ...EXPECTED_SCRATCH].sort());
    for (const a of artifacts) {
      if (EXPECTED_PLAN_DOCS.includes(a.path)) assert.equal(a.category, 'plan-docs', a.path);
      if (EXPECTED_SCRATCH.includes(a.path)) assert.equal(a.category, 'scratch-scripts', a.path);
      assert.ok(a.matchedBy.length > 0, `matchedBy set for ${a.path}`);
    }
  } finally {
    fx.dispose();
  }
});

test('detect: near-miss names are not scratch scripts', () => {
  const fx = createFixture('detect-nearmiss');
  try {
    fx.write('scratchy.js', 'x');
    fx.write('mytemplate.ts', 'x');
    fx.write('notes/scratch.md', 'x');
    fx.write('notes/scratch.txt', 'x');
    fx.write('container.go', 'x');
    fx.write('attic.rs', 'x');
    fx.commitAll('seed', 40);
    const artifacts = detectArtifacts(fx.root, loadConfig(fx.root));
    assert.deepEqual(artifacts.map((a) => a.path), []);
  } finally {
    fx.dispose();
  }
});

test('detect: node_modules, .git and .agent-janitor are always excluded', () => {
  const fx = createFixture('detect-exclude');
  try {
    fx.write('node_modules/tmp.js', 'x');
    fx.write('.agent-janitor/plans/old.plan.md', 'x');
    fx.write('keep.js', 'x');
    fx.commitAll('seed', 40);
    const files = filterScannable(listWorktreeFiles(fx.root), '.agent-janitor/archive');
    assert.ok(files.includes('keep.js'));
    assert.ok(!files.includes('node_modules/tmp.js'));
    assert.ok(!files.includes('.agent-janitor/plans/old.plan.md'));
    assert.ok(!files.some((f) => f.startsWith('.git/')));
  } finally {
    fx.dispose();
  }
});

test('detect: config include/exclude per category (custom category)', () => {
  const fx = createFixture('detect-config');
  try {
    fx.write('plans/p3.md', 'plan');
    fx.write('plans/keep.md', 'keep me');
    fx.write('notes/scratch.md', 'note scratch');
    fx.write('notes/scratch.txt', 'note scratch txt');
    fx.write('README.md', 'readme');
    fx.commitAll('seed', 40);
    fx.write(
      'agent-janitor.yaml',
      [
        'categories:',
        '  plan-docs:',
        '    exclude:',
        '      - plans/keep.md',
        '  custom:',
        '    include:',
        '      - "notes/**"',
        '    exclude:',
        '      - notes/scratch.txt',
        '',
      ].join('\n'),
    );
    const config = loadConfig(fx.root);
    const artifacts = detectArtifacts(fx.root, config);
    const byPath = new Map(artifacts.map((a) => [a.path, a]));
    assert.ok(!byPath.has('plans/keep.md'), 'excluded plan-doc is not detected');
    assert.ok(!byPath.has('notes/scratch.txt'), 'excluded custom is not detected');
    assert.equal(byPath.get('plans/p3.md')?.category, 'plan-docs');
    assert.equal(byPath.get('plans/p3.md')?.matchedBy, 'plans/**');
    assert.equal(byPath.get('notes/scratch.md')?.category, 'custom');
    assert.equal(byPath.get('notes/scratch.md')?.matchedBy, 'notes/**');
  } finally {
    fx.dispose();
  }
});

test('glob: gitignore-style anchoring and ** semantics', () => {
  assert.ok(matchGlob('**/*.plan.md', 'x.plan.md'));
  assert.ok(matchGlob('**/*.plan.md', 'a/b/x.plan.md'));
  assert.ok(!matchGlob('**/*.plan.md', 'myplan.md'));
  assert.ok(matchGlob('plans/**', 'plans/a.md'));
  assert.ok(matchGlob('plans/**', 'plans/sub/a.md'));
  assert.ok(!matchGlob('plans/**', 'planning/a.md'));
  assert.ok(!matchGlob('plans/**', 'plans'));
  assert.ok(matchGlob('PLAN*.md', 'PLAN.md'));
  assert.ok(matchGlob('PLAN*.md', 'PLAN-v2.md'));
  assert.ok(matchGlob('PLAN*.md', 'packages/foo/PLAN.md'), 'slash-less globs match at any depth');
  assert.ok(!matchGlob('PLAN*.md', 'plan.md'));
  assert.ok(matchGlob('docs/plans/**', 'docs/plans/a/b.md'));
  assert.ok(!matchGlob('docs/plans/**', 'docs/guides/a.md'));
  assert.ok(matchGlob('**', 'anything/at/all.md'));
  assert.ok(matchGlob('a/**/b.md', 'a/b.md'), '** matches zero segments');
  assert.ok(matchGlob('a/**/b.md', 'a/x/y/b.md'));
  assert.ok(matchGlob('.handoff/**', '.handoff/notes/x.md'));
  assert.ok(matchGlob('*.md', 'sub/x.md'), 'slash-less globs match at any depth');
});

test('detect: detectFromFiles is idempotent about exclusions', () => {
  const detected = detectFromFiles(['.agent-janitor/x.plan.md', 'node_modules/tmp.js', 'plans/a.md'], loadConfig('/nonexistent'));
  assert.deepEqual(detected.map((d) => d.path), ['plans/a.md']);
});
