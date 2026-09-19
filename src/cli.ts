#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.js';
import { GitError, isGitRepository } from './git.js';
import { analyze, PlanError, writePlanFiles, PlanData } from './plan.js';
import { applyPlan } from './apply.js';
import { verifyPlan } from './verify.js';
import { colorize, padCell, verdictColor } from './util.js';
import { VERDICT_ORDER } from './verdict.js';

const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

// ---------------------------------------------------------------------------
// Argument parsing (hand-rolled, no dependencies)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string | null;
  /** Flags stored without their "--" prefix. */
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | null = null;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      for (const rest of argv.slice(i + 1)) positionals.push(rest);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(a.slice(2), next);
          i += 2;
        } else {
          flags.set(a.slice(2), true);
          i += 1;
        }
      } else {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        i += 1;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      flags.set(a.slice(1), true);
      i += 1;
      continue;
    }
    if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
    i += 1;
  }
  return { command, flags, positionals };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(out: (msg: string) => void = console.log): void {
  out(`agent-janitor ${VERSION} - deterministic lifecycle management for AI-agent artifacts

Usage:
  agent-janitor scan [path] [--format table|json] [--config <file>]
  agent-janitor plan [path] [--config <file>]
  agent-janitor apply --plan <file> [--mode archive|delete] [--include-review] [--dry-run] [--fresh]
  agent-janitor verify-plan <file>

Commands:
  scan         Inventory agent artifacts with category, verdict, age and refs.
  plan         Write .agent-janitor/plan-<timestamp>.json and cleanup-plan.md.
  apply        Execute a plan (git mv into the archive, or git rm). Only
               safe-to-remove items are touched; needs-review requires
               --include-review; protected/keep/recent are never touched.
  verify-plan  Re-check every plan item against the current worktree; exit 1
               when any item is stale (changed, missing, or new references).

Options:
  --config <file>   Config file (default: ./agent-janitor.yaml, optional).
  --format <fmt>    scan output: table (default) or json.
  --mode <mode>     apply mode: archive (default) or delete.
  --include-review  Also apply needs-review items.
  --dry-run         Print actions without executing them.
  --fresh           Apply a plan older than 24 hours.
  -h, --help        Show this help.
  -v, --version     Show version.

Exit codes:
  0  success
  1  refused or failed (stale plan, stale verification, git failure)
  2  usage or configuration error

Docs: https://github.com/agent-janitor/agent-janitor#readme`);
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function printSummaryLine(plan: PlanData): void {
  const parts = VERDICT_ORDER.map((v) => `${plan.summary[v]} ${v}`).join(', ');
  console.log(`${plan.items.length} artifact(s): ${parts}`);
}

function printTable(plan: PlanData): void {
  if (plan.items.length === 0) {
    console.log('no agent artifacts detected.');
    printSummaryLine(plan);
    return;
  }
  const header = ['PATH', 'CATEGORY', 'VERDICT', 'AGE(d)', 'REFS'];
  const rows = plan.items.map((it) => [
    it.path,
    it.category,
    it.verdict,
    String(it.evidence.ageDays) + (it.evidence.neverCommitted ? '*' : ''),
    String(it.evidence.refs),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const plainLine = (cells: string[]) => cells.map((c, i) => padCell(c, widths[i])).join('  ');
  console.log(plainLine(header));
  for (const row of rows) {
    // Colorize only the verdict cell; padding width stays the same either way.
    const paddedVerdict = padCell(row[2], widths[2]);
    const prefix = `${padCell(row[0], widths[0])}  ${padCell(row[1], widths[1])}  `;
    const suffix = `  ${padCell(row[3], widths[3])}  ${padCell(row[4], widths[4])}`;
    console.log(prefix + colorize(paddedVerdict, verdictColor(row[2])) + suffix);
  }
  if (plan.items.some((it) => it.evidence.neverCommitted)) {
    console.log('(* never committed)');
  }
  printSummaryLine(plan);
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

function fail(message: string): void {
  console.error(`error: ${message}`);
}

function resolveRoot(positionals: string[], command: string): string | null {
  if (positionals.length > 1) {
    fail(`${command} takes at most one path argument`);
    return null;
  }
  return path.resolve(positionals[0] ?? '.');
}

function loadConfigOrExit(root: string, flags: Map<string, string | boolean>): ReturnType<typeof loadConfig> | null {
  try {
    const explicit = flags.get('config');
    return loadConfig(root, typeof explicit === 'string' ? explicit : undefined);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return null;
    }
    throw e;
  }
}

function runScan(flags: Map<string, string | boolean>, positionals: string[]): number {
  const root = resolveRoot(positionals, 'scan');
  if (root === null) return 2;
  const format = flags.get('format');
  if (format !== undefined && format !== 'table' && format !== 'json') {
    fail(`unsupported --format ${String(format)} (expected: table, json)`);
    return 2;
  }
  if (!isGitRepository(root)) {
    fail(`${root} is not inside a git repository`);
    return 2;
  }
  const config = loadConfigOrExit(root, flags);
  if (config === null) return 2;
  const planData = analyze(root, config);
  if (format === 'json') {
    console.log(JSON.stringify(planData, null, 2));
  } else {
    printTable(planData);
  }
  return 0;
}

function runPlan(flags: Map<string, string | boolean>, positionals: string[]): number {
  const root = resolveRoot(positionals, 'plan');
  if (root === null) return 2;
  if (!isGitRepository(root)) {
    fail(`${root} is not inside a git repository`);
    return 2;
  }
  const config = loadConfigOrExit(root, flags);
  if (config === null) return 2;
  const planData = analyze(root, config);
  const { jsonPath, mdPath } = writePlanFiles(root, planData);
  console.log(`plan written: ${jsonPath}`);
  console.log(`plan written: ${mdPath}`);
  printSummaryLine(planData);
  console.log(`next: review ${mdPath}, then run: agent-janitor apply --plan "${jsonPath}"`);
  return 0;
}

function runApply(flags: Map<string, string | boolean>): number {
  const planFlag = flags.get('plan');
  if (typeof planFlag !== 'string' || planFlag.trim() === '') {
    fail('apply requires --plan <file>');
    return 2;
  }
  const mode = flags.get('mode') ?? 'archive';
  if (mode !== 'archive' && mode !== 'delete') {
    fail(`unsupported --mode ${String(mode)} (expected: archive, delete)`);
    return 2;
  }
  return applyPlan({
    planFile: path.resolve(planFlag),
    mode,
    includeReview: flags.has('include-review'),
    dryRun: flags.has('dry-run'),
    fresh: flags.has('fresh'),
  });
}

function runVerifyPlan(positionals: string[]): number {
  if (positionals.length !== 1) {
    fail('verify-plan requires exactly one plan file argument');
    return 2;
  }
  return verifyPlan(path.resolve(positionals[0]));
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  const flags = parsed.flags;

  if (flags.has('version') || flags.has('v')) {
    console.log(`agent-janitor ${VERSION}`);
    return 0;
  }
  if (flags.has('help') || flags.has('h')) {
    printUsage();
    return 0;
  }
  const command = parsed.command;
  if (command === null) {
    printUsage(console.error);
    return 2;
  }

  try {
    switch (command) {
      case 'scan':
        return runScan(flags, parsed.positionals);
      case 'plan':
        return runPlan(flags, parsed.positionals);
      case 'apply':
        return runApply(flags);
      case 'verify-plan':
        return runVerifyPlan(parsed.positionals);
      default:
        fail(`unknown command "${command}"`);
        printUsage(console.error);
        return 2;
    }
  } catch (e) {
    if (e instanceof PlanError || e instanceof ConfigError) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof GitError) {
      fail(e.message);
      return 1;
    }
    fail(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
