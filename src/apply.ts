import fs from 'node:fs';
import path from 'node:path';
import { Config, ConfigError, loadConfig } from './config.js';
import { git, isGitRepository } from './git.js';
import { readPlanFile } from './plan.js';
import { isProtectedPath } from './verdict.js';
import { dateStampFromDate } from './util.js';

export interface ApplyOptions {
  planFile: string;
  mode: 'archive' | 'delete';
  includeReview: boolean;
  dryRun: boolean;
  /** Apply even when the plan is older than 24 hours. */
  fresh: boolean;
}

type Log = (msg: string) => void;

function isTracked(root: string, relPath: string): boolean {
  return git(root, ['ls-files', '--error-unmatch', '--', relPath]).ok;
}

/**
 * Execute a generated plan. Only safe-to-remove items are touched (plus
 * needs-review with --include-review); protected/keep/recent are never
 * eligible, and protection is re-checked against the *current* config as a
 * second line of defense. All mutations are git operations (git mv / git rm)
 * so everything lands staged in the index for human review.
 *
 * Returns the process exit code (0 success, 1 refusal/abort).
 */
export function applyPlan(opts: ApplyOptions, log: Log = console.log, err: Log = console.error): number {
  const plan = readPlanFile(opts.planFile);
  const root = plan.root;
  if (!fs.existsSync(root)) {
    err(`error: plan root does not exist: ${root}`);
    return 1;
  }
  if (!isGitRepository(root)) {
    err(`error: plan root is not a git repository: ${root}`);
    return 1;
  }

  const ageHours = (Date.now() - Date.parse(plan.generatedAt)) / 3_600_000;
  if (!opts.fresh && ageHours > 24) {
    err(
      `error: refusing to apply: plan is older than 24 hours (generated ${plan.generatedAt}, ${Math.floor(ageHours)}h ago)`,
    );
    err(`Re-run 'agent-janitor plan' to regenerate a fresh plan, or pass --fresh to apply anyway.`);
    return 1;
  }

  let config: Config;
  try {
    config = loadConfig(root);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(e.message);
      return 2;
    }
    throw e;
  }

  const eligibleVerdicts = new Set<string>(['safe-to-remove']);
  if (opts.includeReview) eligibleVerdicts.add('needs-review');
  const eligible = plan.items.filter((it) => eligibleVerdicts.has(it.verdict));
  const notEligible = plan.items.length - eligible.length;

  log(`applying plan ${opts.planFile}`);
  log(`  generated: ${plan.generatedAt}`);
  log(`  root: ${root}`);
  log(`  mode: ${opts.mode}${opts.dryRun ? ' (dry-run)' : ''}${opts.includeReview ? ' (including needs-review)' : ''}`);

  if (eligible.length === 0) {
    log('no eligible items in plan');
    log(`summary: 0 archived, 0 deleted, 0 skipped, ${notEligible} not eligible${opts.dryRun ? ' (dry-run, nothing written)' : ''}`);
    return 0;
  }

  const stamp = dateStampFromDate(new Date());
  const archiveBase = plan.config.archiveDir;
  let archived = 0;
  let deleted = 0;
  let skipped = 0;

  for (const item of eligible) {
    if (isProtectedPath(item.path, config)) {
      log(`skipped: ${item.path} (protected per current config)`);
      skipped++;
      continue;
    }
    const abs = path.join(root, ...item.path.split('/'));
    if (!fs.existsSync(abs)) {
      log(`skipped: ${item.path} (not found in worktree)`);
      skipped++;
      continue;
    }
    if (!isTracked(root, item.path)) {
      log(`skipped: ${item.path} (not tracked by git; commit it first or remove it manually)`);
      skipped++;
      continue;
    }

    if (opts.mode === 'archive') {
      const dest = `${archiveBase}/${stamp}/${item.path}`;
      const destAbs = path.join(root, ...dest.split('/'));
      if (fs.existsSync(destAbs)) {
        log(`skipped: ${item.path} (destination already exists: ${dest})`);
        skipped++;
        continue;
      }
      if (opts.dryRun) {
        log(`dry-run: would archive: ${item.path} -> ${dest}`);
        continue;
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      const r = git(root, ['mv', '--', item.path, dest]);
      if (!r.ok) {
        throw new Error(`git mv failed for ${item.path}: ${r.stderr.trim()}`);
      }
      log(`archive: ${item.path} -> ${dest}`);
      archived++;
    } else {
      if (opts.dryRun) {
        log(`dry-run: would delete: ${item.path}`);
        continue;
      }
      const r = git(root, ['rm', '--', item.path]);
      if (!r.ok) {
        throw new Error(`git rm failed for ${item.path}: ${r.stderr.trim()}`);
      }
      log(`delete: ${item.path}`);
      deleted++;
    }
  }

  log(`summary: ${archived} archived, ${deleted} deleted, ${skipped} skipped, ${notEligible} not eligible${opts.dryRun ? ' (dry-run, nothing written)' : ''}`);
  return 0;
}
