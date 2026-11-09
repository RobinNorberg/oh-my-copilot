import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetCommand } from '../budget.js';
import { ledgerPath, recordUsage } from '../../../budget/ledger.js';
let root;
let project;
const rec = (credits, over = {}) => ({ credits, premiumRequests: 1, source: 'measured', detail: 'test', updatedAt: '2026-11-09T00:00:00.000Z', ...over });
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-by-role-'));
    project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    vi.stubEnv('OMC_STATE_DIR', join(root, 'state'));
    vi.stubEnv('COPILOT_HOME', join(root, 'copilot-home'));
    vi.stubEnv('APPDATA', join(root, 'appdata'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'appdata'));
    vi.stubEnv('OMC_BUDGET_GOVERNOR', '');
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});
async function run(options) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
        const code = await budgetCommand('status', options, project);
        return { code, out: log.mock.calls.map((c) => String(c[0])), err: error.mock.calls.map((c) => String(c[0])) };
    }
    finally {
        log.mockRestore();
        error.mockRestore();
    }
}
describe('omg budget status --by', () => {
    it('groups by role in JSON, with old untagged records in their own bucket', async () => {
        const path = ledgerPath(project);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 1, since: '2026-10-01T00:00:00.000Z', notified: {}, teams: {}, sessions: { old: rec(1) } }));
        recordUsage(path, 'factory-lane:issue-1-review-1', rec(2, { tag: { kind: 'factory-lane', role: 'review', run: 'issue-1' } }));
        const { code, out } = await run({ json: true, by: 'role' });
        expect(code).toBe(0);
        const json = JSON.parse(out[0]);
        expect(json.by.field).toBe('role');
        expect(json.by.groups.map((g) => [g.key, g.credits])).toEqual([['review', 2], ['untagged', 1]]);
        expect(json.totals.credits).toBe(3);
    });
    it('prints the groups in text and leaves the default output alone without --by', async () => {
        recordUsage(ledgerPath(project), 'a', rec(2, { tag: { kind: 'factory-lane', role: 'fix' } }));
        const withBy = await run({ by: 'role' });
        expect(withBy.out.join('\n')).toMatch(/by role:\n\s+fix: .*2.* over 1 record/);
        const plain = await run({});
        expect(plain.out.join('\n')).not.toMatch(/by role/);
        expect(JSON.parse((await run({ json: true })).out[0])).not.toHaveProperty('by');
    });
    it('rejects an unknown field with exit 2', async () => {
        const { code, err } = await run({ by: 'color' });
        expect(code).toBe(2);
        expect(err[0]).toMatch(/role, kind, run/);
    });
});
describe('omg budget reset --by', () => {
    it('is rejected with exit 2 and leaves the ledger alone', async () => {
        recordUsage(ledgerPath(project), 'k1', rec(3));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            expect(await budgetCommand('reset', { by: 'role' }, project)).toBe(2);
            expect(String(error.mock.calls[0]?.[0])).toMatch(/takes no --by/);
        }
        finally {
            error.mockRestore();
        }
    });
});
//# sourceMappingURL=budget-by-role.test.js.map