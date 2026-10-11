import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SHIP_CONFIG } from '../config.js';

/**
 * requiredChecks drift guard: the check names this repo's workflows report on
 * a pull request must equal DEFAULT requiredChecks + advisoryChecks, minus the
 * documented exclusions below. Adding, renaming or matrix-expanding a PR job
 * without updating src/ship/config.ts fails here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(HERE, '..', '..', '..', '.github', 'workflows');

/** Advisory checks with no workflow file: the Socket Security GitHub App. */
const EXTERNAL_CHECKS = ['Socket Security: Pull Request Alerts', 'Socket Security: Project Report'];
/** Jobs PRs report as SKIPPED (tag-only); excluded from the required list. */
const TAG_ONLY = ['Create GitHub Release'];

interface Job {
  key: string;
  name?: string;
  if?: string;
  matrix: Record<string, string[]>;
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const stripExpr = (s: string) => unquote(s).replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();

/**
 * Tight parser for the subset these workflow files use: block-style `on:`
 * keys at 2 spaces, jobs at 2 spaces under `jobs:`, `name:` / `if:` at 4,
 * and `strategy: matrix: <key>: [a, b]` flow lists at 8.
 */
function parseWorkflow(text: string): { triggers: string[]; jobs: Job[] } {
  const triggers: string[] = [];
  const jobs: Job[] = [];
  let section: 'on' | 'jobs' | null = null;
  let job: Job | null = null;
  let inMatrix = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.startsWith('on:') ? 'on' : line.startsWith('jobs:') ? 'jobs' : null;
      job = null;
      continue;
    }
    if (section === 'on') {
      const m = /^ {2}([a-z_]+):/.exec(line);
      if (m) triggers.push(m[1]);
      continue;
    }
    if (section !== 'jobs') continue;
    const jobKey = /^ {2}([\w-]+):\s*$/.exec(line);
    if (jobKey) {
      job = { key: jobKey[1], matrix: {} };
      jobs.push(job);
      inMatrix = false;
      continue;
    }
    if (!job) continue;
    const prop = /^ {4}(name|if):\s*(.+)$/.exec(line);
    if (prop) {
      job[prop[1] as 'name' | 'if'] = prop[1] === 'if' ? stripExpr(prop[2]) : unquote(prop[2]);
      continue;
    }
    if (/^ {4}\S/.test(line)) inMatrix = false;
    if (/^ {6}matrix:\s*$/.test(line)) { inMatrix = true; continue; }
    const axis = inMatrix ? /^ {8}([\w-]+):\s*\[(.*)\]\s*$/.exec(line) : null;
    if (axis) job.matrix[axis[1]] = axis[2].split(',').map(unquote).filter(Boolean);
  }
  return { triggers, jobs };
}

/** GitHub's check names: `${{ matrix.x }}` substituted, else ` (<values>)` appended per combination. */
function checkNames(job: Job): string[] {
  const base = job.name ?? job.key;
  const axes = Object.entries(job.matrix);
  if (axes.length === 0) return [base];
  let combos: Array<Record<string, string>> = [{}];
  for (const [axisKey, values] of axes) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axisKey]: v })));
  return combos.map((combo) => {
    const substituted = base.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_m, k: string) => combo[k] ?? '');
    return substituted !== base ? substituted : `${base} (${Object.values(combo).join(', ')})`;
  });
}

/** A job whose condition requires a push / dispatch / schedule event never runs on a PR. */
function runsOnPullRequest(job: Job): boolean {
  return !/^github\.event_name == '(push|workflow_dispatch|schedule)'(\s*&&|\s*$)/.test(job.if ?? '');
}

function prCheckNames(): { reported: string[]; skipped: string[] } {
  const reported: string[] = [];
  const skipped: string[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const { triggers, jobs } = parseWorkflow(readFileSync(join(WORKFLOWS, file), 'utf8'));
    expect(triggers.length, `${file}: no on: triggers parsed`).toBeGreaterThan(0);
    expect(jobs.length, `${file}: no jobs parsed`).toBeGreaterThan(0);
    if (!triggers.some((t) => t === 'pull_request' || t === 'pull_request_target')) continue;
    for (const job of jobs) (runsOnPullRequest(job) ? reported : skipped).push(...checkNames(job));
  }
  return { reported, skipped };
}

describe('requiredChecks drift (workflow files vs the ship defaults)', () => {
  it('expands matrix names like GitHub', () => {
    expect(checkNames({ key: 'a', name: 'PreCompact restore (${{ matrix.os }})', matrix: { os: ['x', 'y'] } })).toEqual(['PreCompact restore (x)', 'PreCompact restore (y)']);
    expect(checkNames({ key: 'a', name: 'Gate', matrix: { os: ['x', 'y'] } })).toEqual(['Gate (x)', 'Gate (y)']);
    expect(checkNames({ key: 'build', matrix: {} })).toEqual(['build']);
  });

  it('PR jobs in .github/workflows equal DEFAULT requiredChecks + advisoryChecks (minus the external Socket app)', () => {
    const { reported, skipped } = prCheckNames();
    expect(new Set(reported).size).toBe(reported.length);
    const expected = [...DEFAULT_SHIP_CONFIG.requiredChecks, ...DEFAULT_SHIP_CONFIG.advisoryChecks.filter((n) => !EXTERNAL_CHECKS.includes(n))];
    expect([...reported].sort()).toEqual([...expected].sort());
    expect(skipped).toEqual(TAG_ONLY);
  });

  it('covers ci.yml, pr-check.yml and upgrade-test.yml', () => {
    const { reported } = prCheckNames();
    expect(reported).toEqual(expect.arrayContaining(['Lint & Type Check', 'Multi-repo Path Gate (AST-grep) (windows-2022)', 'Draft PR Check', 'omg update + session-start hook']));
    expect(EXTERNAL_CHECKS.every((n) => DEFAULT_SHIP_CONFIG.advisoryChecks.includes(n))).toBe(true);
  });
});
