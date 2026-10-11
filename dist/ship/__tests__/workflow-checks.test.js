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
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const stripExpr = (s) => unquote(s).replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
/**
 * Tight parser for the subset these workflow files use: block-style `on:`
 * keys at 2 spaces with an optional `branches: [a, b]` flow list at 4, jobs
 * at 2 spaces under `jobs:`, `name:` / `if:` at 4, and
 * `strategy: matrix: <key>: [a, b]` flow lists at 8.
 */
function parseWorkflow(text) {
    const triggers = [];
    const branches = {};
    const jobs = [];
    let section = null;
    let job = null;
    let inMatrix = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^\S/.test(line)) {
            section = line.startsWith('on:') ? 'on' : line.startsWith('jobs:') ? 'jobs' : null;
            job = null;
            continue;
        }
        if (section === 'on') {
            const m = /^ {2}([a-z_]+):/.exec(line);
            if (m)
                triggers.push(m[1]);
            const filter = /^ {4}branches:\s*\[(.*)\]\s*$/.exec(line);
            if (filter && triggers.length > 0)
                branches[triggers[triggers.length - 1]] = filter[1].split(',').map(unquote).filter(Boolean);
            continue;
        }
        if (section !== 'jobs')
            continue;
        const jobKey = /^ {2}([\w-]+):\s*$/.exec(line);
        if (jobKey) {
            job = { key: jobKey[1], matrix: {} };
            jobs.push(job);
            inMatrix = false;
            continue;
        }
        if (!job)
            continue;
        const prop = /^ {4}(name|if):\s*(.+)$/.exec(line);
        if (prop) {
            job[prop[1]] = prop[1] === 'if' ? stripExpr(prop[2]) : unquote(prop[2]);
            continue;
        }
        if (/^ {4}\S/.test(line))
            inMatrix = false;
        if (/^ {6}matrix:\s*$/.test(line)) {
            inMatrix = true;
            continue;
        }
        const axis = inMatrix ? /^ {8}([\w-]+):\s*\[(.*)\]\s*$/.exec(line) : null;
        if (axis)
            job.matrix[axis[1]] = axis[2].split(',').map(unquote).filter(Boolean);
    }
    return { triggers, branches, jobs };
}
/** GitHub's check names: `${{ matrix.x }}` substituted, else ` (<values>)` appended per combination. */
function checkNames(job) {
    const base = job.name ?? job.key;
    const axes = Object.entries(job.matrix);
    if (axes.length === 0)
        return [base];
    let combos = [{}];
    for (const [axisKey, values] of axes)
        combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axisKey]: v })));
    return combos.map((combo) => {
        const substituted = base.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_m, k) => combo[k] ?? '');
        return substituted !== base ? substituted : `${base} (${Object.values(combo).join(', ')})`;
    });
}
/** A job whose condition requires a push / dispatch / schedule event never runs on a PR. */
function runsOnPullRequest(job) {
    return !/^github\.event_name == '(push|workflow_dispatch|schedule)'(\s*&&|\s*$)/.test(job.if ?? '');
}
/**
 * Check names a PR to `base` reports: workflows with a pull_request /
 * pull_request_target trigger whose `branches:` filter (if any) names the base.
 */
function prCheckNames(base = DEFAULT_SHIP_CONFIG.base) {
    const reported = [];
    const skipped = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
        const { triggers, branches, jobs } = parseWorkflow(readFileSync(join(WORKFLOWS, file), 'utf8'));
        expect(triggers.length, `${file}: no on: triggers parsed`).toBeGreaterThan(0);
        expect(jobs.length, `${file}: no jobs parsed`).toBeGreaterThan(0);
        const prTriggers = triggers.filter((t) => t === 'pull_request' || t === 'pull_request_target');
        if (!prTriggers.some((t) => branches[t] === undefined || branches[t].includes(base)))
            continue;
        for (const job of jobs)
            (runsOnPullRequest(job) ? reported : skipped).push(...checkNames(job));
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
    it('honors pull_request.branches: a PR to another base never gets the ci.yml / upgrade-test.yml checks (they stay pending)', () => {
        expect(parseWorkflow('on:\n  pull_request:\n    branches: [main, dev]\n  push:\n    branches: ["x"]\njobs:\n  a:\n    name: A\n').branches)
            .toEqual({ pull_request: ['main', 'dev'], push: ['x'] });
        const { reported } = prCheckNames('release/x');
        expect(reported).not.toContain('Test');
        expect(reported).not.toContain('omg update + session-start hook');
        expect(reported).toContain('Draft PR Check');
        // So the default requiredChecks never go green on such a base: it needs its own list in the user config.
        expect(DEFAULT_SHIP_CONFIG.requiredChecks.filter((n) => !reported.includes(n))).toEqual(expect.arrayContaining(['Test', 'Build']));
    });
    it('covers ci.yml, pr-check.yml and upgrade-test.yml', () => {
        const { reported } = prCheckNames();
        expect(reported).toEqual(expect.arrayContaining(['Lint & Type Check', 'Multi-repo Path Gate (AST-grep) (windows-2022)', 'Draft PR Check', 'omg update + session-start hook']));
        expect(EXTERNAL_CHECKS.every((n) => DEFAULT_SHIP_CONFIG.advisoryChecks.includes(n))).toBe(true);
    });
});
//# sourceMappingURL=workflow-checks.test.js.map