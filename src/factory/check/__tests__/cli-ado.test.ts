/**
 * `omg factory check` end to end on Azure DevOps: runFactoryCheck with the
 * real createForge (the ADO adapter) over the adapter's fixture world
 * (src/forge/ado/__tests__/fixtures), so the CLI path builds the az guard
 * itself. ado.test.ts builds the guard by hand; this one does not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoFixtureExec, loadAdoFixtures } from '../../../forge/ado/__tests__/fixtures.js';
import { POSIX_ENTRY } from '../../../forge/ado/__tests__/world.js';
import { createForge } from '../../../forge/index.js';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { runFactoryCheck, type CheckJson, type FactoryCheckDeps, type FactoryCheckOptions } from '../cli.js';

const SHA = 'a'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omg-check-ado-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The git reads of an ADO checkout, and the ADO fixtures for every az call; `az` records what reached the fixtures. */
function world() {
  const fixtures = adoFixtureExec(loadAdoFixtures());
  const az: string[][] = [];
  const exec: Exec = (cmd, args, opts) => {
    const a = args.join(' ');
    if (cmd === 'git') {
      if (a === 'rev-parse --show-toplevel') return ok(`${root}\n`);
      if (a === 'remote get-url origin') return ok('https://dev.azure.com/contoso/Web/_git/web-app\n');
      if (a === 'fetch origin dev') return ok();
      if (a === 'rev-parse --verify refs/remotes/origin/dev') return ok(`${SHA}\n`);
      if (a === `cat-file -e ${SHA}^{commit}`) return ok();
      if (args[0] === 'ls-remote') return ok('');
      if (args[0] === 'show') return { status: 128, stdout: '', stderr: `fatal: path does not exist in '${SHA}'` };
      throw new Error(`unscripted git ${a}`);
    }
    az.push([cmd, ...args]);
    return fixtures(cmd, args, opts);
  };
  return { exec, az };
}

function deps(exec: Exec, over: Partial<FactoryCheckDeps> = {}): FactoryCheckDeps {
  return {
    exec,
    base: () => 'dev',
    trustedUser: () => undefined,
    projectConfig: () => undefined,
    createForge,
    resolveAz: () => POSIX_ENTRY,
    isTTY: () => false,
    confirm: async () => false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}

const run = (exec: Exec, o: Partial<FactoryCheckOptions>, over: Partial<FactoryCheckDeps> = {}) => runFactoryCheck({ ids: [], ...o }, deps(exec, over));
const methodOf = (args: string[]) => (args.includes('--http-method') ? args[args.indexOf('--http-method') + 1] : 'GET');

describe('omg factory check on Azure DevOps (runFactoryCheck + the real adapter)', () => {
  it('buckets work item 42 through the guarded az reads: the CLI hands the guard the forge repo and the az entry', async () => {
    const w = world();
    expect(await run(w.exec, { ids: ['42'], json: true })).toBe(0);
    const json = JSON.parse(out.join('\n')) as CheckJson;
    expect(json).toMatchObject({ ok: true, forge: 'azure-devops', repo: 'https://dev.azure.com/contoso/Web/_git/web-app', counts: { runnable: 0, 'needs-plan': 0, blocked: 1 } });
    expect(json.items).toEqual([expect.objectContaining({ id: 42, bucket: 'blocked', reasons: ['pr-exists'] })]);
    expect(w.az.length).toBeGreaterThan(0);
    // The adapter spawns the entry the CLI resolved, and only reads ran.
    expect(w.az.every(([cmd]) => cmd === POSIX_ENTRY.command)).toBe(true);
    expect(w.az.every((c) => methodOf(c) === 'GET')).toBe(true);
  });

  it('an area-tag source queries through wit.wiql.POST and prints the bucket table', async () => {
    const w = world();
    expect(await run(w.exec, { ids: [], source: "area-tag:Web\\Factory's#factory" })).toBe(0);
    expect(out.join('\n')).toMatch(/#42\s+blocked/);
    expect(w.az.filter((c) => methodOf(c) === 'POST').map((c) => c[c.indexOf('--resource') + 1])).toEqual(['wiql']);
  });

  it('an az entry that cannot be resolved is incompatible, before any az call', async () => {
    const w = world();
    await expect(run(w.exec, { ids: ['42'], json: true }, { resolveAz: () => { throw new Error('az not found on PATH'); } })).rejects.toThrow(/az not found on PATH/);
    expect(w.az).toEqual([]);
  });
});
