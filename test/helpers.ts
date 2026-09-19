import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compiled CLI entry, relative to this compiled helper in dist/test/. */
export const CLI_JS = fileURLToPath(new URL('../src/cli.js', import.meta.url));

export interface CmdResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Fixture {
  root: string;
  /** Absolute path for a repo-relative posix path. */
  abs(rel: string): string;
  write(rel: string, content: string): void;
  remove(rel: string): void;
  git(args: string[], opts?: { env?: Record<string, string> }): CmdResult;
  commitAll(message: string, daysAgo?: number, hourUtc?: number): void;
  /** Run the compiled CLI with cwd = fixture root (isolated git env, NO_COLOR). */
  run(args: string[]): CmdResult;
  dispose(): void;
}

let fixtureCounter = 0;

/**
 * Format a git committer/author date `daysAgo` days in the past, pinned to
 * hourUtc:00 UTC so age computations are stable regardless of when tests run.
 */
export function gitDate(daysAgo: number, hourUtc = 12): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:00:00 +0000`
  );
}

export function createFixture(label: string): Fixture {
  fixtureCounter++;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `aj-${label}-${fixtureCounter}-`));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const globalCfg = path.join(base, 'gitconfig');
  fs.writeFileSync(globalCfg, '');

  const baseEnv: Record<string, string> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalCfg,
    NO_COLOR: '1',
  };

  const git = (args: string[], opts: { env?: Record<string, string> } = {}): CmdResult => {
    const res = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
      cwd: root,
      env: { ...baseEnv, ...(opts.env ?? {}) },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) throw new Error(`git failed to spawn: ${res.error.message}`);
    return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };

  const init = git(['init', '-b', 'main']);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  // Repo-local identity + safety config: no dependence on any global/system git config.
  git(['config', 'user.email', 'janitor@example.com']);
  git(['config', 'user.name', 'Janitor Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);

  const abs = (rel: string) => path.join(root, ...rel.split('/'));

  const fixture: Fixture = {
    root,
    abs,
    write(rel: string, content: string) {
      const target = abs(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
    remove(rel: string) {
      fs.rmSync(abs(rel), { recursive: true, force: true });
    },
    git,
    commitAll(message: string, daysAgo = 30, hourUtc = 12) {
      const date = gitDate(daysAgo, hourUtc);
      const add = git(['add', '-A']);
      if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
      const c = git(['commit', '-m', message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
      if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr}`);
    },
    run(args: string[]): CmdResult {
      const res = spawnSync(process.execPath, [CLI_JS, ...args], {
        cwd: root,
        env: baseEnv,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      if (res.error) throw new Error(`cli failed to spawn: ${res.error.message}`);
      return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    },
    dispose() {
      // Best effort; git object files can be read-only on Windows.
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* ignore */
      }
    },
  };
  return fixture;
}

/** Latest generated plan-<stamp>.json inside <root>/.agent-janitor/. */
export function findPlanFile(root: string): string {
  const dir = path.join(root, '.agent-janitor');
  const names = fs
    .readdirSync(dir)
    .filter((n) => /^plan-\d{8}-\d{6}\.json$/.test(n))
    .sort();
  if (names.length === 0) throw new Error('no plan file generated');
  return path.join(dir, names[names.length - 1]);
}

/** yyyyMMdd in local time, matching the CLI's archive stamp. */
export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
