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
    it('ship\'s PROTECTED_PATHS stay as they are: the Azure Pipelines paths are not in them', () => {
        expect(protectedChanges(['azure-pipelines.yml', '.pipelines/x.yml'])).toEqual([]);
        expect(protectedChanges(['azure-pipelines.yml'], ADO_PIPELINE_PATHS)).toEqual(['azure-pipelines.yml']);
    });
});
//# sourceMappingURL=merge-policy.test.js.map