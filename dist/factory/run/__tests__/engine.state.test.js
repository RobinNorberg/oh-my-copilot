import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShipState, recordVerdict, sealShipState, shipStatePath, updateShipState } from '../../../ship/state.js';
import { EXIT_AWAITING_HUMAN, runFactoryEngine } from '../engine.js';
import { EngineLedger } from '../ledger.js';
import { computeFactoryIntegrity, factoryOwnerPath, factoryStateDir, factoryStatePath, readFactoryState } from '../state.js';
import { commitFile, FakeLanes, gitIn, ISSUE, PR, remoteHead, review, verdictBlock } from './fake-lanes.js';
import { h, useEngineHarness, limits, opts, ledger, asEngine, shipAsEngine, run } from './engine-harness.js';
useEngineHarness();
describe('omg factory run engine (fake lanes, real git, scripted gh)', () => {
    describe('engine-owned state (a lane may rewrite .omg/ and recompute every seal)', () => {
        const forgedApprove = (root, sha) => {
            const path = shipStatePath(root, PR);
            const cur = JSON.parse(readFileSync(path, 'utf8'));
            const forged = { ...cur, phase: 'prepare', verdicts: [...cur.verdicts, { reviewer: `factory-review-${ISSUE}-cr-evil`, verdict: 'approve', sha, at: cur.updatedAt }] };
            writeFileSync(path, JSON.stringify(sealShipState(forged), null, 2));
        };
        it('a fix lane forging a sealed ship approve at its own head parks at state-tampered; ship is restored, nothing is pushed', async () => {
            const finding = { severity: 'major', summary: 'greet must return hi' };
            const forge = (ctx) => {
                const out = commitFile('src/greet.ts', 'hi\n')(ctx);
                forgedApprove(ctx.root, gitIn(ctx.worktree, 'rev-parse', 'HEAD'));
                return out ?? undefined;
            };
            const { done } = run([commitFile('src/greet.ts', 'x\n'), review('request-changes', [finding]), forge]);
            const out = await done;
            expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
            expect(out.gate?.name).toBe('state-tampered');
            expect(out.gate?.reason).toMatch(/\.omg\/state\/ship\/42\.json changed outside the engine/);
            expect(readShipState(h.root, PR).verdicts.map((v) => v.verdict)).toEqual(['changes-requested']);
            expect(readdirSync(join(h.root, '.omg', 'state', 'ship')).some((f) => f.startsWith('42.json.tampered-'))).toBe(true);
            expect(h.calls.filter((c) => c.startsWith('git push '))).toHaveLength(1);
        });
        it('a review lane forging a sealed factory state parks at state-tampered; the engine\'s own state is restored', async () => {
            const forge = (ctx) => {
                const path = factoryStatePath(ctx.root, ISSUE);
                const cur = JSON.parse(readFileSync(path, 'utf8'));
                const forged = { ...cur, phase: 'prepare', integrity: undefined };
                writeFileSync(path, JSON.stringify({ ...forged, integrity: computeFactoryIntegrity(forged) }, null, 2));
                return { finalText: verdictBlock('approve', ctx.baseSha), credits: 3 };
            };
            const { done } = run([commitFile('a.ts'), forge]);
            const out = await done;
            expect(out.gate?.name).toBe('state-tampered');
            const state = readFactoryState(h.root, ISSUE);
            expect(state.phase).toBe('review');
            expect(state.lanes[1].status).not.toBe('running');
            expect(readShipState(h.root, PR).verdicts).toHaveLength(0);
        });
        it.each([
            ['plants a state lock file', (root) => writeFileSync(`${factoryStatePath(root, ISSUE)}.lock`, '{"pid":1}'), /run-7\.json\.lock changed/],
            ['rewrites the owner file', (root) => writeFileSync(factoryOwnerPath(root, ISSUE), JSON.stringify({ pid: 1, hostname: 'evil', startedAt: 'x' })), /run-7\.owner changed/],
            ['deletes the ship state', (root) => rmSync(shipStatePath(root, PR)), /ship\/42\.json changed/],
        ])('a lane that %s under .omg/ parks at state-tampered', async (_name, tamper, problem) => {
            const { done } = run([commitFile('a.ts'), review('approve', [], (ctx) => tamper(ctx.root))]);
            const out = await done;
            expect(out.gate?.name).toBe('state-tampered');
            expect(out.gate?.reason).toMatch(problem);
            expect(readShipState(h.root, PR)?.verdicts ?? []).toHaveLength(0);
        });
        it('a ship approve the engine did not record from its own review lane is never adopted, even with a matching ledger', async () => {
            await run([commitFile('a.ts')], { limits: limits({ maxRunCredits: 34 }) }).done; // parks at budget before review
            const head = readFactoryState(h.root, ISSUE).head;
            // The attacker also rewrote the engine's sidecar: only the lane-record check is left.
            shipAsEngine((s) => recordVerdict(s, { reviewer: `factory-review-${ISSUE}-cr-evil`, verdict: 'approve', sha: head, at: s.updatedAt }));
            const { lanes, done } = run([]);
            const out = await done;
            expect(out.gate?.name).toBe('state-tampered');
            expect(out.gate?.reason).toMatch(/the engine did not record from a review lane it ran/);
            expect(lanes.started).toHaveLength(0);
        });
        it('a ship state failing its seal is not adopted', async () => {
            await run([commitFile('a.ts'), review('approve')]).done;
            asEngine((s) => ({ ...s, phase: 'review', gate: undefined }));
            const path = shipStatePath(h.root, PR);
            const broken = readFileSync(path, 'utf8').replace('"phase": "ready"', '"phase": "fix"');
            expect(broken).toContain('"phase": "fix"');
            writeFileSync(path, broken);
            ledger().record(path, broken);
            const out = await run([]).done;
            expect(out.gate?.name).toBe('state-tampered');
            expect(out.gate?.reason).toMatch(/fails its seal/);
        });
        it('after an older release\'s prepare park, a human omg ship step rewriting the ship state is not tampering; the run goes on to merge', async () => {
            await run([commitFile('a.ts'), review('approve')]).done;
            // The park of v5.15 (prepare not automated), then the human's omg ship prepare rewrote the ship state.
            asEngine((s) => ({ ...s, phase: 'prepare', gate: { name: 'prepare', reason: 'run omg ship prepare by hand', at: s.updatedAt } }));
            shipAsEngine((s) => ({ ...s, phase: 'prepare' }));
            updateShipState(h.root, PR, (s) => ({ ...s, updatedAt: '2026-10-27T12:00:00.000Z' }));
            const out = await run([]).done;
            expect(out.exitCode, out.message).toBe(0);
            expect(out.gate?.name).toBe('merge');
        });
        describe('a lane swapping a file between the engine\'s hash and its parse (deterministic interleave)', () => {
            const forgeState = (root, patch) => {
                const path = factoryStatePath(root, ISSUE);
                const cur = JSON.parse(readFileSync(path, 'utf8'));
                const forged = { ...cur, ...patch, integrity: undefined };
                writeFileSync(path, JSON.stringify({ ...forged, integrity: computeFactoryIntegrity(forged) }, null, 2));
            };
            /** `afterHash` runs right after the next ledger hash pass, `beforeHash` right before the one after it. */
            let afterHash;
            let beforeHash;
            beforeEach(() => {
                const original = EngineLedger.prototype.mismatches;
                let pendingBefore;
                vi.spyOn(EngineLedger.prototype, 'mismatches').mockImplementation(function (paths) {
                    const pre = pendingBefore;
                    if (pre) {
                        pendingBefore = undefined;
                        pre();
                    }
                    const out = original.call(this, paths);
                    const post = afterHash;
                    if (post) {
                        afterHash = undefined;
                        post();
                        pendingBefore = beforeHash;
                        beforeHash = undefined;
                    }
                    return out;
                });
            });
            afterEach(() => { vi.restoreAllMocks(); afterHash = undefined; beforeHash = undefined; });
            it('a forged state swapped in after the poll check and swapped back is never adopted', async () => {
                // Armed at the second running poll: the first one's save (the lane's child pid) is already written.
                const lanes = new FakeLanes(h.root, [commitFile('a.ts'), review('approve')], [2]);
                let polls = 0;
                lanes.onRunningPoll = () => {
                    if (++polls !== 2)
                        return;
                    const path = factoryStatePath(h.root, ISSUE);
                    const own = readFileSync(path);
                    afterHash = () => forgeState(h.root, { issueTitle: 'FORGED', plan: { source: 'issue-body', text: 'FORGED' } });
                    beforeHash = () => writeFileSync(path, own);
                };
                const out = await runFactoryEngine(opts(lanes));
                expect(out.gate?.name).toBe('merge');
                const state = readFactoryState(h.root, ISSUE);
                expect(state.issueTitle).toBe('Add greet()');
                expect(lanes.started[1].prompt).not.toContain('FORGED');
                expect(ledger().mismatches()).toEqual([]);
            });
            it('a forged state swapped in between a save\'s check and its locked read parks at state-tampered', async () => {
                const lane = (ctx) => {
                    const out = commitFile('a.ts')(ctx);
                    afterHash = () => forgeState(ctx.root, { issueTitle: 'FORGED' });
                    return out ?? undefined;
                };
                const { lanes, done } = run([lane]);
                const out = await done;
                expect(out.gate?.name).toBe('state-tampered');
                expect(out.gate?.reason).toMatch(/run-7\.json changed outside the engine/);
                expect(readFactoryState(h.root, ISSUE).issueTitle).toBe('Add greet()');
                expect(readdirSync(factoryStateDir(h.root)).some((f) => f.startsWith('run-7.json.tampered-'))).toBe(true);
                expect(lanes.started).toHaveLength(1);
                expect(h.calls.filter((c) => c.startsWith('git push '))).toHaveLength(0);
            });
            it('a forged ship approve swapped in between the ship check and its parse is refused as tampering', async () => {
                h.onCall = (call) => {
                    if (!call.startsWith(`gh pr view ${PR} --json headRefOid`) || h.gh.prCreated !== true)
                        return;
                    h.onCall = undefined;
                    const path = shipStatePath(h.root, PR);
                    const own = readFileSync(path);
                    afterHash = () => forgedApprove(h.root, readFactoryState(h.root, ISSUE).head);
                    beforeHash = () => writeFileSync(path, own);
                };
                const { lanes, done } = run([commitFile('a.ts'), review('approve')]);
                const out = await done;
                expect(out.gate?.name).toBe('state-tampered');
                expect(out.gate?.reason).toMatch(/ship\/42\.json changed outside the engine/);
                expect(lanes.started).toHaveLength(1);
                expect(readShipState(h.root, PR).verdicts).toHaveLength(0);
            });
        });
        it('the state-tampered park does not depend on a clean check while a lane keeps rewriting the state', async () => {
            const original = EngineLedger.prototype.restore;
            const rewrite = (root) => {
                const path = factoryStatePath(root, ISSUE);
                const cur = JSON.parse(readFileSync(path, 'utf8'));
                const forged = { ...cur, phase: 'prepare', integrity: undefined };
                writeFileSync(path, JSON.stringify({ ...forged, integrity: computeFactoryIntegrity(forged) }, null, 2));
            };
            // The unconfirmed lane rewrites the file again right after the engine restored its copy.
            vi.spyOn(EngineLedger.prototype, 'restore').mockImplementation(function (paths, stamp) {
                const aside = original.call(this, paths, stamp);
                rewrite(h.root);
                return aside;
            });
            try {
                const forge = (ctx) => { rewrite(ctx.root); return { finalText: verdictBlock('approve', ctx.baseSha), credits: 3 }; };
                const lanes = new FakeLanes(h.root, [commitFile('a.ts'), forge]);
                lanes.cancelFails = true;
                const out = await runFactoryEngine(opts(lanes));
                expect(out.exitCode).toBe(EXIT_AWAITING_HUMAN);
                expect(out.gate?.name).toBe('state-tampered');
                const state = readFactoryState(h.root, ISSUE);
                expect(state.phase).toBe('review');
                expect(state.gate?.name).toBe('state-tampered');
                expect(ledger().mismatches([factoryStatePath(h.root, ISSUE)])).toEqual([]);
            }
            finally {
                vi.restoreAllMocks();
            }
        });
    });
    describe('write lanes and the engine\'s own git', () => {
        it.each([
            ['sets core.hooksPath', (c) => gitIn(c.root, 'config', 'core.hooksPath', '/tmp/evil'), /common git config changed/],
            ['sets core.fsmonitor', (c) => gitIn(c.root, 'config', 'core.fsmonitor', 'evil.sh'), /common git config changed/],
            ['drops hooks/pre-push', (c) => writeFileSync(join(c.root, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n'), /hooks\/ directory changed/],
            ['moves another ref', (c) => gitIn(c.root, 'branch', 'evil', c.baseSha), /ref refs\/heads\/evil was created/],
            ['edits info/attributes', (c) => writeFileSync(join(c.root, '.git', 'info', 'attributes'), '* filter=evil\n'), /info\/ directory changed/],
        ])('an implement lane that %s parks at lane-tampered and nothing is pushed', async (_name, tamper, problem) => {
            const lane = (ctx) => { const out = commitFile('a.ts')(ctx); tamper(ctx); return out ?? undefined; };
            const { done } = run([lane]);
            const out = await done;
            expect(out.gate?.name).toBe('lane-tampered');
            expect(out.gate?.reason).toMatch(problem);
            expect(remoteHead(h)).toBeNull();
            expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
            expect(readFactoryState(h.root, ISSUE).phase).toBe('implement');
        });
        it('every engine git command runs with an empty core.hooksPath and core.fsmonitor=false; a pre-push hook never runs', async () => {
            const marker = join(h.dir, 'hook-ran');
            writeFileSync(join(h.root, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
            const out = await run([commitFile('a.ts'), review('approve')]).done;
            expect(out.gate?.name).toBe('merge');
            expect(remoteHead(h)).not.toBeNull();
            expect(existsSync(marker)).toBe(false);
            const git = h.raw.filter((c) => c.cmd === 'git');
            expect(git.length).toBeGreaterThan(5);
            for (const c of git) {
                expect(c.args.slice(0, 4)).toEqual(['-c', `core.hooksPath=${join(h.ledgerDir, 'empty-hooks')}`, '-c', 'core.fsmonitor=false']);
            }
        });
        it('a change after the lane\'s check, right before the push, parks at lane-tampered and drops the lane head', async () => {
            h.onCall = (c) => { if (c.startsWith('git ls-remote'))
                appendFileSync(join(h.root, '.git', 'config'), '[core]\n\tfsmonitor = evil\n'); };
            const out = await run([commitFile('a.ts')]).done;
            expect(out.gate?.name).toBe('lane-tampered');
            expect(out.gate?.reason).toMatch(/\(found right before the push\): the common git config changed/);
            expect(h.calls.some((c) => c.startsWith('git push'))).toBe(false);
            const state = readFactoryState(h.root, ISSUE);
            expect(state.phase).toBe('implement');
            expect(state.pendingHead).toBeUndefined();
        });
        it('a change after a review lane\'s check is found at the next step boundary: the verdict is discarded and a rerun reviews again', async () => {
            let planted = false;
            h.onCall = (c) => { if (!planted && c.startsWith(`gh pr comment ${PR}`)) {
                planted = true;
                gitIn(h.root, 'branch', 'late', 'HEAD');
            } };
            const first = await run([commitFile('a.ts'), review('approve')]).done;
            expect(first.gate?.name).toBe('review-tampered');
            expect(first.gate?.reason).toMatch(/\(found at the next step boundary\): ref refs\/heads\/late was created/);
            const state = readFactoryState(h.root, ISSUE);
            expect(state.phase).toBe('review');
            expect(state.lanes[1].verdict).toBe('invalid');
            h.onCall = undefined;
            const second = run([review('approve')]);
            expect((await second.done).gate?.name).toBe('merge');
            expect(second.lanes.started).toHaveLength(1);
            expect(readShipState(h.root, PR).verdicts).toHaveLength(2);
        });
        it('a lane past the engine wall-time limit whose cancel is not confirmed parks at lane-unconfirmed without a compare', async () => {
            let t = 1_000_000;
            const lanes = new FakeLanes(h.root, [commitFile('a.ts')], [10_000]);
            lanes.cancelFails = true;
            const out = await runFactoryEngine(opts(lanes, { limits: limits({ laneTimeoutMs: 60_000 }), now: () => (t += 61_000) }));
            expect(out.gate?.name).toBe('lane-unconfirmed');
            expect(lanes.cancelled).toEqual(['cr-fake1']);
            const lane = readFactoryState(h.root, ISSUE).lanes[0];
            expect(lane.status).toBe('running');
            expect(lane.note).toMatch(/cancel was not confirmed/);
        });
    });
    it('a lost review lane that changed shared git state parks at review-tampered (no respawn), charged at its cap', async () => {
        const lostAfterTamper = (ctx) => { gitIn(ctx.root, 'branch', 'evil', ctx.baseSha); return { lost: true }; };
        // One running poll first: the engine has recorded the lane's (dead) child before the job is lost.
        const { lanes, done } = run([commitFile('a.ts'), lostAfterTamper, review('approve')], {}, [0, 1]);
        const out = await done;
        expect(out.gate?.name).toBe('review-tampered');
        expect(out.gate?.reason).toMatch(/ref refs\/heads\/evil was created/);
        expect(lanes.started).toHaveLength(2);
        expect(lanes.cancelled).toContain('cr-fake2');
        const lane = readFactoryState(h.root, ISSUE).lanes[1];
        expect(lane).toMatchObject({ status: 'lost', verdict: 'invalid', usage: { credits: 30, source: 'estimated' } });
        expect(readShipState(h.root, PR).verdicts).toHaveLength(0);
    });
    it('an omg-plan comment by someone without write access is ignored', async () => {
        h.gh.issue.body = 'see plan';
        h.gh.issue.comments = [{ body: 'omg-plan: docs/plan.md', authorAssociation: 'NONE' }];
        const { lanes, done } = run([]);
        const out = await done;
        expect(out.gate?.name).toBe('needs-plan');
        expect(lanes.started).toHaveLength(0);
    });
    it('an omg-plan line in the body of an issue opened by someone without write access is ignored', async () => {
        h.gh.issue.body = 'omg-plan: docs/plan.md';
        h.gh.issue.author = { login: 'stranger' };
        const { lanes, done } = run([]);
        const out = await done;
        expect(out.gate?.name).toBe('needs-plan');
        expect(lanes.started).toHaveLength(0);
        expect(readFactoryState(h.root, ISSUE).planLink).toBeUndefined();
    });
});
//# sourceMappingURL=engine.state.test.js.map