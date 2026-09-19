import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, validateConfig, DEFAULT_CONFIG } from '../src/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aj-config-'));
}

function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('config: defaults when no config file exists (zero-config operation)', () => {
  const dir = tmpDir();
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.minAgeDays, 14);
    assert.equal(cfg.archiveDir, '.agent-janitor/archive');
    assert.deepEqual(cfg.protected, []);
    assert.deepEqual(cfg.categories['plan-docs'], {});
    assert.deepEqual(cfg.categories.custom, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: empty config file means defaults', () => {
  const dir = tmpDir();
  try {
    write(dir, 'agent-janitor.yaml', '');
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg, { ...DEFAULT_CONFIG, categories: cfg.categories });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: valid values are parsed and normalized', () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      'agent-janitor.yaml',
      [
        'minAgeDays: 30',
        'archiveDir: .state/archive',
        'protected:',
        '  - docs/architecture.md',
        '  - plans/keep/**',
        'categories:',
        '  plan-docs:',
        '    include:',
        '      - "notes/**/*.plan.md"',
        '    exclude:',
        '      - plans/keep-this.md',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    assert.equal(cfg.minAgeDays, 30);
    assert.equal(cfg.archiveDir, '.state/archive');
    assert.deepEqual(cfg.protected, ['docs/architecture.md', 'plans/keep/**']);
    assert.deepEqual(cfg.categories['plan-docs']?.include, ['notes/**/*.plan.md']);
    assert.deepEqual(cfg.categories['plan-docs']?.exclude, ['plans/keep-this.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: validation errors are accumulated, not fail-fast', () => {
  const dir = tmpDir();
  try {
    write(
      dir,
      'agent-janitor.yaml',
      [
        'minAgeDays: soon',
        'archiveDir: /absolute/path',
        'protected: docs/x.md',
        'mystery: true',
        'categories:',
        '  typo-cat:',
        '    include: ["a/**"]',
        '  plan-docs:',
        '    nope: 1',
        '',
      ].join('\n'),
    );
    let err: ConfigError | null = null;
    try {
      loadConfig(dir);
    } catch (e) {
      err = e as ConfigError;
    }
    assert.ok(err instanceof ConfigError, 'expected ConfigError');
    const all = err.errors.join('\n');
    for (const fragment of [
      '"minAgeDays" must be a non-negative integer',
      '"archiveDir" must be a relative path',
      '"protected" must be an array',
      'unknown top-level key "mystery"',
      'unknown category "typo-cat"',
      'unknown key "categories.plan-docs.nope"',
    ]) {
      assert.ok(all.includes(fragment), `expected error fragment: ${fragment}`);
    }
    assert.ok(err.errors.length >= 6, `expected >=6 accumulated errors, got ${err.errors.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: explicit --config path that does not exist is an error', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => loadConfig(dir, 'missing.yaml'), ConfigError);
    // The default path being absent is fine (defaults apply).
    assert.doesNotThrow(() => loadConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: YAML syntax errors produce a clean ConfigError', () => {
  const dir = tmpDir();
  try {
    write(dir, 'agent-janitor.yaml', 'minAgeDays: [unclosed\n  bad');
    assert.throws(
      () => loadConfig(dir),
      (e: unknown) => e instanceof ConfigError && e.errors.some((m) => m.includes('YAML parse error')),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: archiveDir with ".." is rejected', () => {
  const dir = tmpDir();
  try {
    assert.throws(
      () => validateConfig({ archiveDir: '../outside' }, 'test'),
      (e: unknown) => e instanceof ConfigError && e.errors.some((m) => m.includes('archiveDir')),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
