import fs from 'node:fs';
import path from 'node:path';
import { CategoryName, Config, ConfigError, loadConfig } from './config.js';
import { isGitRepository } from './git.js';
import { filterScannable, listWorktreeFiles } from './detect.js';
import { ContentCache, findReferences } from './refs.js';
import { findTaskMerged, getFileGitMeta, planStems } from './gitmeta.js';
import { evaluate, verdictRank, Verdict } from './verdict.js';
import { readPlanFile } from './plan.js';
import { readTextFile, sha256Text } from './util.js';

type Log = (msg: string) => void;

/**
 * Re-check every plan item against the current worktree. An item is stale when
 * the file is gone, its content hash changed, new references appeared, or its
 * current verdict is more restrictive than the planned verdict. Exit 1 when
 * anything is stale. This is the CI / human-reviewer re-check to run before
 * applying an older plan.
 */
export function verifyPlan(planFile: string, log: Log = console.log, err: Log = console.error): number {
  const plan = readPlanFile(planFile);
  const root = plan.root;
  if (!fs.existsSync(root)) {
    err(`error: plan root does not exist: ${root}`);
    return 1;
  }
  if (!isGitRepository(root)) {
    err(`error: plan root is not a git repository: ${root}`);
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

  const files = filterScannable(listWorktreeFiles(root), config.archiveDir);
  const fileSet = new Set(files);
  const cache = new ContentCache(root, files);

  log(`verifying plan ${planFile} against ${root}`);
  log(`  generated: ${plan.generatedAt}`);

  let fresh = 0;
  let stale = 0;
  for (const item of plan.items) {
    const problems: string[] = [];
    if (!fileSet.has(item.path)) {
      problems.push('file is no longer present in the worktree');
    } else {
      if (typeof item.snapshot?.sha256 === 'string' && item.snapshot.sha256.length > 0) {
        const text = readTextFile(path.join(root, ...item.path.split('/')));
        if (text !== null && sha256Text(text) !== item.snapshot.sha256) {
          problems.push('file content changed since the plan was generated');
        }
      }
      const nowRefs = findReferences(root, item.path, files, cache);
      const before = new Set(item.snapshot?.refFiles ?? []);
      const appeared = nowRefs.refFiles.filter((f) => !before.has(f));
      if (appeared.length > 0) {
        problems.push(`${appeared.length} new reference(s) appeared (e.g. ${appeared[0]})`);
      }
      const meta = getFileGitMeta(root, item.path);
      const taskMerged =
        item.category === 'plan-docs' ? findTaskMerged(root, planStems(item.path)) : undefined;
      const current = evaluate(
        { path: item.path, category: item.category as CategoryName, matchedBy: 'verify-plan re-check' },
        nowRefs,
        meta,
        config,
        taskMerged,
      );
      if (verdictRank(current.verdict) > verdictRank(item.verdict as Verdict)) {
        problems.push(`verdict regressed from ${item.verdict} to ${current.verdict}`);
      }
    }
    if (problems.length > 0) {
      stale++;
      log(`STALE ${item.path}: ${problems.join('; ')}`);
    } else {
      fresh++;
      log(`ok    ${item.path} (${item.verdict})`);
    }
  }

  log(`summary: ${plan.items.length} item(s) checked: ${fresh} fresh, ${stale} stale`);
  return stale > 0 ? 1 : 0;
}
