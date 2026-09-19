import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, Fixture } from './helpers.js';
import { ContentCache, findReferences } from '../src/refs.js';
import { filterScannable, listWorktreeFiles } from '../src/detect.js';

function scanFiles(fx: Fixture): string[] {
  return filterScannable(listWorktreeFiles(fx.root), '.agent-janitor/archive');
}

test('refs: doc reference, code reference, self-exclusion, binary skip', () => {
  const fx = createFixture('refs');
  try {
    fx.write('README.md', 'Rollout: see feature.plan.md for details.\n');
    fx.write('src/app.ts', 'import { x } from "./old-scratch.js";\n');
    fx.write('plans/feature.plan.md', 'This plan is feature.plan.md itself.\n');
    fx.write('scripts/old-scratch.js', '// scratch\n');
    fx.write('data.bin', 'BINARY\u0000feature.plan.md\u0000');
    fx.commitAll('seed', 40);
    const files = scanFiles(fx);
    const cache = new ContentCache(fx.root, files);

    const feature = findReferences(fx.root, 'plans/feature.plan.md', files, cache);
    assert.deepEqual(feature.refFiles, ['README.md'], 'self and binary files are not referrers');
    assert.equal(feature.total, 1);
    assert.equal(feature.docRefs, 1);
    assert.equal(feature.codeRefs, 0);
    assert.deepEqual(feature.examples, ['README.md:1']);

    const scratch = findReferences(fx.root, 'scripts/old-scratch.js', files, cache);
    assert.deepEqual(scratch.refFiles, ['src/app.ts']);
    assert.equal(scratch.codeRefs, 1);
    assert.deepEqual(scratch.examples, ['src/app.ts:1']);
  } finally {
    fx.dispose();
  }
});

test('refs: CRLF files are scanned and line numbers are correct', () => {
  const fx = createFixture('refs-crlf');
  try {
    fx.write('docs/guide.md', 'intro\r\nsecond\r\nsee notes.tmp.md for details\r\nmore\r\n');
    fx.write('notes.tmp.md', 'temp notes\n');
    fx.commitAll('seed', 40);
    const files = scanFiles(fx);
    const refs = findReferences(fx.root, 'notes.tmp.md', files);
    assert.deepEqual(refs.refFiles, ['docs/guide.md']);
    assert.deepEqual(refs.examples, ['docs/guide.md:3'], 'line number accounts for CRLF lines');
    assert.equal(refs.docRefs, 1);
  } finally {
    fx.dispose();
  }
});

test('refs: path mention counts even when basename alone is ambiguous', () => {
  const fx = createFixture('refs-path');
  try {
    fx.write('docs/usage.md', 'Run the copy living at scripts/nested/cleanup.tmp.py.\n');
    fx.write('scripts/nested/cleanup.tmp.py', 'print(1)\n');
    fx.commitAll('seed', 40);
    const files = scanFiles(fx);
    const refs = findReferences(fx.root, 'scripts/nested/cleanup.tmp.py', files);
    assert.deepEqual(refs.refFiles, ['docs/usage.md']);
  } finally {
    fx.dispose();
  }
});

test('refs: examples capped at 3, refFiles unbounded', () => {
  const fx = createFixture('refs-cap');
  try {
    fx.write('multi.txt', 'content\n');
    for (const n of ['r1.md', 'r2.md', 'r3.md', 'r4.md']) {
      fx.write(n, 'multi.txt is described here.\n');
    }
    fx.commitAll('seed', 40);
    const files = scanFiles(fx);
    const refs = findReferences(fx.root, 'multi.txt', files);
    assert.equal(refs.total, 4);
    assert.deepEqual(refs.refFiles, ['r1.md', 'r2.md', 'r3.md', 'r4.md']);
    assert.equal(refs.examples.length, 3);
    assert.deepEqual(refs.examples, ['r1.md:1', 'r2.md:1', 'r3.md:1']);
  } finally {
    fx.dispose();
  }
});

test('refs: prose mention of a .tmp.md file is a doc reference (precision case)', () => {
  const fx = createFixture('refs-precision');
  try {
    fx.write('notes.tmp.md', 'scratch content\n');
    fx.write('docs/overview.md', 'see notes.tmp.md for details\n');
    fx.commitAll('seed', 40);
    const files = scanFiles(fx);
    const refs = findReferences(fx.root, 'notes.tmp.md', files);
    assert.equal(refs.total, 1);
    assert.equal(refs.docRefs, 1);
    assert.equal(refs.codeRefs, 0);
  } finally {
    fx.dispose();
  }
});
