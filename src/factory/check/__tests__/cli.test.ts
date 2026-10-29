import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factoryCommand } from '../../../cli/commands/factory.js';
import { factoryCheckCommand } from '../../../cli/commands/factory-check.js';
import { recordingExec } from '../../../forge/__tests__/recording-exec.js';
import { createForge } from '../../../forge/index.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { CHECK_JSON_SCHEMA_VERSION, checkGuardExec, parseSourceSpec, runFactoryCheck, type CheckJson, type FactoryCheckDeps, type FactoryCheckOptions } from '../cli.js';

const SHA = 'a'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const AC = '## Acceptance criteria\n- `omg x` exits 0\n';

interface Issue { title: string; body: string; state?: string; labels?: string[] }

/** A scripted gh + git: the issues, the open factory PRs, the plan files on origin/dev. */
function scripted(root: string, issues: Record<number, Issue>, o: { prs?: Record<number, number>; files?: Record<string, string>; failEdit?: number[]; branches?: number[]; labels?: string[] } = {}): Exec {
  return (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://github.com/o/r.git\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok(o.branches?.includes(Number(/issue-(\d+)$/.exec(args[2])![1])) ? `${SHA}\t${args[2]}\n` : '');
      if (args[0] === 'show') {
        const path = args[1].slice(41);
        const text = o.files?.[path];
        return text === undefined ? { status: 128, stdout: '', stderr: `fatal: path '${path}' does not exist in '${SHA}'` } : ok(text);
      }
    }
    if (cmd === 'gh') {
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(Object.keys(issues).map((n) => ({ number: Number(n) }))));
      if (args[0] === 'issue' && args[1] === 'view') {
        const n = Number(args[2]);
        const i = issues[n];
        if (!i) return { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue' };
        return ok(JSON.stringify({ title: i.title, body: i.body, state: i.state ?? 'OPEN', url: `https://github.com/o/r/issues/${n}`, author: { login: 'o' }, comments: [], labels: (i.labels ?? []).map((name) => ({ name })) }));
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const n = Number(/issue-(\d+)$/.exec(args[3])![1]);
        return ok(JSON.stringify(o.prs?.[n] ? [{ number: o.prs[n], state: 'OPEN' }] : []));
      }
      if (args[0] === 'label' && args[1] === 'list') return ok(JSON.stringify((o.labels ?? ['factory-ready', 'factory-ready-later']).map((name) => ({ name }))));
      if (args[0] === 'issue' && args[1] === 'edit') return o.failEdit?.includes(Number(args[2])) ? { status: 1, stdout: '', stderr: 'HTTP 403\u001b[31m' } : ok();
    }
    throw new Error(`unscripted ${cmd} ${a}`);
  };
}

let root: string;
let out: string[];
let err: string[];
let prompts: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-check-'));
  out = [];
  err = [];
  prompts = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(exec: Exec, over: Partial<FactoryCheckDeps> = {}): FactoryCheckDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => undefined,
    projectConfig: () => undefined,
    createForge,
    isTTY: () => true,
    confirm: async (q) => { prompts.push(q); return false; },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}

const ISSUES: Record<number, Issue> = {
  1: { title: 'ready one', body: AC, labels: ['priority:p2'] },
  2: { title: 'no plan', body: 'just do it' },
  3: { title: 'has a PR', body: AC },
  4: { title: 'ready two \u001b[2J\u0007', body: AC, labels: ['priority:p0'] },
  5: { title: 'already marked', body: AC, labels: ['Factory-Ready'] },
};

async function run(exec: Exec, o: Partial<FactoryCheckOptions>, over: Partial<FactoryCheckDeps> = {}): Promise<number> {
  return runFactoryCheck({ ids: [], ...o }, deps(exec, over));
}

describe('omg factory check (GitHub through forge.tracker)', () => {
  it('is registered under omg factory', () => {
    expect(factoryCommand().commands.map((c) => c.name())).toContain('check');
  });

  it('reads every item through the guarded gh shapes and pins the --json schema', async () => {
    const rec = recordingExec(scripted(root, ISSUES, { prs: { 3: 9 } }), {}, ['gh']);
    expect(await run(rec.exec, { source: 'label:factory', json: true })).toBe(0);
    const json = JSON.parse(out.join('\n')) as CheckJson;
    expect(Object.keys(json)).toEqual(['schemaVersion', 'ok', 'forge', 'repo', 'source', 'counts', 'items', 'mark', 'warnings']);
    expect(json.schemaVersion).toBe(CHECK_JSON_SCHEMA_VERSION);
    expect(CHECK_JSON_SCHEMA_VERSION).toBe(1);
    expect(json).toMatchObject({ ok: true, forge: 'github', repo: 'https://github.com/o/r', source: { type: 'label', label: 'factory' }, counts: { runnable: 3, 'needs-plan': 1, blocked: 1 } });
    expect(Object.keys(json.items[0])).toEqual(['id', 'title', 'url', 'bucket', 'reasons', 'detail', 'priority', 'planSource']);
    expect(Object.keys(json.mark)).toEqual(['marker', 'requested', 'confirmed', 'marked', 'alreadyMarked', 'failed']);
    expect(json.items.map((r) => [r.id, r.bucket, r.reasons, r.priority])).toEqual([
      [4, 'runnable', [], 1], [1, 'runnable', [], 3], [5, 'runnable', [], null],
      [2, 'needs-plan', ['no-plan'], null],
      [3, 'blocked', ['pr-exists'], null],
    ]);
    expect(json.items[0]).toEqual({ id: 4, title: 'ready two  ', url: 'https://github.com/o/r/issues/4', bucket: 'runnable', reasons: [], detail: 'plan: 1 acceptance item (issue-body)', priority: 1, planSource: 'issue-body' });
    expect(json.warnings).toEqual([]);
    const fields = '["issue","view","%","--json","title,body,labels,state,url,author,comments"]';
    expect(rec.calls).toEqual([
      'gh ["issue","list","--label","factory","--state","open","--json","number","--limit","50"] cwd=' + root,
      ...[1, 2, 3, 4, 5].flatMap((n) => [
        `gh ${fields.replace('%', String(n))} cwd=${root}`,
        `gh ["pr","list","--head","factory/issue-${n}","--json","number,state,headRefOid,url"] cwd=${root}`,
      ]),
    ]);
  });

  it('prints a table with the reason and a bucket summary', async () => {
    expect(await run(scripted(root, ISSUES, { prs: { 3: 9 } }), { ids: ['2', '#3', '1'] })).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/#1\s+runnable\s+P3/);
    expect(text).toMatch(/#2\s+needs-plan\s+-\s+no-plan/);
    expect(text).toMatch(/#3\s+blocked\s+-\s+pr-exists/);
    expect(text).toMatch(/1 runnable, 1 needs-plan, 1 blocked/);
  });

  it('--mark writes nothing without confirmation', async () => {
    const rec = recordingExec(scripted(root, ISSUES, { prs: { 3: 9 } }), {}, ['gh']);
    expect(await run(rec.exec, { source: 'label:factory', mark: true })).toBe(0);
    expect(prompts).toEqual(['Add label factory-ready to 2 runnable items (#4, #1)?']);
    expect(rec.calls.some((c) => c.includes('"edit"'))).toBe(false);
    expect(out.join('\n')).toMatch(/already marked: #5\nnothing marked/);
  });

  it('--mark without --yes off a TTY (or with --json) is a usage error before any write', async () => {
    const rec = recordingExec(scripted(root, ISSUES), {}, ['gh']);
    await expect(run(rec.exec, { source: 'label:factory', mark: true }, { isTTY: () => false })).rejects.toThrow(/--mark needs --yes/);
    await expect(run(rec.exec, { source: 'label:factory', mark: true, json: true })).rejects.toThrow(/--mark needs --yes/);
    expect(rec.calls.some((c) => c.includes('"edit"'))).toBe(false);
    expect(prompts).toEqual([]);
  });

  it('--mark with a missing marker label exits 5 with a setup hint and writes nothing', async () => {
    const rec = recordingExec(scripted(root, ISSUES, { prs: { 3: 9 }, labels: ['factory-ready-later'] }), {}, ['gh']);
    await expect(run(rec.exec, { source: 'label:factory', mark: true, yes: true })).rejects.toThrow('label factory-ready does not exist in https://github.com/o/r; run `omg factory setup` to create it');
    expect(rec.calls.some((c) => c.includes('"edit"'))).toBe(false);
    expect(rec.calls).toContain(`gh ["label","list","--search","factory-ready","--json","name","--limit","100"] cwd=${root}`);
    process.exitCode = undefined;
    await factoryCheckCommand(deps(rec.exec)).parseAsync(['--source', 'label:factory', '--mark', '--yes'], { from: 'user' });
    expect(Number(process.exitCode)).toBe(5);
    process.exitCode = undefined;
  });

  it('a leftover origin/factory/issue-<n> branch without a PR blocks (git ls-remote)', async () => {
    expect(await run(scripted(root, ISSUES, { branches: [1] }), { ids: ['1'], json: true })).toBe(0);
    expect((JSON.parse(out.join('\n')) as CheckJson).items[0]).toMatchObject({ id: 1, bucket: 'blocked', reasons: ['branch-exists'] });
  });

  it('a failed item read is read-failed, the batch goes on, and the exit is 1', async () => {
    expect(await run(scripted(root, ISSUES), { ids: ['1', '99'], json: true })).toBe(1);
    const json = JSON.parse(out.join('\n')) as CheckJson;
    expect(json.ok).toBe(false);
    expect(json.items.map((r) => [r.id, r.bucket, r.reasons])).toEqual([[1, 'runnable', []], [99, 'blocked', ['read-failed']]]);
  });

  it('--mark after confirmation labels the runnable items only, through forge.tracker', async () => {
    const rec = recordingExec(scripted(root, ISSUES, { prs: { 3: 9 } }), {}, ['gh']);
    expect(await run(rec.exec, { source: 'label:factory', mark: true }, { confirm: async () => true })).toBe(0);
    expect(rec.calls.filter((c) => c.includes('"edit"'))).toEqual([
      `gh ["issue","edit","4","--add-label","factory-ready"] cwd=${root}`,
      `gh ["issue","edit","1","--add-label","factory-ready"] cwd=${root}`,
    ]);
    expect(out.join('\n')).toMatch(/marked factory-ready: #4, #1/);
  });

  it('--mark --yes --json reports the writes and a failed one exits 1', async () => {
    expect(await run(scripted(root, ISSUES, { prs: { 3: 9 }, failEdit: [1] }), { source: 'label:factory', mark: true, yes: true, json: true })).toBe(1);
    const json = JSON.parse(out.join('\n')) as CheckJson;
    expect(json.ok).toBe(false);
    expect(json.mark).toEqual({ marker: 'factory-ready', requested: true, confirmed: true, marked: [4], alreadyMarked: [5], failed: [{ id: 1, error: 'HTTP 403' }] });
    expect(prompts).toEqual([]);
  });

  it('a trusted omg-plan is read at origin/<base>', async () => {
    const issues: Record<number, Issue> = { 7: { title: 'p', body: 'omg-plan: docs/p.md' }, 8: { title: 'q', body: 'omg-plan: docs/missing.md' } };
    expect(await run(scripted(root, issues, { files: { 'docs/p.md': '# plan' } }), { ids: ['7', '8'], json: true })).toBe(0);
    const json = JSON.parse(out.join('\n')) as CheckJson;
    expect(json.items.map((r) => [r.id, r.bucket, r.reasons, r.planSource])).toEqual([[7, 'runnable', [], 'omg-plan'], [8, 'needs-plan', ['plan-missing'], null]]);
    expect(json.items[1].detail).toBe(`omg-plan docs/missing.md is missing or empty on origin/dev at ${SHA.slice(0, 12)}`);
  });

  it('usage and incompatibility exits', async () => {
    const exec = scripted(root, ISSUES);
    await expect(run(exec, {})).rejects.toThrow(/no item ids and no intake source/);
    await expect(run(exec, { ids: ['x1'] })).rejects.toThrow(/positive number/);
    await expect(run(exec, { source: 'nope' })).rejects.toThrow(/--source "nope"/);
    await expect(run(exec, { source: 'wiql-query:0b6c0000-0000-0000-0000-000000000000' })).rejects.toThrow(/is for azure-devops/);
    const ado: Exec = (cmd, args, opts) => (args.join(' ') === 'remote get-url origin' ? ok('https://dev.azure.com/contoso/Web/_git/web-app\n') : exec(cmd, args, opts));
    const noAdapter = { createForge: () => { throw new Error('no forge adapter for azure-devops in this build'); } };
    await expect(run(ado, { ids: ['1'] }, noAdapter)).rejects.toThrow(/no forge adapter for azure-devops/);

    const codes: number[] = [];
    for (const [argv, d] of [[['--source', 'nope'], deps(exec)], [['1'], deps(ado, noAdapter)], [['1'], deps(exec)]] as const) {
      process.exitCode = undefined;
      await factoryCheckCommand(d).parseAsync([...argv], { from: 'user' });
      codes.push(Number(process.exitCode ?? 0));
    }
    process.exitCode = undefined;
    expect(codes).toEqual([2, 5, 0]);
  });

  it('parseSourceSpec', () => {
    expect(parseSourceSpec('board-column:Web Team/Stories/Ready/Now')).toEqual({ type: 'board-column', team: 'Web Team', board: 'Stories', column: 'Ready/Now' });
    expect(parseSourceSpec('area-tag:Web\\Factory#factory')).toEqual({ type: 'area-tag', areaPath: 'Web\\Factory', tag: 'factory' });
    expect(parseSourceSpec('milestone:v5.18')).toEqual({ type: 'milestone', milestone: 'v5.18' });
  });
});

describe('checkGuardExec', () => {
  const inner: Exec = () => ok();
  const refused = (exec: Exec, cmd: string, args: string[]) => expect(() => exec(cmd, args)).toThrow(/omg factory check refuses|omg ship refuses|omg factory run refuses/);

  it('allows the read shapes and refuses writes and anything else', () => {
    const exec = checkGuardExec(inner);
    expect(exec('gh', ['issue', 'view', '1', '--json', 'title,body']).status).toBe(0);
    expect(exec('gh', ['pr', 'list', '--head', 'factory/issue-1', '--json', 'number']).status).toBe(0);
    refused(exec, 'gh', ['issue', 'edit', '1', '--add-label', 'factory-ready']);
    refused(exec, 'gh', ['issue', 'comment', '1', '--body-file', 'x']);
    refused(exec, 'gh', ['api', 'repos/o/r']);
    refused(exec, 'gh', ['pr', 'list', '--head', 'main', '--json', 'number']);
    refused(exec, 'gh', ['issue', 'list', '--label', '--repo=x', '--state', 'open', '--json', 'number', '--limit', '5']);
    refused(exec, 'git', ['push', 'origin', 'HEAD:refs/heads/x']);
    refused(exec, 'git', ['show', 'HEAD']);
    expect(exec('git', ['ls-remote', 'origin', 'refs/heads/factory/issue-1']).status).toBe(0);
    refused(exec, 'git', ['ls-remote', 'origin', 'refs/heads/main']);
    refused(exec, 'az', ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--http-method', 'PATCH']);
    refused(exec, 'npm', ['ci']);
  });

  it('allows the marker label only while a confirmed mark runs', () => {
    const mark: { marker?: string } = {};
    const exec = checkGuardExec(inner, () => mark.marker);
    refused(exec, 'gh', ['issue', 'edit', '1', '--add-label', 'factory-ready']);
    mark.marker = 'factory-ready';
    expect(exec('gh', ['issue', 'edit', '1', '--add-label', 'factory-ready']).status).toBe(0);
    refused(exec, 'gh', ['issue', 'edit', '1', '--add-label', 'other']);
    refused(exec, 'gh', ['issue', 'edit', '1', '--remove-label', 'factory-ready']);
  });
});
