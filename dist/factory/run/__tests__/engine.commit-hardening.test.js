/**
 * The engine around the lane commit (audit H3, L3, M3): the process-tree
 * proof, the secret-shape park and its acknowledgement, and the tamper
 * quarantine with its hold. Fake lanes, real git.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FactoryTamperHoldError, readFactoryState } from '../state.js';
import { readTamperHold, releaseTamperHold, tamperHoldPath } from '../tamper-quarantine.js';
import { FakeProcesses, gitIn, ISSUE, remoteHead, review } from './fake-lanes.js';
import { edit, h, run, useSandboxHarness } from './engine-sandbox-harness.js';
useSandboxHarness();
// A fake token of the github-token shape, built so this source file never holds one.
const TOKEN = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
const commonDir = () => gitIn(h.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const implementLanes = () => readFactoryState(h.root, ISSUE).lanes.filter((l) => l.kind === 'implement');
describe('the lane process tree before the commit (H3 layer 1)', () => {
    it('a survivor parks lane-unconfirmed naming its pid; the rerun commits the same worktree without a new lane', async () => {
        const procs = new FakeProcesses();
        procs.tree = { kind: 'survivors', pids: [4711] };
        const out = await run([edit('a.ts', 'a\n')], { processes: procs }).done;
        expect(out.gate?.name, out.message).toBe('lane-unconfirmed');
        expect(out.gate?.reason).toMatch(/pid 4711.*nothing was committed.*rerun omg factory run 7.*no new lane/);
        expect(procs.trees).toEqual([readFactoryState(h.root, ISSUE).lanes[0].worktree]);
        expect(remoteHead(h)).toBeNull();
        expect(readFactoryState(h.root, ISSUE).pendingCommit?.laneId).toBe(implementLanes()[0].id);
        // Still alive at the rerun: parks again.
        const again = await run([], { processes: procs }).done;
        expect(again.gate?.name).toBe('lane-unconfirmed');
        procs.tree = { kind: 'gone', killed: [] };
        const ok = run([review('approve')], { processes: procs });
        const done = await ok.done;
        expect(done.gate?.name, done.message).not.toBe('lane-unconfirmed');
        expect(implementLanes()).toHaveLength(1);
        expect(ok.lanes.started.map((s) => s.profile)).not.toContain('write');
        expect(remoteHead(h)).not.toBeNull();
        expect(readFactoryState(h.root, ISSUE).pendingCommit).toBeUndefined();
    });
    it('a listing that cannot prove the tree gone warns once, notes it, and commits (no park)', async () => {
        const procs = new FakeProcesses();
        procs.tree = { kind: 'unproven', why: 'the process listing failed (CIM unavailable)' };
        const warn = vi.fn();
        const out = await run([edit('a.ts', 'a\n'), review('approve')], { processes: procs, warn }).done;
        expect(out.gate?.name, out.message).not.toBe('lane-unconfirmed');
        expect(remoteHead(h)).not.toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be proven gone (the process listing failed (CIM unavailable))'));
        expect(readFactoryState(h.root, ISSUE).history.map((x) => x.note).join('\n')).toMatch(/process tree not proven/);
    });
});
describe('secret-shaped content (L3)', () => {
    const leaky = edit('src/config.js', `export const token = '${TOKEN}';\n`);
    it('parks naming the path and kind, never the value; nothing is pushed', async () => {
        const out = await run([leaky]).done;
        expect(out.gate?.name, out.message).toBe('secret-shaped-content');
        expect(out.gate?.reason).toContain('src/config.js (github-token)');
        expect(out.gate?.reason).toContain('--allow-secret-shapes');
        expect(JSON.stringify(readFactoryState(h.root, ISSUE))).not.toContain(TOKEN.slice(4));
        expect(out.message).not.toContain(TOKEN.slice(4));
        expect(remoteHead(h)).toBeNull();
    });
    it('a rerun without the flag parks again without a new lane; --allow-secret-shapes commits the same worktree', async () => {
        await run([leaky]).done;
        const again = await run([]).done;
        expect(again.gate?.name).toBe('secret-shaped-content');
        expect(implementLanes()).toHaveLength(1);
        const warn = vi.fn();
        const ok = await run([review('approve')], { allowSecretShapes: true, warn }).done;
        expect(ok.gate?.name, ok.message).not.toBe('secret-shaped-content');
        expect(implementLanes()).toHaveLength(1);
        const head = remoteHead(h);
        expect(gitIn(h.root, 'show', `${head}:src/config.js`)).toContain('export const token');
        const notes = readFactoryState(h.root, ISSUE).history.map((x) => x.note).join('\n');
        expect(notes).toMatch(/secret-shaped content accepted for lane .* src\/config\.js \(github-token\)/);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('--allow-secret-shapes is ignored'));
    });
    it('the human can remove the secret from the worktree instead; the plain rerun then commits', async () => {
        await run([leaky]).done;
        const wt = implementLanes()[0].worktree;
        writeFileSync(join(wt, 'src', 'config.js'), 'export const token = process.env.TOKEN;\n');
        const ok = await run([review('approve')]).done;
        expect(ok.gate?.name, ok.message).not.toBe('secret-shaped-content');
        expect(remoteHead(h)).not.toBeNull();
    });
    it('--allow-secret-shapes without such a park is ignored with a warning', async () => {
        const warn = vi.fn();
        await run([edit('a.ts', 'a\n'), review('approve')], { allowSecretShapes: true, warn }).done;
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('--allow-secret-shapes is ignored'));
    });
    it('factory.run.secretScan.allowPaths from the trusted user config skips fixture paths', async () => {
        const out = await run([edit('test/fixtures/tok.txt', `${TOKEN}\n`), review('approve')], { secretScanUserConfig: { factory: { run: { secretScan: { allowPaths: ['test/fixtures/**'] } } } } }).done;
        expect(out.gate?.name, out.message).not.toBe('secret-shaped-content');
        expect(remoteHead(h)).not.toBeNull();
    });
    it('an allowPaths glob that matches every path is ignored with a warning', async () => {
        const warn = vi.fn();
        const out = await run([edit('a.txt', `${TOKEN}\n`)], { warn, secretScanUserConfig: { factory: { run: { secretScan: { allowPaths: ['**'] } } } } }).done;
        expect(out.gate?.name).toBe('secret-shaped-content');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('matches every path'));
    });
});
describe('tamper quarantine and hold (M3)', () => {
    it('a planted hook, config key and replace ref are quarantined, the hold stops the next run, release --tamper clears it', async () => {
        const before = readFileSync(join(commonDir(), 'config'), 'utf8');
        const planting = (ctx) => {
            const common = commonDir();
            writeFileSync(join(common, 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
            gitIn(h.root, 'config', 'core.fsmonitor', 'evil-monitor');
            const tree = gitIn(h.root, 'rev-parse', 'HEAD^{tree}');
            const fake = gitIn(h.root, 'commit-tree', '-m', 'fake', tree);
            gitIn(h.root, 'update-ref', `refs/replace/${ctx.baseSha}`, fake);
            return edit('a.ts', 'a\n')(ctx);
        };
        const out = await run([planting]).done;
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/Tamper quarantine \(.*\): moved to the quarantine: .*hooks\/pre-commit/);
        expect(out.gate?.reason).toContain('omg factory run release --tamper');
        expect(out.gate?.reason).toMatch(/your own change to \.git during the run/);
        // Moved out of .git, restored, deleted:
        expect(existsSync(join(commonDir(), 'hooks', 'pre-commit'))).toBe(false);
        expect(readFileSync(join(commonDir(), 'config'), 'utf8')).toBe(before);
        expect(gitIn(h.root, 'for-each-ref', 'refs/replace/')).toBe('');
        const hold = readTamperHold(h.ledgerDir, h.root);
        expect(hold && hold !== 'unreadable' ? hold.gate : null).toBe('lane-tampered');
        const q = hold.quarantine;
        expect(readFileSync(join(q, 'hooks', 'pre-commit'), 'utf8')).toContain('planted');
        expect(readFileSync(join(q, 'config'), 'utf8')).toContain('evil-monitor');
        expect(readFileSync(join(q, 'refs.txt'), 'utf8')).toMatch(/refs\/replace\//);
        // The hold refuses the next start (exit 6 busy), before any lock or state write.
        await expect(run([]).done).rejects.toBeInstanceOf(FactoryTamperHoldError);
        await expect(run([]).done).rejects.toThrow(/tamper hold .*quarantine.*omg factory run release --tamper/s);
        const lines = releaseTamperHold(h.ledgerDir, h.root);
        expect(lines.join('\n')).toContain(q);
        expect(lines.join('\n')).toMatch(/moved to the quarantine: \.git\/hooks\/pre-commit/);
        expect(existsSync(tamperHoldPath(h.ledgerDir, h.root))).toBe(false);
        expect(readdirSync(q)).toContain('hooks');
        // Cleared: the next run starts again (it resumes the parked run).
        await expect(run([]).done).resolves.toBeDefined();
    });
    it('the user\'s own `git config` change and branch during the run park this run only: kept in place, copied, listed, no hold', async () => {
        const userEdit = (ctx) => {
            gitIn(h.root, 'config', 'user.email', 'me@example.invalid');
            gitIn(h.root, 'branch', 'mine', 'HEAD');
            return edit('a.ts', 'a\n')(ctx);
        };
        const out = await run([userEdit]).done;
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).toMatch(/not restored: config \(no program-running key changed; left as it is/);
        expect(out.gate?.reason).toMatch(/refs\/heads\/mine was created .*git update-ref -d refs\/heads\/mine/);
        expect(out.gate?.reason).toMatch(/no hold was set/);
        // gitIn passes its own -c user.email: read the file itself.
        expect(readFileSync(join(commonDir(), 'config'), 'utf8')).toContain('me@example.invalid');
        expect(gitIn(h.root, 'rev-parse', '--verify', 'refs/heads/mine')).toMatch(/^[0-9a-f]{40}$/);
        expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
        const q = /Tamper quarantine \(([^)]+)\)/.exec(out.gate.reason)[1];
        expect(readFileSync(join(q, 'config'), 'utf8')).toContain('me@example.invalid');
        expect(readFileSync(join(q, 'refs.txt'), 'utf8')).toContain('refs/heads/mine');
    });
    it('a change outside .git (a file in the main checkout) parks without a quarantine or a hold', async () => {
        const mainEdit = (ctx) => {
            writeFileSync(join(h.root, 'README.md'), 'edited by the user\n');
            return edit('a.ts', 'a\n')(ctx);
        };
        const out = await run([mainEdit]).done;
        expect(out.gate?.name, out.message).toBe('lane-tampered');
        expect(out.gate?.reason).not.toContain('Tamper quarantine');
        expect(readTamperHold(h.ledgerDir, h.root)).toBeNull();
    });
});
//# sourceMappingURL=engine.commit-hardening.test.js.map