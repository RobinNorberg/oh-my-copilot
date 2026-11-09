import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_SETTINGS, buildSandboxConfig } from '../sandbox.js';
let root;
let ctx;
const host = { supported: true, capabilities: { shell: true, denied_paths: true } };
const denied = (c) => buildSandboxConfig('write', c, host).userPolicy.filesystem.deniedPaths ?? [];
beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'omg-sbx-state-'));
    ctx = {
        worktree: join(root, 'wt'),
        commonGitDir: join(root, 'repo', '.git'),
        pluginRoot: join(root, 'plugin'),
        jobHome: join(root, 'job', 'home'),
        jobDir: join(root, 'job'),
        realHome: join(root, 'me'),
        platform: 'linux',
        settings: { ...DEFAULT_SANDBOX_SETTINGS, allowedHosts: [], extraReadonlyPaths: [], extraReadwritePaths: [] },
    };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('the OMC global state root is denied to the lane', () => {
    it('denies a state root outside the home on every platform', () => {
        const stateRoot = join(root, 'omc-home', 'state');
        for (const platform of ['linux', 'win32', 'darwin']) {
            expect(denied({ ...ctx, platform, omcStateRoot: stateRoot }), platform).toContain(stateRoot);
        }
    });
    it('adds nothing for a root the home deny already covers (~/.omg/state)', () => {
        const before = denied({ ...ctx, omcStateRoot: join(ctx.realHome, '.omg', 'state') });
        expect(before.some((p) => p.endsWith('state'))).toBe(false);
    });
    it('denies only the sensitive children when a grant lives inside the root (the job dir under it)', () => {
        const stateRoot = join(root, 'omc-home', 'state');
        const inside = { ...ctx, omcStateRoot: stateRoot, jobHome: join(stateRoot, 'team-jobs', 'j1', 'home'), jobDir: join(stateRoot, 'team-jobs', 'j1') };
        const list = denied(inside);
        expect(list).not.toContain(stateRoot);
        for (const child of ['forge', 'factory-ledger', 'budget-ledger.json', 'budget'])
            expect(list).toContain(join(stateRoot, child));
        expect(list).not.toContain(join(stateRoot, 'team-jobs'));
    });
    it('a home that holds the state root keeps it denied only when no grant is inside it', () => {
        // realHome is itself a grant: a state root under it is not a parent of a grant, so it is denied whole.
        const stateRoot = join(ctx.realHome, 'state-elsewhere');
        expect(denied({ ...ctx, omcStateRoot: stateRoot })).toContain(stateRoot);
    });
    it('the review profile is unaffected (it has no deny list)', () => {
        expect(buildSandboxConfig('review', { ...ctx, omcStateRoot: join(root, 'x') }, host).userPolicy.filesystem).not.toHaveProperty('deniedPaths');
    });
});
//# sourceMappingURL=sandbox.state-deny.test.js.map