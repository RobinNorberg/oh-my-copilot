import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '../../../ship/exec.js';
import { commitChecksArgs, ghCommitCheckNames, ghRequiredChecks, isRequiredChecksArgs, requiredChecksArgs } from '../checks.js';
import { gateRequirement } from '../../../factory/setup/required-checks.js';
import { assertFactoryCommand } from '../../../factory/run/exec.js';

const REPO = 'github.com/o/r';
const ok = (body: unknown): ExecResult => ({ status: 0, stdout: JSON.stringify(body), stderr: '' });
const no: ExecResult = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };

/** gh api answers by path; anything else fails the test. */
function api(answers: Record<string, ExecResult>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'gh' || args[0] !== 'api') throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    return answers[args[5]] ?? no;
  };
  return { exec, calls };
}

describe('M1: the GitHub required checks of the base (branch protection + rulesets)', () => {
  it('reads exactly the two GETs and joins both sources', () => {
    const { exec, calls } = api({
      'repos/o/r/branches/main': ok({ name: 'main', protection: { enabled: true, required_status_checks: { contexts: ['check', 'ci/circleci'], checks: [{ context: 'check' }] } } }),
      'repos/o/r/rules/branches/main': ok([{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }]),
    });
    expect(ghRequiredChecks(exec, REPO, 'main')).toEqual(['check', 'ci/circleci', 'lint']);
    expect(calls).toEqual(requiredChecksArgs(REPO, 'main').map((a) => ['gh', ...a]));
    expect(calls[0]).toEqual(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', 'repos/o/r/branches/main']);
  });

  it('an unprotected base is [] (every reported check); unreadable everywhere is undefined', () => {
    expect(ghRequiredChecks(api({ 'repos/o/r/branches/dev': ok({ protection: { enabled: false, required_status_checks: { contexts: [] } } }), 'repos/o/r/rules/branches/dev': ok([]) }).exec, REPO, 'dev')).toEqual([]);
    expect(ghRequiredChecks(api({}).exec, REPO, 'dev')).toBeUndefined();
    expect(ghRequiredChecks(api({ 'repos/o/r/branches/dev': { status: 0, stdout: 'not json', stderr: '' } }).exec, REPO, 'dev')).toBeUndefined();
    const throwing: Exec = () => { throw new Error('refused by the guard'); };
    expect(ghRequiredChecks(throwing, REPO, 'dev')).toBeUndefined();
  });

  it('a branch with a slash is encoded; the commit-check reads name check runs and statuses', () => {
    expect(requiredChecksArgs(REPO, 'release/x')[0][5]).toBe('repos/o/r/branches/release%2Fx');
    const { exec } = api({
      'repos/o/r/commits/main/check-runs?per_page=100': ok({ check_runs: [{ name: 'check' }, { name: 'check' }] }),
      'repos/o/r/commits/main/status?per_page=100': ok({ statuses: [{ context: 'ci/circleci' }] }),
    });
    expect(ghCommitCheckNames(exec, REPO, 'main')).toEqual(['check', 'ci/circleci']);
    expect(commitChecksArgs(REPO, 'main')).toHaveLength(2);
  });

  it('the guard shape matches only these GETs on the same repository (commit reads only where allowed)', () => {
    const [branch, rules] = requiredChecksArgs(REPO, 'main');
    const [runs] = commitChecksArgs(REPO, 'main');
    expect(isRequiredChecksArgs(branch, REPO)).toBe(true);
    expect(isRequiredChecksArgs(rules, REPO)).toBe(true);
    expect(isRequiredChecksArgs(runs, REPO)).toBe(false);
    expect(isRequiredChecksArgs(runs, REPO, true)).toBe(true);
    expect(isRequiredChecksArgs(branch, 'github.com/evil/r')).toBe(false);
    expect(isRequiredChecksArgs(branch, undefined)).toBe(false);
    expect(isRequiredChecksArgs([...branch.slice(0, 4), 'POST', branch[5]], REPO)).toBe(false);
    expect(isRequiredChecksArgs([...branch.slice(0, 5), 'repos/o/r/branches/main/protection'], REPO)).toBe(false);
    expect(isRequiredChecksArgs([...branch.slice(0, 5), 'repos/o/r/branches/../../x'], REPO)).toBe(false);
    expect(isRequiredChecksArgs([...branch, '-f', 'x=1'], REPO)).toBe(false);
    expect(isRequiredChecksArgs([...branch.slice(0, 5), 'repos/o/r/branches/..'], REPO)).toBe(false);
  });

  it('factory run allows the two GETs for its own repository and refuses the commit reads', () => {
    const [branch] = requiredChecksArgs(REPO, 'main');
    expect(() => assertFactoryCommand('gh', branch, [], undefined, undefined, undefined, undefined, { repo: REPO })).not.toThrow();
    expect(() => assertFactoryCommand('gh', branch, [], undefined, undefined, undefined, undefined, { repo: 'github.com/o/other' })).toThrow();
    expect(() => assertFactoryCommand('gh', commitChecksArgs(REPO, 'main')[0], [], undefined, undefined, undefined, undefined, { repo: REPO })).toThrow();
  });
});

describe('M1: what setup and check say the gates will require', () => {
  const found = { 'repos/o/r/commits/main/check-runs?per_page=100': ok({ check_runs: [{ name: 'check' }] }), 'repos/o/r/commits/main/status?per_page=100': ok({ statuses: [] }) };

  it('configured names: a note, and a warning for a name the base never reported', () => {
    const g = gateRequirement(api(found).exec, REPO, 'main', ['check', 'Test'], 'the user config');
    expect(g.notes).toEqual(['gates: ship.requiredChecks requires check, Test (and every other reported check must pass); the latest main commit reported: check']);
    expect(g.warnings).toEqual(['ship.requiredChecks name(s) Test match no check reported on the latest main commit (check); a run would park at awaiting-human: missing-checks. Use the exact check names, in the user config']);
  });

  it('no names: the branch protection when readable, else every reported check', () => {
    const protectedBase = { ...found, 'repos/o/r/branches/main': ok({ protection: { required_status_checks: { contexts: ['check'] } } }) };
    expect(gateRequirement(api(protectedBase).exec, REPO, 'main', [], 'x').notes[0]).toBe("gates: no ship.requiredChecks; main's branch protection requires check, so the gates wait for those and every other reported check must pass; the latest main commit reported: check");
    const open = gateRequirement(api(found).exec, REPO, 'main', [], 'the user config');
    expect(open.notes[0]).toBe('gates: no ship.requiredChecks and the branch protection is not readable with your token: the gates require every check GitHub reports for the PR head, once nothing new reported for 120 s; the latest main commit reported: check. To require exact names, set ship.requiredChecks in the user config');
    expect(open.warnings).toEqual([]);
    const noCi = gateRequirement(api({ 'repos/o/r/commits/main/check-runs?per_page=100': ok({ check_runs: [] }), 'repos/o/r/rules/branches/main': ok([]) }).exec, REPO, 'main', [], 'x');
    expect(noCi.notes[0]).toContain('and no required checks in the branch protection');
    expect(noCi.notes[0]).toContain('reported: none. With no CI at all the gates go green with the note "no CI checks are configured for this repository" (the merge stays a human step)');
  });
});

describe('M1 security: a PR cannot turn the gates green by dropping CI definitions', () => {
  it('.github/workflows stays protected at merge; other CI systems\' definitions are lane-protected and protected at the factory merge', async () => {
    const { PROTECTED_PATHS, protectedChanges } = await import('../../../ship/merge.js');
    const { CI_DEFINITION_PATHS, LANE_PROTECTED_PATHS } = await import('../../../factory/run/lane-commit.js');
    expect(PROTECTED_PATHS).toContain('.github/workflows/');
    expect(LANE_PROTECTED_PATHS).toEqual(expect.arrayContaining(['.github/', ...CI_DEFINITION_PATHS]));
    const changed = ['.circleci/config.yml', '.gitlab-ci.yml', 'Jenkinsfile', '.github/workflows/ci.yml', 'src/a.ts'];
    expect(protectedChanges(changed, CI_DEFINITION_PATHS)).toEqual(['.circleci/config.yml', '.gitlab-ci.yml', 'Jenkinsfile', '.github/workflows/ci.yml']);
  });
});
