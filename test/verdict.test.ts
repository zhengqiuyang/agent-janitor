import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, Fixture } from './helpers.js';
import { analyze } from '../src/plan.js';
import { loadConfig } from '../src/config.js';

interface SeedFixtureOptions {
  minAgeDays?: number;
  extraYaml?: string[];
}

function buildStandardFixture(label: string, opts: SeedFixtureOptions = {}): Fixture {
  const fx = createFixture(label);
  const yamlLines = [`minAgeDays: ${opts.minAgeDays ?? 14}`, 'protected:', '  - plans/keep-forever.plan.md'];
  if (opts.extraYaml) yamlLines.push(...opts.extraYaml);
  fx.write('agent-janitor.yaml', yamlLines.join('\n') + '\n');
  fx.write('plans/keep-forever.plan.md', 'must never be removed\n');
  fx.write('scripts/scratch-used.js', 'module.exports = {};\n');
  fx.write('src/app.ts', 'import { used } from "../scripts/scratch-used.js";\n');
  fx.write('plans/auth-refactor.plan.md', 'auth plan\n');
  fx.write('README.md', 'See plans/auth-refactor.plan.md for the auth rollout.\n');
  fx.write('plans/feature-x.plan.md', 'feature x plan\n');
  fx.write('scripts/scratch-old.py', 'print("old")\n');
  fx.commitAll('seed', 40);
  fx.write('src/other.js', 'feature x implementation\n');
  fx.commitAll('implement feature-x', 20);
  fx.write('scripts/scratch-new.py', 'print("new")\n');
  fx.write('HANDOFF-notes.md', 'handoff notes\n');
  fx.commitAll('add recent files', 1);
  fx.write('plans/fresh-idea.plan.md', 'brand new untracked plan\n');
  return fx;
}

function verdicts(fx: Fixture): Map<string, ReturnType<typeof analyze>['items'][number]> {
  const plan = analyze(fx.root, loadConfig(fx.root));
  return new Map(plan.items.map((it) => [it.path, it]));
}

test('verdict: file in the protected list is protected', () => {
  const fx = buildStandardFixture('verdict-protected');
  try {
    const it = verdicts(fx).get('plans/keep-forever.plan.md');
    assert.equal(it?.verdict, 'protected');
    assert.ok(it?.reason.includes('protected'));
  } finally {
    fx.dispose();
  }
});

test('verdict: scratch script referenced by code is keep', () => {
  const fx = buildStandardFixture('verdict-keep');
  try {
    const it = verdicts(fx).get('scripts/scratch-used.js');
    assert.equal(it?.verdict, 'keep');
    assert.equal(it?.evidence.codeRefs, 1);
    assert.deepEqual(it?.evidence.refExamples, ['src/app.ts:1']);
    assert.equal(it?.snapshot.refFiles[0], 'src/app.ts');
  } finally {
    fx.dispose();
  }
});

test('verdict: plan doc referenced from README is needs-review', () => {
  const fx = buildStandardFixture('verdict-review');
  try {
    const it = verdicts(fx).get('plans/auth-refactor.plan.md');
    assert.equal(it?.verdict, 'needs-review');
    assert.equal(it?.evidence.docRefs, 1);
    assert.equal(it?.evidence.refs, 1);
    assert.ok(it?.snapshot.refFiles.includes('README.md'));
  } finally {
    fx.dispose();
  }
});

test('verdict: old unreferenced plan doc with merged task is safe-to-remove', () => {
  const fx = buildStandardFixture('verdict-merged');
  try {
    const it = verdicts(fx).get('plans/feature-x.plan.md');
    assert.equal(it?.verdict, 'safe-to-remove');
    assert.equal(it?.evidence.taskMerged, 'implement feature-x');
    assert.equal(it?.evidence.refs, 0);
  } finally {
    fx.dispose();
  }
});

test('verdict: old unreferenced scratch script is safe-to-remove', () => {
  const fx = buildStandardFixture('verdict-safe');
  try {
    const it = verdicts(fx).get('scripts/scratch-old.py');
    assert.equal(it?.verdict, 'safe-to-remove');
    assert.ok((it?.evidence.ageDays ?? 0) >= 25);
    assert.equal(it?.evidence.taskMerged, undefined);
  } finally {
    fx.dispose();
  }
});

test('verdict: scratch script committed 1 day ago is recent', () => {
  const fx = buildStandardFixture('verdict-recent');
  try {
    const it = verdicts(fx).get('scripts/scratch-new.py');
    assert.equal(it?.verdict, 'recent');
    assert.ok((it?.evidence.ageDays ?? 99) <= 1);
  } finally {
    fx.dispose();
  }
});

test('verdict: recent HANDOFF doc is recent', () => {
  const fx = buildStandardFixture('verdict-handoff');
  try {
    const it = verdicts(fx).get('HANDOFF-notes.md');
    assert.equal(it?.verdict, 'recent');
  } finally {
    fx.dispose();
  }
});

test('verdict: untracked new plan is recent with the never-committed flag', () => {
  const fx = buildStandardFixture('verdict-untracked');
  try {
    const it = verdicts(fx).get('plans/fresh-idea.plan.md');
    assert.equal(it?.verdict, 'recent');
    assert.equal(it?.evidence.neverCommitted, true);
    assert.equal(it?.evidence.ageDays, 0);
    assert.equal(it?.evidence.lastCommit, null);
  } finally {
    fx.dispose();
  }
});

test('verdict: ordering - age gate (recent) precedes task-merged rule', () => {
  // With minAgeDays 90 the 40d-old feature-x plan is "recent" even though its
  // task merged, because the recent check runs before the task-merged check.
  const fx = buildStandardFixture('verdict-order', { minAgeDays: 90 });
  try {
    const items = verdicts(fx);
    assert.equal(items.get('plans/feature-x.plan.md')?.verdict, 'recent');
    assert.equal(items.get('scripts/scratch-old.py')?.verdict, 'recent');
    // Code references still win over the age gate.
    assert.equal(items.get('scripts/scratch-used.js')?.verdict, 'keep');
    // Protection wins over everything.
    assert.equal(items.get('plans/keep-forever.plan.md')?.verdict, 'protected');
  } finally {
    fx.dispose();
  }
});
