/**
 * mergeDecision's protected paths on Azure DevOps: a PR touching an Azure
 * Pipelines definition needs the owner, as one touching ship's
 * PROTECTED_PATHS does. Without a forge (GitHub) the rule is ship's as is.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIP_CONFIG } from '../../../ship/config.js';
import { protectedChanges } from '../../../ship/merge.js';
import { ADO_PIPELINE_PATHS } from '../lane-commit.js';
import { mergeDecision } from '../merge-policy.js';
const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const OWNER = /PR touches merge-rule files \((.*)\); only the owner may merge it/;
/** git diff base...head lists `files`; nothing else runs (no verdict, so no commit walk). */
const diffExec = (files) => (cmd, args) => {
    if (cmd === 'git' && args[0] === 'diff')
        return { status: 0, stdout: files.map((f) => `${f}\0`).join(''), stderr: '' };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
};
const forge = {
    reviews: { prHead: () => ({ headRefOid: HEAD }) },
    checks: { checks: () => [], runsForHead: () => [], jobLog: () => ({ ok: false, text: '' }) },
    merge: { blockingPolicies: () => [], humanMergeCommand: () => ['az', 'merge'] },
};
const ship = { verdicts: [], housekeepingCommits: [], phase: 'ready', base: 'dev', implementer: 'lane' };
const view = { number: 17, state: 'OPEN', isDraft: false, baseRefName: 'dev', baseRefOid: BASE, headRefOid: HEAD };
const ownerHit = (files) => mergeDecision(diffExec(files), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], forge).reasons.map((r) => OWNER.exec(r)?.[1]).find(Boolean);
describe('mergeDecision on Azure DevOps', () => {
    it('a PR touching an Azure Pipelines definition needs the owner', () => {
        expect(ownerHit(['src/a.ts', 'azure-pipelines.yml'])).toBe('azure-pipelines.yml');
        expect(ownerHit(['.Azure-Pipelines/ci.yml'])).toBe('.Azure-Pipelines/ci.yml');
        expect(ownerHit(['.azuredevops/x.md', '.pipelines/build.yaml', 'azure-pipelines.yaml'])).toBe('.azuredevops/x.md, .pipelines/build.yaml, azure-pipelines.yaml');
        expect(ownerHit(['src/a.ts', 'docs/azure-pipelines.yml'])).toBeUndefined();
    });
    it('review-498 M1: only checks that ran and SUCCEEDED are listed for auto-merge (SKIPPED and NEUTRAL pass the gate, not this list)', () => {
        const states = (list) => ({ ...forge, checks: { ...forge.checks, checks: () => list.map(([name, state]) => ({ name, state })) } });
        const skipped = mergeDecision(diffExec(['docs/a.md']), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], states([['Docs', 'SKIPPED'], ['Lint', 'NEUTRAL']]));
        expect(skipped.checks).toEqual([]);
        const ran = mergeDecision(diffExec(['docs/a.md']), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], states([['Docs', 'SKIPPED'], ['Test', 'SUCCESS']]));
        expect(ran.checks).toEqual(['Test']);
        // review-498b N6: the SKIPPED and NEUTRAL checks are listed too, so auto-merge without required checks can refuse them.
        expect(skipped.unsettled).toEqual(['Docs', 'Lint']);
        expect(ran.unsettled).toEqual(['Docs']);
    });
    it('sanitises an Azure DevOps branch policy name in the reason', () => {
        const evil = 'Build`) [x](https://evil.example) @team | cell\nline2';
        const policies = { ...forge, merge: { ...forge.merge, blockingPolicies: () => [`${evil}: rejected`] } };
        const reasons = mergeDecision(diffExec(['docs/a.md']), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], policies).reasons;
        expect(reasons).toContain("Azure DevOps branch policy: `Build') [x](https://evil.example) ＠team ¦ cell line2: rejected`");
    });
    it('review-528 L2: a long Azure DevOps policy reason keeps its trailing status (160 cap, not 80)', () => {
        const reason = `${'Required reviewers for the platform and release teams on main '.repeat(2)}: rejected`;
        expect(reason.length).toBeGreaterThan(80);
        expect(reason.length).toBeLessThanOrEqual(160);
        const policies = { ...forge, merge: { ...forge.merge, blockingPolicies: () => [reason] } };
        const reasons = mergeDecision(diffExec(['docs/a.md']), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], policies).reasons;
        expect(reasons).toContain(`Azure DevOps branch policy: \`${reason.replace(/\s+/g, ' ')}\``);
        const huge = mergeDecision(diffExec(['docs/a.md']), '/repo', ship, view, DEFAULT_SHIP_CONFIG, [], { ...policies, merge: { ...policies.merge, blockingPolicies: () => ['x'.repeat(400)] } }).reasons;
        expect(huge).toContain(`Azure DevOps branch policy: \`${'x'.repeat(160)}\``);
    });
    it('ship\'s PROTECTED_PATHS stay as they are: the Azure Pipelines paths are not in them', () => {
        expect(protectedChanges(['azure-pipelines.yml', '.pipelines/x.yml'])).toEqual([]);
        expect(protectedChanges(['azure-pipelines.yml'], ADO_PIPELINE_PATHS)).toEqual(['azure-pipelines.yml']);
    });
});
//# sourceMappingURL=merge-policy.test.js.map