import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyWrites, planTeamSeeds, TEAM_DECISIONS_SEED, TEAM_ROUTING_SEED } from '../../setup/write.js';
import { decisionsAppendOnly } from '../decisions.js';
import { parseRouting } from '../routing.js';
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omg-seed-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('omg factory setup --team seeds', () => {
    it('plans both files when missing, and the seeds parse as empty routing and a valid log', () => {
        const planned = planTeamSeeds(root);
        expect(planned.map((w) => w.path.replace(root, '').replace(/\\/g, '/'))).toEqual(['/.copilot/team/routing.md', '/.copilot/team/decisions.md']);
        expect(parseRouting(TEAM_ROUTING_SEED)).toEqual({ routes: [], warnings: [] });
        expect(decisionsAppendOnly(TEAM_DECISIONS_SEED, `${TEAM_DECISIONS_SEED}- first\n`).ok).toBe(true);
        expect(applyWrites(planned)).toHaveLength(2);
        expect(planTeamSeeds(root)).toEqual([]);
    });
    it('never overwrites an existing file', () => {
        mkdirSync(join(root, '.copilot', 'team'), { recursive: true });
        writeFileSync(join(root, '.copilot', 'team', 'routing.md'), '| a/** | - | x | - |\n');
        expect(planTeamSeeds(root).map((w) => w.path.replace(/\\/g, '/').split('/').pop())).toEqual(['decisions.md']);
    });
});
//# sourceMappingURL=seeds.test.js.map