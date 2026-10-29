/**
 * The wizard end to end on the real adapters (--yes --json): detect -> auth ->
 * intake -> progress -> write -> preview with the real `omg factory check`
 * buckets. GitHub runs createGitHubForge over a scripted gh; Azure DevOps runs
 * createAzureDevOpsForge over the adapter's recorded-format fixtures behind
 * the factory guard.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { runFactorySetup } from '../../../cli/commands/factory-setup.js';
import { adoFixtureExec, adoFixtureKey, loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { createForge } from '../../../forge/index.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { adoWorld, fakeExec, githubWorld, QUERY_ID, SETUP_ADO_FIXTURES, setupDeps, type FakeWorld } from './harness.js';

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const AC = '## Acceptance criteria\n- `omg x` exits 0\n';
const projectFile = (w: FakeWorld) => join(w.root, '.copilot', 'omg.jsonc');
const ADAPTER_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'forge', 'ado', '__tests__', 'fixtures');

afterEach(() => {
  process.exitCode = undefined;
});

/** The wizard fakes plus the gh reads the GitHub adapter and the check scorer make. */
function githubExec(w: FakeWorld, issues: Record<number, { title: string; body: string; labels?: string[]; state?: string }>, prs: Record<number, number> = {}): Exec {
  const base = fakeExec(w);
  return (cmd, args, opts) => {
    const a = args.join(' ');
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(Object.keys(issues).map((n) => ({ number: Number(n) }))));
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      const i = issues[Number(args[2])];
      if (!i) return { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue' };
      return ok(JSON.stringify({ title: i.title, body: i.body, state: i.state ?? 'OPEN', url: `https://github.com/acme/widgets/issues/${args[2]}`, author: { login: 'acme' }, comments: [], labels: (i.labels ?? []).map((name) => ({ name })) }));
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      const n = Number(/issue-(\d+)$/.exec(args[3])?.[1]);
      return ok(JSON.stringify(prs[n] ? [{ number: prs[n], state: 'OPEN' }] : []));
    }
    if (cmd === 'git' && args[0] === 'ls-remote') return ok('');
    if (cmd === 'git' && a.startsWith('rev-parse --verify refs/remotes/origin/')) return { status: 1, stdout: '', stderr: 'fatal: Needed a single revision' };
    return base(cmd, args, opts);
  };
}

describe('omg factory setup end to end', () => {
  it('GitHub: the preview shows the real check buckets, control characters stripped, in --json', async () => {
    const w = githubWorld();
    const exec = githubExec(
      w,
      {
        7: { title: 'Add the export button', body: `Export the report.\n\n${AC}` },
        8: { title: 'Fix the \u001b[31mlogin\u0007 bug', body: 'No criteria here' },
        9: { title: 'Already has a PR', body: `Do it.\n\n${AC}` },
      },
      { 9: 90 },
    );
    const r = await runFactorySetup({ intake: 'label:factory', yes: true, json: true }, setupDeps(w, { exec, createForge, previewCheck: undefined }), w.root);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.forge).toMatchObject({ kind: 'github', owner: 'acme', name: 'widgets' });
    expect(r.auth?.ok).toBe(true);
    expect(r.written).toEqual([projectFile(w)]);
    expect(r.previewError).toBeUndefined();
    const byId = Object.fromEntries(r.preview.map((p) => [p.id, p]));
    expect(byId[7].readiness).toMatch(/^runnable/);
    expect(byId[8].readiness).toMatch(/^needs-plan/);
    expect(byId[9].readiness).toBe('blocked: pr-exists');
    expect(byId[8].title).toBe('Fix the login  bug');
    const json = JSON.stringify(r);
    expect(json).not.toContain('\\u001b');
    expect(json).not.toContain('\\u0007');
    expect(r.preview.every((p) => !p.readiness.includes('omg factory check'))).toBe(true);
  });

  it('GitHub: a token in an adapter error is redacted from previewError', async () => {
    const w = githubWorld();
    const base = githubExec(w, {});
    const exec: Exec = (cmd, args, opts) => (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list'
      ? { status: 1, stdout: '', stderr: 'HTTP 401 token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }
      : base(cmd, args, opts));
    const r = await runFactorySetup({ intake: 'label:factory', yes: true, json: true }, setupDeps(w, { exec, createForge, previewCheck: undefined }), w.root);
    expect(r.exitCode).toBe(0);
    expect(r.previewError).toBeDefined();
    expect(r.previewError).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  /** The wizard's ADO fixtures plus the adapter's; `bodies` records each --in-file az received (path and JSON). */
  function adoE2e(w: FakeWorld) {
    // The adapter fixtures answer the saved query and the WIQL under their own GUID and limit; the wizard validates QUERY_ID and previews 10.
    const setupFixtures = loadAdoFixtures(SETUP_ADO_FIXTURES);
    const taken = new Set(setupFixtures.map(adoFixtureKey));
    const fixtures = [
      ...setupFixtures,
      ...loadAdoFixtures(ADAPTER_FIXTURES).filter((f) => !taken.has(adoFixtureKey(f))).map((f) => {
        if (f.name === 'wit.wiql.GET.saved-query.json') return { ...f, routeParameters: { ...f.routeParameters, id: QUERY_ID }, queryParameters: { $top: '10' } };
        return f.name === 'wit.wiql.POST.query.json' ? { ...f, queryParameters: { $top: '10' } } : f;
      }),
    ];
    const az = adoFixtureExec(fixtures);
    const base = fakeExec(w);
    const bodies: Array<{ inFile: string; body: unknown }> = [];
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return ok('');
      if (cmd === 'git' && args.join(' ').startsWith('rev-parse --verify refs/remotes/origin/')) return { status: 1, stdout: '', stderr: 'fatal: Needed a single revision' };
      if (cmd === 'az' && args[0] === 'devops' && args[1] === 'invoke') {
        const at = args.indexOf('--in-file');
        if (at >= 0) bodies.push({ inFile: args[at + 1], body: JSON.parse(readFileSync(args[at + 1], 'utf8')) });
        return az(cmd, args);
      }
      return base(cmd, args, opts);
    };
    return { exec, bodies };
  }

  it.each([
    ['area-tag:Web\\Factory#factory', "[System.AreaPath] UNDER 'Web\\Factory' AND [System.Tags] CONTAINS 'factory'"],
    ['board-column:Web Team/Stories/Ready', "[WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column] = 'Ready'"],
  ])('Azure DevOps %s: the preview queries wit.wiql.POST through the check guard', async (intake, where) => {
    const w = adoWorld();
    const { exec, bodies } = adoE2e(w);
    const r = await runFactorySetup({ intake, yes: true, json: true }, setupDeps(w, { exec, createForge, previewCheck: undefined }), w.root);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.previewError).toBeUndefined();
    expect(r.preview.map((p) => p.id)).toEqual([42]);
    expect(r.preview[0].readiness).toMatch(/^(runnable|needs-plan|blocked)/);
    // One WIQL body, the guard's validated copy, built by escapeWiql from the config.
    expect(bodies).toEqual([{ inFile: expect.stringMatching(/omg-ado-body-[^/\\]+[/\\]body\.json$/), body: { query: expect.stringContaining(where) } }]);
  });

  it('Azure DevOps: detect -> auth -> intake -> progress -> write -> preview with real buckets', async () => {
    const w = adoWorld();
    const { exec } = adoE2e(w);
    const r = await runFactorySetup({ intake: `wiql-query:${QUERY_ID}`, yes: true, json: true }, setupDeps(w, { exec, createForge, previewCheck: undefined }), w.root);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.forge).toMatchObject({ kind: 'azure-devops', owner: 'contoso', project: 'Web', name: 'web-app' });
    expect(r.written).toEqual([projectFile(w)]);
    expect(readFileSync(projectFile(w), 'utf8')).toContain(QUERY_ID);
    expect(r.previewError).toBeUndefined();
    expect(r.preview.map((p) => p.id).sort()).toEqual([42, 44]);
    const item42 = r.preview.find((p) => p.id === 42)!;
    expect(item42.title).toBe('Add CSV export to the report page');
    expect(item42.readiness).toMatch(/^(runnable|needs-plan|blocked)/);
    expect(r.preview.every((p) => !p.readiness.includes('omg factory check'))).toBe(true);
  });

  it('Azure DevOps: a PAT in az stderr is redacted from previewError', async () => {
    const w = adoWorld();
    const pat = 'a'.repeat(52);
    const fixtures = loadAdoFixtures(SETUP_ADO_FIXTURES);
    const az = adoFixtureExec(fixtures);
    const base = fakeExec(w);
    const exec: Exec = (cmd, args, opts) => {
      if (cmd === 'az' && args[0] === 'devops' && args[1] === 'invoke') {
        try { return az(cmd, args); } catch { return { status: 1, stdout: '', stderr: `ERROR: TF400813 for PAT ${pat}` }; }
      }
      return base(cmd, args, opts);
    };
    const r = await runFactorySetup({ intake: `wiql-query:${QUERY_ID}`, yes: true, json: true }, setupDeps(w, { exec, createForge, previewCheck: undefined }), w.root);
    expect(r.previewError).toContain('***');
    expect(JSON.stringify(r)).not.toContain(pat);
  });
});
