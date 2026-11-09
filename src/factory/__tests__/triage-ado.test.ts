/**
 * `omg factory triage --apply` on Azure DevOps: one PATCH per item (test /rev,
 * test + add of the tag list, add of Microsoft.VSTS.Common.Priority) through
 * the factory guard with the plan's tracker write context.
 */

import { describe, expect, it } from 'vitest';
import { FactorySafetyError, type TrackerWriteContext } from '../run/exec.js';
import { triageGuardExec } from '../triage/cli.js';
import { loadAdoFixtures } from '../../forge/ado/__tests__/fixtures.js';
import { adoWorld, variant } from '../../forge/ado/__tests__/world.js';

const tagged = (tags: string | undefined, priority?: number) =>
  variant(loadAdoFixtures(), 'wit.workItems.GET.42.json', (s) => ({ ...s, fields: { ...s.fields, 'System.Tags': tags, ...(priority === undefined ? {} : { 'Microsoft.VSTS.Common.Priority': priority }) } }));
const writes = (labels: string[]): TrackerWriteContext => ({ repo: 'unused-on-ado', bodyDir: '', labels });

describe('ADO setTriage', () => {
  it('edits the tags and the priority field in one PATCH', () => {
    const { forge, calls, routes } = adoWorld({ writes: writes(['priority:p1', 'needs-plan']), fixtures: tagged('reports; needs-plan', 3) });
    expect(forge.tracker.setTriage!(42, { add: ['priority:p1'], remove: ['needs-plan'], priority: 2 })).toMatchObject({ ok: true });
    expect(routes()).toEqual(['wit.workItems.GET', 'wit.workItems.PATCH']);
    expect(calls[1].body).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'test', path: '/fields/System.Tags', value: 'reports; needs-plan' },
      { op: 'add', path: '/fields/System.Tags', value: 'reports; priority:p1' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
    ]);
  });

  it('writes nothing when nothing changes', () => {
    const { forge, calls } = adoWorld({ writes: writes(['priority:p1']), fixtures: tagged('priority:p1', 2) });
    expect(forge.tracker.setTriage!(42, { add: ['priority:p1'], remove: [], priority: 2 })).toMatchObject({ ok: true, detail: 'already applied' });
    expect(calls.map((c) => c.body).filter(Boolean)).toEqual([]);
  });

  it('the guard refuses a tag off the plan allowlist and a factory: tag, and reports it as a failed item', () => {
    const { forge } = adoWorld({ writes: writes(['priority:p1']), fixtures: tagged('reports') });
    const bad = forge.tracker.setTriage!(42, { add: ['priority:p1', 'needs-split'], remove: [] });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/not on the tracker write allowlist/);
    expect(forge.tracker.setTriage!(42, { add: ['factory:running'], remove: [] }).ok).toBe(false);
  });

  it('a dry run cannot PATCH: triageGuardExec refuses the write while not writing', () => {
    const { guard, calls } = adoWorld();
    const patch = ['devops', 'invoke', '--area', 'wit', '--resource', 'workItems', '--route-parameters', 'project=Web', 'id=42', '--http-method', 'PATCH', '--api-version', '7.1', '--org', 'https://dev.azure.com/contoso'];
    const seen: string[] = [];
    const exec = triageGuardExec((cmd, args) => { seen.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: '{}', stderr: '' }; }, () => writes(['priority:p1']), () => false, () => guard);
    expect(() => exec('az', patch)).toThrow(FactorySafetyError);
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses an assignee: it is not a triage write yet', () => {
    const { forge, calls } = adoWorld({ writes: writes([]) });
    expect(forge.tracker.setTriage!(42, { add: [], remove: [], assignee: 'x' })).toEqual({ ok: false, detail: 'assignee is not a triage write yet' });
    expect(calls).toEqual([]);
  });
});
