import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { ExecResult } from '../../ship/exec.js';
import { resolveShipConfig } from '../../ship/config.js';
import {
  PHASES,
  readReleaseState,
  releaseStatePath,
  resumePoint,
  runRelease,
  type ReleaseDeps,
  type ReleaseExec,
  type ReleaseOptions,
  type ReleaseState,
} from '../engine.js';
import type { ReleaseProgressInput } from '../progress.js';

const V = '5.12.2';
const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const TAGOBJ = '4'.repeat(40);
const OTHER = '5'.repeat(40);
const PR_URL = 'https://github.com/RobinNorberg/oh-my-copilot/pull/301';
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const no = (stderr = 'failed', status = 1): ExecResult => ({ status, stdout: '', stderr });

type Handler = (key: string, args: string[]) => ExecResult | undefined;

describe('omg release engine (scripted git/gh/npm, no network)', () => {
  let root: string;
  let stateRoot: string;
  let calls: string[];
  let events: ReleaseProgressInput[];
  let logs: string[];
  let handlers: Handler[];
  let confirmAnswer: boolean;
  let confirms: string[];
  let shipBlock: Record<string, unknown>;

  const exec: ReleaseExec = (cmd, args) => {
    const key = `${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`;
    calls.push(key);
    for (const h of handlers) {
      const r = h(key, args);
      if (r) return r;
    }
    return ok();
  };

  const deps = (): ReleaseDeps => ({
    exec,
    root,
    stateRoot,
    node: process.execPath,
    loadShipConfig: () => resolveShipConfig(shipBlock),
    progress: (e) => events.push(e),
    log: (l) => logs.push(l),
    confirm: async (q) => { confirms.push(q); return confirmAnswer; },
    sleep: async () => {},
    now: () => Date.parse('2026-10-21T12:00:00Z'),
  });

  const release = (opts: Partial<ReleaseOptions> = {}) => runRelease(deps(), { version: V, ...opts });

  function write(rel: string, content: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }

  function seedState(okThrough: string, extra: Partial<ReleaseState> = {}): void {
    const phases: ReleaseState['phases'] = {};
    for (const id of PHASES.slice(0, PHASES.indexOf(okThrough as never) + 1)) phases[id] = { status: 'ok', note: 'seeded', at: '2026-10-21T11:00:00Z' };
    mkdirSync(join(stateRoot, 'release'), { recursive: true });
    writeFileSync(releaseStatePath(stateRoot, V), JSON.stringify({ version: 1, release: V, createdAt: 'x', updatedAt: 'x', phases, reruns: {}, ...extra }));
  }

  /** A preflight that passes: clean tree on release/v5.12.2 over origin/dev 5.12.1. */
  const preflightOk: Handler = (key) => {
    if (key === 'git status --porcelain') return ok('');
    if (key === 'git rev-parse --abbrev-ref HEAD') return ok(`release/v${V}\n`);
    if (key === 'git show refs/remotes/origin/dev:package.json') return ok('{"version":"5.12.1"}');
    if (key === 'npm view oh-my-copilot dist-tags.latest') return ok('5.12.1\n');
    if (key === 'git rev-parse --git-path index.lock') return ok('.git/index.lock\n');
    if (key.startsWith('git ls-remote --tags origin refs/tags/v')) return ok('');
    return undefined;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-release-'));
    stateRoot = join(root, '.omg');
    calls = [];
    events = [];
    logs = [];
    handlers = [];
    confirmAnswer = false;
    confirms = [];
    shipBlock = { allowAdminMerge: true, requiredChecks: ['Test'] };
    write('package.json', JSON.stringify({ name: 'oh-my-copilot', version: '5.12.1' }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('dry run', () => {
    it('prints every phase in order and runs nothing', async () => {
      const result = await release({ dryRun: true });
      expect(calls).toEqual([]);
      expect(events).toEqual([]);
      expect(existsSync(releaseStatePath(stateRoot, V))).toBe(false);
      expect(result.phases.map((p) => p.id)).toEqual([...PHASES]);
      expect(result.phases.every((p) => p.status === 'planned' && (p.steps?.length ?? 0) > 0)).toBe(true);
      expect(result.phases.find((p) => p.id === 'smoke')!.steps![0]).toMatch(/^SKIPPED/);
    });

    it('plans only the --from..--to range', async () => {
      const result = await release({ dryRun: true, from: 'tag', to: 'verify', yes: true });
      expect(result.phases.map((p) => p.id)).toEqual(['tag', 'verify']);
      expect(result.phases[0].steps!.join('\n')).toContain('--yes given');
      expect(calls).toEqual([]);
    });
  });

  describe('phase ordering and resume', () => {
    it('resumes at the first phase not yet ok', () => {
      expect(resumePoint(null)).toBe('preflight');
      const state = { phases: { preflight: { status: 'ok' }, bump: { status: 'ok' }, build: { status: 'fail' } } } as unknown as ReleaseState;
      expect(resumePoint(state)).toBe('build');
      expect(resumePoint(state, 'preflight')).toBe('preflight');
    });

    it('runs phases in order, records each, and a later run resumes after them', async () => {
      write('CHANGELOG.md', `# oh-my-copilot v${V}\n\n## [${V}] - 2026-10-22\n`);
      write('.github/release-body.md', `v${V} fixes things`);
      write('.claude-plugin/plugin.json', '{\n  "version": "5.12.1"\n}\n');
      write('plugin.json', '{\n  "version": "5.12.1"\n}\n');
      write('.claude-plugin/marketplace.json', '{"plugins":[{"version": "5.12.1"}],\n"version": "5.12.1"}\n');
      for (const f of ['docs/CLAUDE.md', 'CLAUDE.md', '.github/CLAUDE.md', 'tests/fixtures/prompt-projection/claude-managed-block.golden']) {
        write(f, 'head\n<!-- OMC:VERSION:5.12.1 -->\nbody\n');
      }
      write('.github/upstream-port.json', '{\n  "upstream_sha": "abc",\n  "fork_version": "5.12.1"\n}\n');
      handlers.push(preflightOk);

      const first = await release({ to: 'bump' });
      expect(first.ok).toBe(true);
      expect(events.map((e) => `${e.phase}:${e.status}`)).toEqual(['preflight:start', 'preflight:ok', 'bump:start', 'bump:ok', 'release:done']);
      expect(calls).toContain(`npm version ${V} --no-git-tag-version --ignore-scripts --allow-same-version`);
      expect(calls).toContain('node scripts/generate-prompt-projections.mjs');
      expect(readFileSync(join(root, 'docs/CLAUDE.md'), 'utf8')).toContain(`<!-- OMC:VERSION:${V} -->`);
      expect(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8').match(new RegExp(`"version": "${V}"`, 'g'))).toHaveLength(2);
      expect(readFileSync(join(root, '.github/upstream-port.json'), 'utf8')).toContain(`"fork_version": "${V}"`);
      const state = readReleaseState(stateRoot, V)!;
      expect(Object.keys(state.phases)).toEqual(['preflight', 'bump']);

      // Nothing past --to bump is left: a second run with the same range does nothing.
      calls = [];
      const again = await release({ to: 'bump' });
      expect(again.phases).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('stops at the first failing phase and resumes there', async () => {
      seedState('build');
      handlers.push((key) => (key === 'node node_modules/typescript/bin/tsc --noEmit' ? no('error TS2322: bad') : undefined));
      const result = await release({ to: 'commit' });
      expect(result.ok).toBe(false);
      expect(result.phases.map((p) => `${p.id}:${p.status}`)).toEqual(['gates:fail']);
      expect(result.phases[0].details).toContain('error TS2322: bad');
      expect(calls.some((c) => c.startsWith('git commit'))).toBe(false);
      expect(resumePoint(readReleaseState(stateRoot, V))).toBe('gates');
    });
  });

  describe('preflight refusals', () => {
    it('collects every problem and never deletes the index lock', async () => {
      write('.git/index.lock', '');
      handlers.push((key) => {
        if (key === 'git status --porcelain') return ok(' M CHANGELOG.md\n M src/x.ts\n?? stray.txt\n');
        if (key === 'git rev-parse --abbrev-ref HEAD') return ok('feat/other\n');
        if (key === 'git merge-base --is-ancestor refs/remotes/origin/dev HEAD') return no('', 1);
        if (key === 'git show refs/remotes/origin/dev:package.json') return ok(`{"version":"${V}"}`);
        if (key === 'npm view oh-my-copilot dist-tags.latest') return ok('5.13.0\n');
        if (key === 'gh auth status') return no('not logged in');
        if (key === 'git rev-parse --git-path index.lock') return ok('.git/index.lock\n');
        if (key.startsWith('git ls-remote --tags origin')) return ok(`${TAGOBJ}\trefs/tags/v${V}\n`);
        return undefined;
      });
      const result = await release({ to: 'preflight' });
      expect(result.ok).toBe(false);
      const details = result.phases[0].details!.join('\n');
      expect(details).toContain('working tree is not clean: src/x.ts, stray.txt');
      expect(details).not.toContain('CHANGELOG.md');
      expect(details).toContain('HEAD is feat/other, expected release/v5.12.2');
      expect(details).toContain('HEAD does not contain origin/dev');
      expect(details).toContain(`${V} is not above origin/dev's version ${V}`);
      expect(details).toContain(`${V} is not above npm latest 5.13.0`);
      expect(details).toContain('gh is not authenticated');
      expect(details).toMatch(/index\.lock exists; another git process may hold it \(not deleted/);
      expect(details).toContain(`tag v${V} already exists on origin`);
      expect(existsSync(join(root, '.git', 'index.lock'))).toBe(true);
      expect(events.at(-1)).toMatchObject({ phase: 'preflight', status: 'fail' });
    });

    it('treats an unpublished package (E404) as no npm latest', async () => {
      handlers.push((key) => (key === 'npm view oh-my-copilot dist-tags.latest' ? no('npm error code E404') : undefined), preflightOk);
      expect((await release({ to: 'preflight' })).ok).toBe(true);
    });
  });

  describe('bump', () => {
    it('refuses before touching anything when the release prose is missing', async () => {
      seedState('preflight');
      write('CHANGELOG.md', '# Changelog\n');
      const result = await release({ to: 'bump' });
      expect(result.ok).toBe(false);
      expect(result.phases[0].note).toMatch(/release prose is missing/);
      expect(calls).toEqual([]);
    });
  });

  describe('build: orphans, untracked files, probes', () => {
    beforeEach(() => {
      seedState('bump');
      write('src/kept.ts', '');
      handlers.push((key) => {
        if (key === 'git ls-files dist') return ok('dist/kept.js\ndist/kept.d.ts\ndist/gone.js\ndist/gone.js.map\n');
        if (key === 'node dist/cli/index.js --version' || key === 'node bridge/cli.cjs --version') return ok(`${V}\n`);
        return undefined;
      });
    });

    it('fails with the orphan list unless --fix-orphans', async () => {
      const result = await release({ to: 'build' });
      expect(result.ok).toBe(false);
      expect(result.phases[0].details).toEqual(['dist/gone.js', 'dist/gone.js.map']);
      expect(calls.some((c) => c.startsWith('git rm'))).toBe(false);
    });

    it('removes orphans with --fix-orphans and runs the probes', async () => {
      const result = await release({ to: 'build', fixOrphans: true });
      expect(result.ok).toBe(true);
      expect(calls).toContain('git rm -q -- dist/gone.js dist/gone.js.map');
      expect(calls).toContain('npm run build');
      expect(calls).toContain('git add -f dist bridge');
      expect(calls).toContain('node dist/mcp/standalone-server.js');
      expect(calls.some((c) => c.startsWith('node --input-type=module -e'))).toBe(true);
    });

    it('fails on untracked dist/bridge files and a wrong --version', async () => {
      handlers.unshift((key) => {
        if (key === 'git ls-files --others dist bridge') return ok('dist/new.js\n');
        if (key === 'node bridge/cli.cjs --version') return ok('5.12.1\n');
        return undefined;
      });
      const result = await release({ to: 'build', fixOrphans: true });
      expect(result.phases[0].note).toMatch(/untracked files/);
      expect(result.phases[0].details).toEqual(['dist/new.js']);
    });
  });

  describe('smoke', () => {
    it('is skipped loudly without --live-smoke', async () => {
      seedState('gates');
      const result = await release({ to: 'smoke' });
      expect(result.phases).toEqual([expect.objectContaining({ id: 'smoke', status: 'skipped' })]);
      expect(logs.join('\n')).toMatch(/SKIPPED the live Tier 2 smoke/);
      expect(calls).toEqual([]);
    });

    it('requires every check green with --live-smoke', async () => {
      seedState('gates');
      handlers.push((key) => (key === 'node bridge/cli.cjs smoke copilot --tier 2 --json'
        ? { status: 1, stdout: '{"ok":false,"checks":[{"id":"scn.guardrail","ok":false,"detail":"not denied"}]}', stderr: '' }
        : undefined));
      const result = await release({ to: 'smoke', liveSmoke: true });
      expect(result.phases[0]).toMatchObject({ status: 'fail', details: ['scn.guardrail: not denied'] });
    });
  });

  describe('commit', () => {
    it('commits the release, then the inventory last, and requires a clean tree', async () => {
      seedState('smoke');
      let inventoryWritten = false;
      handlers.push((key) => {
        if (key === 'git diff --cached --quiet') return no('', 1);
        if (key === 'node scripts/generate-inventory-graph.mjs --write') { inventoryWritten = true; return ok(); }
        if (key === 'git diff --cached --quiet -- inventory') return inventoryWritten ? no('', 1) : ok();
        if (key === 'git rev-parse HEAD') return ok(`${HEAD}\n`);
        return undefined;
      });
      const result = await release({ to: 'commit' });
      expect(result.ok).toBe(true);
      const order = ['git commit -m chore(release): v5.12.2', 'node scripts/generate-inventory-graph.mjs --write', 'git commit -m chore(release): regenerate inventory for v5.12.2 -- inventory', 'node scripts/generate-inventory-graph.mjs --verify', 'git status --porcelain'];
      expect(order.map((c) => calls.indexOf(c))).toEqual([...order.map((c) => calls.indexOf(c))].sort((a, b) => a - b));
      expect(order.every((c) => calls.includes(c))).toBe(true);
    });
  });

  describe('pr: the ship merge rule with a config-driven allow-list', () => {
    const checks = (advisoryState: string, testState = 'SUCCESS') => JSON.stringify([
      { name: 'Test', state: testState, link: 'https://github.com/o/r/actions/runs/77/job/88' },
      { name: 'No Committed Build Artifacts', state: advisoryState, link: 'https://github.com/o/r/actions/runs/77/job/89' },
      { name: 'Authorize generated artifacts from base trust root', state: advisoryState, link: 'https://github.com/o/r/actions/runs/78/job/90' },
    ]);
    let prState: string;
    let checksJson: string;

    beforeEach(() => {
      seedState('commit');
      prState = 'OPEN';
      checksJson = checks('FAILURE');
      handlers.push((key) => {
        if (key.startsWith('gh pr list --head release/v5.12.2 --base dev')) return ok('[]');
        if (key.startsWith('gh pr create --base dev')) return ok(`${PR_URL}\n`);
        if (key.startsWith('gh pr view 301 --json number,state')) {
          return ok(JSON.stringify({ number: 301, state: prState, isDraft: false, baseRefName: 'dev', baseRefOid: BASE, headRefOid: HEAD, url: PR_URL, mergeCommit: prState === 'MERGED' ? { oid: MERGE } : null }));
        }
        if (key === 'gh pr view 301 --json headRefOid') return ok(JSON.stringify({ headRefOid: HEAD }));
        if (key.startsWith('gh pr checks 301')) return ok(checksJson);
        if (key.startsWith(`gh run list --commit ${HEAD}`)) return ok('[{"databaseId":77,"status":"completed","conclusion":"failure","workflowName":"CI"}]');
        if (key.startsWith('gh pr merge 301')) { prState = 'MERGED'; return ok(); }
        if (key === 'gh run view --job 88 --log') return ok('Test\tRun tests\t2026-10-21T12:00:00.000Z  FAIL  src/a.test.ts > suite > breaks\n');
        return undefined;
      });
    });

    it('merges when only the allow-listed red-by-design checks fail', async () => {
      const result = await release({ to: 'pr' });
      expect(result.ok).toBe(true);
      expect(calls).toContain('git push origin HEAD:refs/heads/release/v5.12.2');
      expect(calls).toContain(`gh pr merge 301 --admin --merge --match-head-commit ${HEAD}`);
      expect(readReleaseState(stateRoot, V)!.devPr).toBe(301);
      expect(events.some((e) => e.phase === 'pr' && e.status === 'heartbeat')).toBe(true);
    });

    it('treats the same checks as failures when the config allow-list omits them: one rerun, then the failing titles', async () => {
      shipBlock = { ...shipBlock, advisoryChecks: [] };
      const result = await release({ to: 'pr' });
      expect(result.ok).toBe(false);
      expect(calls.filter((c) => c.startsWith('gh run rerun'))).toEqual(['gh run rerun 77 --failed', 'gh run rerun 78 --failed']);
      expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
      expect(result.phases[0].note).toMatch(/after the one automatic rerun/);
      expect(readReleaseState(stateRoot, V)!.reruns).toEqual({ 77: 1, 78: 1 });
    });

    it('names the failing tests of a real failure', async () => {
      checksJson = checks('FAILURE', 'FAILURE');
      const result = await release({ to: 'pr' });
      expect(result.ok).toBe(false);
      expect(result.phases[0].details).toContain('  Test: src/a.test.ts > suite > breaks');
      expect(calls.filter((c) => c === 'gh run rerun 77 --failed')).toHaveLength(1);
    });

    it('prints the merge command instead of merging without ship.allowAdminMerge', async () => {
      shipBlock = { ...shipBlock, allowAdminMerge: false };
      const result = await release({ to: 'pr' });
      expect(result.phases[0].status).toBe('blocked');
      expect(result.phases[0].details).toEqual([`gh pr merge 301 --admin --merge --match-head-commit ${HEAD}`]);
      expect(calls.some((c) => c.startsWith('gh pr merge'))).toBe(false);
    });

    it('re-run after the owner merged picks the merge commit up without pushing again', async () => {
      seedState('commit', { devPr: 301 });
      prState = 'MERGED';
      const result = await release({ to: 'pr' });
      expect(result.ok).toBe(true);
      expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
    });
  });

  describe('tag: sha verification and confirmation', () => {
    let pushed: boolean;
    let localTag: { type: string; peeled: string } | null;

    beforeEach(() => {
      seedState('promote', { devPr: 301, mainPr: 302, mainMergeSha: MERGE });
      pushed = false;
      localTag = null;
      handlers.push((key) => {
        if (key.startsWith('git ls-remote --tags origin')) return ok(pushed ? `${TAGOBJ}\trefs/tags/v${V}\n${MERGE}\trefs/tags/v${V}^{}\n` : '');
        if (key === `git merge-base --is-ancestor ${MERGE} refs/remotes/origin/main`) return ok();
        if (key === `git rev-parse -q --verify refs/tags/v${V}`) return localTag ? ok(TAGOBJ) : no('', 1);
        if (key === `git tag -a v${V} -m v${V} ${MERGE}`) { localTag = { type: 'tag', peeled: MERGE }; return ok(); }
        if (key === `git cat-file -t refs/tags/v${V}`) return ok(`${localTag?.type ?? ''}\n`);
        if (key === `git rev-parse refs/tags/v${V}^{}`) return ok(`${localTag?.peeled ?? ''}\n`);
        if (key === `git push origin refs/tags/v${V}:refs/tags/v${V}`) { pushed = true; return ok(); }
        return undefined;
      });
    });

    it('is blocked without --yes when the confirmation is declined, and creates nothing', async () => {
      const result = await release({ to: 'tag' });
      expect(result.phases[0].status).toBe('blocked');
      expect(confirms).toEqual([`Create and push annotated tag v${V} on main 333333333333? This publishes oh-my-copilot@${V} to npm.`]);
      expect(calls.some((c) => c.startsWith('git tag') || c.startsWith('git push'))).toBe(false);
    });

    it('warns in the confirmation when the live smoke was skipped', async () => {
      seedState('promote', { mainMergeSha: MERGE, phases: { smoke: { status: 'skipped', note: '', at: '' } } });
      await release({ from: 'tag', to: 'tag' });
      expect(confirms[0]).toMatch(/WARNING: the live Tier 2 smoke was skipped/);
    });

    it('creates the annotated tag on the main merge commit, verifies it, pushes it and checks the remote', async () => {
      const result = await release({ to: 'tag', yes: true });
      expect(result.ok).toBe(true);
      expect(confirms).toEqual([]);
      expect(calls).toContain(`git tag -a v${V} -m v${V} ${MERGE}`);
      expect(calls).toContain(`git push origin refs/tags/v${V}:refs/tags/v${V}`);
    });

    it('refuses a local tag that peels elsewhere (an upstream tag) and never pushes it', async () => {
      localTag = { type: 'tag', peeled: OTHER };
      const result = await release({ to: 'tag', yes: true });
      expect(result.ok).toBe(false);
      expect(result.phases[0].note).toMatch(/not the main merge commit/);
      expect(calls.some((c) => c.startsWith('git push'))).toBe(false);
      expect(calls.some((c) => c.startsWith('git tag -d'))).toBe(false);
    });

    it('refuses a remote tag on another commit', async () => {
      handlers.unshift((key) => (key.startsWith('git ls-remote --tags origin') ? ok(`${OTHER}\trefs/tags/v${V}\n`) : undefined));
      const result = await release({ to: 'tag', yes: true });
      expect(result.phases[0].note).toMatch(/exists on origin at 555555555555 \(lightweight\)/);
    });

    it('needs the promote phase merge commit', async () => {
      seedState('promote');
      const result = await release({ to: 'tag', yes: true });
      expect(result.phases[0].note).toMatch(/no main merge commit recorded/);
    });
  });

  describe('verify', () => {
    let conclusion: string;

    beforeEach(() => {
      seedState('tag', { mainMergeSha: MERGE });
      conclusion = 'failure';
      handlers.push((key) => {
        if (key.startsWith('gh run list --workflow ci.yml --event push')) {
          return ok(JSON.stringify([{ databaseId: 900, headBranch: 'dev', event: 'push', status: 'completed', conclusion: 'success' }, { databaseId: 901, headBranch: `v${V}`, event: 'push', status: 'completed', conclusion }]));
        }
        if (key === 'gh run rerun 901 --failed') { conclusion = 'success'; return ok(); }
        if (key === 'gh run view 901 --json jobs') {
          return ok(JSON.stringify({ jobs: [{ databaseId: 5, name: 'Create GitHub Release', conclusion }, { databaseId: 6, name: 'Copilot smoke (tier 2)', conclusion: 'success' }] }));
        }
        if (key.startsWith(`npm view oh-my-copilot@${V}`)) return ok(JSON.stringify({ version: V, 'dist-tags.latest': V, 'dist.attestations': { url: 'x' } }));
        if (key.startsWith(`gh release view v${V}`)) return ok(JSON.stringify({ tagName: `v${V}`, isDraft: false }));
        return undefined;
      });
    });

    it('reruns a failed tag run once, then checks npm and the GitHub Release', async () => {
      const result = await release({ to: 'verify' });
      expect(result.ok).toBe(true);
      expect(calls.filter((c) => c === 'gh run rerun 901 --failed')).toHaveLength(1);
      expect(readReleaseState(stateRoot, V)!.tagRunId).toBe(901);
    });

    it('stops with the failed job and its failing tests after the rerun', async () => {
      handlers.unshift((key) => {
        if (key === 'gh run rerun 901 --failed') return ok();
        if (key === 'gh run view --job 5 --log') return ok('x\ty\t FAIL  src/b.test.ts > b > flakes\n');
        return undefined;
      });
      const result = await release({ to: 'verify' });
      expect(result.ok).toBe(false);
      expect(result.phases[0].details).toEqual(['failed job: Create GitHub Release', '  src/b.test.ts > b > flakes']);
    });

    it('fails when npm latest or provenance is missing', async () => {
      conclusion = 'success';
      handlers.unshift((key) => (key.startsWith(`npm view oh-my-copilot@${V}`) ? ok(JSON.stringify({ version: V, 'dist-tags.latest': '5.12.1' })) : undefined));
      const result = await release({ to: 'verify' });
      expect(result.phases[0].details).toEqual(['npm dist-tags.latest is "5.12.1", not 5.12.2', 'npm reports no dist.attestations (SLSA provenance)']);
    });
  });
});
