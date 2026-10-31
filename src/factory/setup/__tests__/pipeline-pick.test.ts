/**
 * The heal pipeline pick of `omg factory setup` on Azure DevOps (ADO parity
 * design §3.2, PR C3): only build definitions of the forge repository, the
 * `repositoryId` query bound to the GUID git.repositories.GET answers for the
 * forge repo, and the pick written to the project file (read from <base>).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { runFactorySetup, type FactorySetupOptions } from '../../../cli/commands/factory-setup.js';
import { adoWorld, githubWorld, QUERY_ID, scriptedPrompter, setupDeps, type FakeWorld } from './harness.js';

const REPO_GUID = '5febef5a-833d-4e14-b9c0-14cb638f91e6';
const projectFile = (w: FakeWorld) => join(w.root, '.copilot', 'omg.jsonc');
const run = (w: FakeWorld, o: FactorySetupOptions, over = {}) => runFactorySetup(o, setupDeps(w, over), w.root);
const invokes = (w: FakeWorld, resource: string) => w.calls.filter((c) => c.cmd === 'az' && c.args[c.args.indexOf('--resource') + 1] === resource);
const query = (args: string[]) => {
  const at = args.indexOf('--query-parameters');
  const out: Record<string, string> = {};
  for (const t of at < 0 ? [] : args.slice(at + 1)) {
    if (t.startsWith('--')) break;
    out[t.slice(0, t.indexOf('='))] = t.slice(t.indexOf('=') + 1);
  }
  return out;
};

describe('omg factory setup: heal pipeline pick (Azure DevOps fixtures)', () => {
  it('--heal-pipeline 9 writes factory.heal.pipeline to the project file; the definitions query names the forge repo GUID', async () => {
    const w = adoWorld();
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, healPipeline: '9', yes: true, json: true });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.config!.heal).toEqual({ pipeline: { definitionId: 9 } });
    expect((parse(readFileSync(projectFile(w), 'utf8')) as { factory: { heal: unknown } }).factory.heal).toEqual({ pipeline: { definitionId: 9 } });
    expect(r.notes.some((n) => /factory\.heal\.pipeline \(build definition 9\) counts once .* is committed on <base>/.test(n))).toBe(true);
    // The repositoryId is the GUID git.repositories.GET answered for web-app, not a value from anywhere else.
    const [defs] = invokes(w, 'definitions');
    expect(query(defs.args)).toEqual({ repositoryId: REPO_GUID, repositoryType: 'TfsGit', includeAllProperties: 'true' });
    const repoRead = invokes(w, 'repositories').at(-1)!;
    expect(repoRead.args).toContain('repositoryId=web-app');
    expect(w.calls.filter((c) => c.cmd === 'az' && c.args[1] === 'invoke').every((c) => c.args[c.args.indexOf('--http-method') + 1] === 'GET')).toBe(true);
  });

  it.each<[string, string, number, RegExp]>([
    ['a definition of another repository', '15', 5, /not a pipeline of repository web-app \(its pipelines: 9, 12\)/],
    ['a definition on another repository type', '16', 5, /not a pipeline of repository web-app/],
    ['an unknown definition', '99', 5, /not a pipeline of repository web-app/],
    ['no id', 'ci', 2, /must be a build definition id or none/],
  ])('--heal-pipeline with %s exits %i and writes nothing', async (_name, id, code, message) => {
    const w = adoWorld();
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, healPipeline: id, yes: true, json: true });
    expect(r.exitCode).toBe(code);
    expect(r.error).toMatch(message);
    expect(existsSync(projectFile(w))).toBe(false);
  });

  it('--heal-pipeline none and the non-interactive default read no definitions and write no heal key', async () => {
    for (const healPipeline of ['none', undefined]) {
      const w = adoWorld();
      const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, yes: true, json: true, ...(healPipeline ? { healPipeline } : {}) });
      expect(r.error).toBeUndefined();
      expect(r.config!.heal).toBeUndefined();
      expect(readFileSync(projectFile(w), 'utf8')).not.toContain('heal');
      expect(invokes(w, 'definitions')).toEqual([]);
    }
  });

  it('interactive: offers none and the forge repo\'s definitions only, names without terminal sequences', async () => {
    const w = adoWorld();
    let offered: readonly string[] = [];
    const scripted = scriptedPrompter(['', '#12 web-app docs (\\docs)', true]);
    const prompter = { ...scripted, select: async (q: string, choices: readonly string[]) => { if (/pipeline is CI/.test(q)) offered = choices; return scripted.select(q, choices); } };
    const r = await run(w, { intake: `wiql-query:${QUERY_ID}`, progress: 'none' }, { isTTY: () => true, prompter });
    expect(r.error).toBeUndefined();
    expect(offered).toEqual(['none (no heal on Azure DevOps)', '#9 web-app CI', '#12 web-app docs (\\docs)']);
    expect(offered.join('')).not.toContain('\u001b');
    expect(r.config!.heal).toEqual({ pipeline: { definitionId: 12 } });
  });

  it('GitHub refuses --heal-pipeline', async () => {
    const w = githubWorld();
    const r = await run(w, { intake: 'label:factory', healPipeline: '9', dryRun: true, json: true });
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/--heal-pipeline are Azure DevOps flags/);
  });
});
