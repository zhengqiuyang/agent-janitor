import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFixture, findPlanFile, Fixture, todayStamp } from './helpers.js';

interface E2eFixture {
  fx: Fixture;
  planJson(): Record<string, unknown>;
  planPath(): string;
  dispose(): void;
}

function mustGet<T>(map: Map<string, T>, key: string): T {
  const v = map.get(key);
  if (v === undefined) throw new Error(`expected key in map: ${key}`);
  return v;
}

function buildE2eFixture(label: string): E2eFixture {
  const fx = createFixture(label);
  fx.write(
    'agent-janitor.yaml',
    ['minAgeDays: 14', 'protected:', '  - docs/architecture.md', 'categories:', '  custom:', '    include:', '      - docs/architecture.md', '']
      .join('\n'),
  );
  fx.write('docs/architecture.md', '# Architecture\n\nKeep or update me.\n');
  fx.write('README.md', 'Rollout is described in plans/auth-refactor.plan.md.\n');
  fx.write('plans/auth-refactor.plan.md', 'auth refactor plan\n');
  fx.write('plans/feature-x.plan.md', 'feature x plan\n');
  fx.write('scripts/scratch-cleanup.py', 'print("cleanup")\n');
  fx.write('scripts/scratch-keep.js', 'module.exports = {};\n');
  fx.write('src/legacy.ts', 'import { helper } from "../scripts/scratch-keep.js";\n');
  fx.commitAll('seed', 40);
  fx.write('src/feature.js', '// implementation\n');
  fx.commitAll('implement feature-x', 20);
  fx.write('HANDOFF-notes.md', 'handoff notes\n');
  fx.commitAll('add handoff', 1);
  fx.write('plans/fresh-idea.plan.md', 'brand new untracked plan\n');

  const planPath = (): string => findPlanFile(fx.root);
  const planJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(planPath(), 'utf8'));
  return { fx, planPath, planJson, dispose: () => fx.dispose() };
}

const EXPECTED_PATHS = [
  'HANDOFF-notes.md',
  'docs/architecture.md',
  'plans/auth-refactor.plan.md',
  'plans/feature-x.plan.md',
  'plans/fresh-idea.plan.md',
  'scripts/scratch-cleanup.py',
  'scripts/scratch-keep.js',
];

test('cli: scan table exit 0, no ANSI, all artifacts listed', () => {
  const { fx, dispose } = buildE2eFixture('e2e-scan');
  try {
    const res = fx.run(['scan', '.']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(!/\x1b\[/.test(res.stdout), 'no ANSI escapes in non-TTY output');
    assert.ok(res.stdout.includes('PATH'));
    assert.ok(res.stdout.includes('CATEGORY'));
    assert.ok(res.stdout.includes('VERDICT'));
    for (const p of EXPECTED_PATHS) assert.ok(res.stdout.includes(p), `expected ${p} in table`);
    assert.ok(res.stdout.includes('safe-to-remove'));
    assert.ok(res.stdout.includes('needs-review'));
    assert.ok(res.stdout.includes('keep'));
    assert.ok(res.stdout.includes('recent'));
    assert.ok(res.stdout.includes('protected'));
    assert.ok(res.stdout.includes('7 artifact(s)'));
    assert.ok(res.stdout.includes('(* never committed)'));
  } finally {
    dispose();
  }
});

test('cli: scan --format json is valid, complete, and evidence-backed', () => {
  const { fx, dispose } = buildE2eFixture('e2e-json');
  try {
    const res = fx.run(['scan', '.', '--format', 'json']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const data = JSON.parse(res.stdout);
    assert.equal(data.version, 1);
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
    assert.ok(
      String(data.root).toLowerCase() === fx.root.toLowerCase(),
      `plan root should equal fixture root: ${data.root} vs ${fx.root}`,
    );
    assert.equal(data.items.length, 7);
    const byPath = new Map<string, Record<string, any>>(data.items.map((it: any) => [it.path, it]));

    const feature = mustGet(byPath, 'plans/feature-x.plan.md');
    assert.equal(feature.verdict, 'safe-to-remove');
    assert.equal(feature.category, 'plan-docs');
    assert.equal(feature.evidence.taskMerged, 'implement feature-x');
    assert.equal(feature.evidence.refs, 0);
    assert.ok(typeof feature.snapshot.sha256 === 'string' && feature.snapshot.sha256.length === 64);

    const auth = mustGet(byPath, 'plans/auth-refactor.plan.md');
    assert.equal(auth.verdict, 'needs-review');
    assert.ok(auth.snapshot.refFiles.includes('README.md'));
    assert.deepEqual(auth.evidence.refExamples, ['README.md:1']);

    assert.equal(mustGet(byPath, 'scripts/scratch-keep.js').verdict, 'keep');
    assert.equal(mustGet(byPath, 'scripts/scratch-cleanup.py').verdict, 'safe-to-remove');
    assert.equal(mustGet(byPath, 'docs/architecture.md').verdict, 'protected');
    assert.equal(mustGet(byPath, 'docs/architecture.md').category, 'custom');

    const handoff = mustGet(byPath, 'HANDOFF-notes.md');
    assert.equal(handoff.verdict, 'recent');

    const fresh = mustGet(byPath, 'plans/fresh-idea.plan.md');
    assert.equal(fresh.verdict, 'recent');
    assert.equal(fresh.evidence.neverCommitted, true);

    assert.equal(data.summary['safe-to-remove'], 2);
    assert.equal(data.summary['needs-review'], 1);
    assert.equal(data.summary['recent'], 2);
    assert.equal(data.summary['keep'], 1);
    assert.equal(data.summary['protected'], 1);
  } finally {
    dispose();
  }
});

test('cli: plan writes JSON + cleanup-plan.md, grouped by verdict, exit 0', () => {
  const { fx, planPath, planJson, dispose } = buildE2eFixture('e2e-plan');
  try {
    const res = fx.run(['plan', '.']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('cleanup-plan.md'));
    assert.ok(res.stdout.includes('plan-'));
    assert.ok(res.stdout.includes('2 safe-to-remove'));

    const p = planPath();
    assert.ok(fs.existsSync(p));
    assert.ok(/plan-\d{8}-\d{6}\.json$/.test(path.basename(p)));
    const data = planJson();
    assert.equal(data.version, 1);
    assert.equal((data.items as unknown[]).length, 7);
    const summary = data.summary as Record<string, number>;
    assert.equal(summary['safe-to-remove'], 2);
    assert.equal(summary['recent'], 2);

    const md = fs.readFileSync(path.join(fx.root, '.agent-janitor', 'cleanup-plan.md'), 'utf8');
    assert.ok(md.includes('# agent-janitor cleanup plan'));
    assert.ok(md.includes('## safe-to-remove (2)'));
    assert.ok(md.includes('## needs-review (1)'));
    assert.ok(md.includes('## recent (2)'));
    assert.ok(md.includes('## keep (1)'));
    assert.ok(md.includes('## protected (1)'));
    assert.ok(md.includes('plans/feature-x.plan.md'));
    assert.ok(md.includes('implement feature-x'), 'task-merged evidence appears in the md');
    assert.ok(md.includes('README.md:1'));
  } finally {
    dispose();
  }
});

test('cli: verify-plan passes on a fresh plan (exit 0)', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-verify-fresh');
  try {
    fx.run(['plan', '.']);
    const res = fx.run(['verify-plan', planPath()]);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('7 fresh, 0 stale'));
  } finally {
    dispose();
  }
});

test('cli: verify-plan flags staleness when a reference appears (exit 1)', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-verify-stale');
  try {
    fx.run(['plan', '.']);
    fx.write('README.md', 'Rollout is described in plans/auth-refactor.plan.md.\nAlso see scripts/scratch-cleanup.py before running it.\n');
    fx.commitAll('document scratch cleanup', 5);
    const res = fx.run(['verify-plan', planPath()]);
    assert.equal(res.status, 1);
    assert.ok(res.stdout.includes('STALE'));
    assert.ok(res.stdout.includes('scripts/scratch-cleanup.py'));
    assert.ok(res.stdout.includes('new reference'));
    assert.ok(res.stdout.includes('6 fresh, 1 stale'));
  } finally {
    dispose();
  }
});

test('cli: apply --dry-run prints actions and moves nothing', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-dryrun');
  try {
    fx.run(['plan', '.']);
    const res = fx.run(['apply', '--plan', planPath(), '--mode', 'archive', '--dry-run']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('would archive: plans/feature-x.plan.md'));
    assert.ok(res.stdout.includes('would archive: scripts/scratch-cleanup.py'));
    assert.ok(!/\bwould archive: plans\/auth-refactor/.test(res.stdout));
    assert.ok(fs.existsSync(fx.abs('plans/feature-x.plan.md')));
    assert.ok(fs.existsSync(fx.abs('scripts/scratch-cleanup.py')));
    assert.ok(!fs.existsSync(fx.abs('.agent-janitor/archive')));
  } finally {
    dispose();
  }
});

test('cli: apply refuses plans older than 24h unless --fresh', () => {
  const { fx, planPath, planJson, dispose } = buildE2eFixture('e2e-fresh');
  try {
    fx.run(['plan', '.']);
    const p = planPath();
    const data = planJson();
    data.generatedAt = new Date(Date.now() - 25 * 3_600_000).toISOString();
    fs.writeFileSync(p, JSON.stringify(data, null, 2));

    const refused = fx.run(['apply', '--plan', p, '--mode', 'archive']);
    assert.equal(refused.status, 1);
    const combined = refused.stdout + refused.stderr;
    assert.ok(combined.includes('older than 24 hours'));
    assert.ok(combined.includes('--fresh'));
    assert.ok(fs.existsSync(fx.abs('plans/feature-x.plan.md')), 'nothing moved on refusal');

    const allowed = fx.run(['apply', '--plan', p, '--mode', 'archive', '--fresh']);
    assert.equal(allowed.status, 0, `stderr: ${allowed.stderr}`);
  } finally {
    dispose();
  }
});

test('cli: apply --mode archive relocates only safe-to-remove items via git mv', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-apply');
  try {
    const planned = fx.run(['plan', '.']);
    assert.equal(planned.status, 0);
    const p = planPath();
    const stamp = todayStamp();
    const archive = `.agent-janitor/archive/${stamp}`;

    const res = fx.run(['apply', '--plan', p, '--mode', 'archive']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('archive: plans/feature-x.plan.md ->'));
    assert.ok(res.stdout.includes('archive: scripts/scratch-cleanup.py ->'));
    assert.ok(res.stdout.includes('2 archived'));

    assert.ok(!fs.existsSync(fx.abs('plans/feature-x.plan.md')));
    assert.ok(!fs.existsSync(fx.abs('scripts/scratch-cleanup.py')));
    assert.ok(fs.existsSync(fx.abs(`${archive}/plans/feature-x.plan.md`)));
    assert.ok(fs.existsSync(fx.abs(`${archive}/scripts/scratch-cleanup.py`)));

    // Needs-review, keep, protected, recent are untouched.
    assert.ok(fs.existsSync(fx.abs('plans/auth-refactor.plan.md')));
    assert.ok(fs.existsSync(fx.abs('scripts/scratch-keep.js')));
    assert.ok(fs.existsSync(fx.abs('docs/architecture.md')));
    assert.ok(fs.existsSync(fx.abs('HANDOFF-notes.md')));
    assert.ok(fs.existsSync(fx.abs('plans/fresh-idea.plan.md')));

    const status = fx.git(['status', '--porcelain']);
    const lines = status.stdout.split('\n');
    assert.ok(
      lines.some((l) => l.startsWith('R  plans/feature-x.plan.md -> .agent-janitor/archive/')),
      `expected staged rename, got:\n${status.stdout}`,
    );
    assert.ok(
      lines.some((l) => l.startsWith('R  scripts/scratch-cleanup.py -> .agent-janitor/archive/')),
      `expected staged rename, got:\n${status.stdout}`,
    );
    assert.equal(lines.filter((l) => l.startsWith('R  ')).length, 2, 'exactly two renames staged');
  } finally {
    dispose();
  }
});

test('cli: re-applying a consumed plan skips missing files with exit 0', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-reapply');
  try {
    fx.run(['plan', '.']);
    const p = planPath();
    const first = fx.run(['apply', '--plan', p, '--mode', 'archive', '--fresh']);
    assert.equal(first.status, 0);
    const second = fx.run(['apply', '--plan', p, '--mode', 'archive', '--fresh']);
    assert.equal(second.status, 0);
    assert.ok(second.stdout.includes('not found in worktree'));
    assert.ok(second.stdout.includes('2 skipped'));
    assert.ok(second.stdout.includes('0 archived'));
  } finally {
    dispose();
  }
});

test('cli: apply --include-review additionally archives needs-review, never protected/keep', () => {
  const { fx, planPath, dispose } = buildE2eFixture('e2e-review');
  try {
    const first = fx.run(['plan', '.']);
    assert.equal(first.status, 0);
    const firstApply = fx.run(['apply', '--plan', planPath(), '--mode', 'archive', '--fresh']);
    assert.equal(firstApply.status, 0);

    const second = fx.run(['plan', '.']);
    assert.equal(second.status, 0);
    const p2 = planPath();

    const withoutReview = fx.run(['apply', '--plan', p2, '--mode', 'archive']);
    assert.equal(withoutReview.status, 0);
    assert.ok(withoutReview.stdout.includes('no eligible items in plan'));
    assert.ok(fs.existsSync(fx.abs('plans/auth-refactor.plan.md')));

    const withReview = fx.run(['apply', '--plan', p2, '--mode', 'archive', '--include-review']);
    assert.equal(withReview.status, 0, `stderr: ${withReview.stderr}`);
    assert.ok(withReview.stdout.includes('archive: plans/auth-refactor.plan.md ->'));
    assert.ok(withReview.stdout.includes('1 archived'));
    assert.ok(!fs.existsSync(fx.abs('plans/auth-refactor.plan.md')));
    assert.ok(fs.existsSync(fx.abs(`.agent-janitor/archive/${todayStamp()}/plans/auth-refactor.plan.md`)));
    // Protected and keep items are never eligible, even with --include-review.
    assert.ok(fs.existsSync(fx.abs('docs/architecture.md')));
    assert.ok(fs.existsSync(fx.abs('scripts/scratch-keep.js')));
  } finally {
    dispose();
  }
});

test('cli: apply --mode delete uses git rm and never touches protected items', () => {
  const fx = createFixture('e2e-delete');
  try {
    fx.write(
      'agent-janitor.yaml',
      ['protected:', '  - scripts/scratch-keepme.py', ''].join('\n'),
    );
    fx.write('scripts/scratch-gone.py', 'print("gone")\n');
    fx.write('scripts/scratch-keepme.py', 'print("keepme")\n');
    fx.write('README.md', 'plain\n');
    fx.commitAll('seed', 40);

    const planned = fx.run(['plan', '.']);
    assert.equal(planned.status, 0);
    const res = fx.run(['apply', '--plan', findPlanFile(fx.root), '--mode', 'delete']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('delete: scripts/scratch-gone.py'));
    assert.ok(res.stdout.includes('1 deleted'));
    assert.ok(!fs.existsSync(fx.abs('scripts/scratch-gone.py')));
    assert.ok(fs.existsSync(fx.abs('scripts/scratch-keepme.py')), 'protected item survives delete mode');
    assert.ok(!fs.existsSync(fx.abs('.agent-janitor/archive')), 'delete mode creates no archive');

    const status = fx.git(['status', '--porcelain']);
    assert.ok(status.stdout.split('\n').some((l) => l.startsWith('D  scripts/scratch-gone.py')));
  } finally {
    fx.dispose();
  }
});

test('cli: usage, version, unknown commands, and non-repo errors', () => {
  const { fx, dispose } = buildE2eFixture('e2e-misc');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aj-nonrepo-'));
  try {
    const help = fx.run(['--help']);
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('scan'));
    assert.ok(help.stdout.includes('verify-plan'));

    const version = fx.run(['--version']);
    assert.equal(version.status, 0);
    assert.ok(version.stdout.includes('0.1.0'));

    const noArgs = fx.run([]);
    assert.equal(noArgs.status, 2);

    const unknown = fx.run(['frobnicate']);
    assert.equal(unknown.status, 2);
    assert.ok((unknown.stdout + unknown.stderr).includes('unknown command'));

    const badFlag = fx.run(['scan', '.', '--format', 'xml']);
    assert.equal(badFlag.status, 2);
    assert.ok((badFlag.stdout + badFlag.stderr).includes('--format'));

    const nonRepo = fx.run(['scan', scratch]);
    assert.equal(nonRepo.status, 2);
    assert.ok((nonRepo.stdout + nonRepo.stderr).includes('not inside a git repository'));

    const applyNoPlan = fx.run(['apply']);
    assert.equal(applyNoPlan.status, 2);
    assert.ok((applyNoPlan.stdout + applyNoPlan.stderr).includes('--plan'));
  } finally {
    dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('cli: invalid config aborts with exit 2 and accumulated errors', () => {
  const fx = createFixture('e2e-badconfig');
  try {
    fx.write('README.md', 'x\n');
    fx.commitAll('seed', 5);
    fx.write('agent-janitor.yaml', ['minAgeDays: soon', 'protected: docs/x.md', ''].join('\n'));
    const res = fx.run(['scan', '.']);
    assert.equal(res.status, 2);
    const combined = res.stdout + res.stderr;
    assert.ok(combined.includes('invalid agent-janitor config'));
    assert.ok(combined.includes('"minAgeDays" must be a non-negative integer'));
    assert.ok(combined.includes('"protected" must be an array'));
  } finally {
    fx.dispose();
  }
});

test('cli: corrupted plan file is rejected with exit 2', () => {
  const fx = createFixture('e2e-badplan');
  try {
    fx.write('scripts/scratch-x.py', 'x\n');
    fx.commitAll('seed', 40);
    const bad = fx.abs('broken-plan.json');
    fs.writeFileSync(bad, '{"version": 99, "items": "nope"}', 'utf8');
    const res = fx.run(['verify-plan', bad]);
    assert.equal(res.status, 2);
    assert.ok((res.stdout + res.stderr).includes('invalid plan file'));

    const missing = fx.run(['verify-plan', fx.abs('does-not-exist.json')]);
    assert.equal(missing.status, 2);
    assert.ok((missing.stdout + missing.stderr).includes('plan file not found'));
  } finally {
    fx.dispose();
  }
});
