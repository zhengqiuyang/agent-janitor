import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, Fixture } from './helpers.js';
import { findTaskMerged, getFileGitMeta, planStems } from '../src/gitmeta.js';

test('gitmeta: ageDays and lastCommit come from the last commit touching the file', () => {
  const fx = createFixture('meta-age');
  try {
    fx.write('plans/feature-x.plan.md', 'the plan\n');
    fx.write('filler.txt', 'one\n');
    fx.commitAll('add plans', 30);
    fx.write('filler2.txt', 'two\n');
    fx.commitAll('more work', 10);
    const meta = getFileGitMeta(fx.root, 'plans/feature-x.plan.md');
    assert.equal(meta.neverCommitted, false);
    assert.ok(meta.ageDays >= 29 && meta.ageDays <= 31, `ageDays ~30, got ${meta.ageDays}`);
    assert.equal(meta.lastCommit?.subject, 'add plans');
    assert.equal(meta.lastCommit?.hash.length, 40);
    assert.equal(meta.lastCommit?.short.length, 12);
    assert.ok(meta.lastCommit?.date.endsWith('Z'));
  } finally {
    fx.dispose();
  }
});

test('gitmeta: never-committed (untracked) files get ageDays 0 and the flag', () => {
  const fx = createFixture('meta-untracked');
  try {
    fx.write('committed.txt', 'x\n');
    fx.commitAll('seed', 5);
    fx.write('plans/fresh.plan.md', 'untracked\n');
    const meta = getFileGitMeta(fx.root, 'plans/fresh.plan.md');
    assert.equal(meta.neverCommitted, true);
    assert.equal(meta.ageDays, 0);
    assert.equal(meta.lastCommit, null);
  } finally {
    fx.dispose();
  }
});

test('gitmeta: recent commit produces ageDays 0 or 1', () => {
  const fx = createFixture('meta-recent');
  try {
    fx.write('scripts/scratch-recent.py', 'x\n');
    fx.commitAll('add scratch', 1);
    const meta = getFileGitMeta(fx.root, 'scripts/scratch-recent.py');
    assert.ok(meta.ageDays <= 1, `expected 0 or 1, got ${meta.ageDays}`);
  } finally {
    fx.dispose();
  }
});

test('gitmeta: task-merged matches commit message case-insensitively when reachable from HEAD', () => {
  const fx = createFixture('meta-merged');
  try {
    fx.write('plans/feature-x.plan.md', 'the plan\n');
    fx.commitAll('add plans', 30);
    fx.write('src/thing.js', 'x\n');
    fx.commitAll('Implement FEATURE-X now', 20);
    fx.write('filler2.txt', 'x\n');
    fx.commitAll('more work', 10);
    assert.equal(findTaskMerged(fx.root, planStems('plans/feature-x.plan.md')), 'Implement FEATURE-X now');
  } finally {
    fx.dispose();
  }
});

test('gitmeta: task-merged ignores commits on abandoned (unreachable) branches', () => {
  const fx = createFixture('meta-abandoned');
  try {
    fx.write('plans/feature-y.plan.md', 'the plan\n');
    fx.commitAll('add planning docs', 30);
    fx.git(['switch', '-c', 'side-branch']);
    fx.write('scratch.txt', 'branch work\n');
    fx.commitAll('implement feature-y', 15);
    fx.git(['switch', 'main']);
    assert.equal(findTaskMerged(fx.root, planStems('plans/feature-y.plan.md')), null, 'commit is not an ancestor of HEAD');
  } finally {
    fx.dispose();
  }
});

test('gitmeta: findTaskMerged returns null for empty stems and unknown names', () => {
  const fx = createFixture('meta-none');
  try {
    fx.write('a.txt', 'x\n');
    fx.commitAll('seed', 5);
    assert.equal(findTaskMerged(fx.root, ['   ']), null);
    assert.equal(findTaskMerged(fx.root, ['no-such-stem-xyz']), null);
  } finally {
    fx.dispose();
  }
});

test('gitmeta: planStems offers the specific and the .plan-stripped stem', () => {
  assert.deepEqual(planStems('plans/feature-x.plan.md'), ['feature-x.plan', 'feature-x']);
  assert.deepEqual(planStems('PLAN.md'), ['PLAN']);
  assert.deepEqual(planStems('a/b/no-ext'), ['no-ext']);
  assert.deepEqual(planStems('a/b/.plan.md'), ['.plan'], 'dotfiles keep their leading dot');
  assert.deepEqual(planStems('plans/auth.md'), ['auth']);
});
