/**
 * Opt-in auto-merge on the local forge (auto-merge.ts): real git, fake lanes,
 * the engine-owned mirror. Default stays the human merge park; with
 * factory.merge.auto for this repository in the USER config a docs-only PR
 * merges by the engine; a committed value is ignored; any failed condition,
 * a dirty checkout or a head that moves between the check and the merge
 * falls back to the human park.
 */
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveShipConfig } from '../../../ship/config.js';
import { runFactoryEngine } from '../engine.js';
import { readFactoryState } from '../state.js';
import { commitFile, gitIn, review } from './fake-lanes.js';
import { BASE, lanesFor, LOCAL_ISSUE, localOpts, localWorld } from './engine-local-harness.js';
let w;
afterEach(() => rmSync(w.dir, { recursive: true, force: true }));
const docs = () => commitFile('docs/guide.md', '# Guide\n\nHow to greet.\n');
const auto = (root, entry = { enabled: true, tiers: ['docs'] }) => ({ factory: { merge: { auto: { [root]: entry } } } });
describe('factory run on the local forge: opt-in auto-merge', () => {
    it('off by default: a docs-only PR still parks at the human merge', async () => {
        w = localWorld();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [docs(), review('approve')])));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(out.gate?.reason).not.toMatch(/auto-merge/);
        expect(readFactoryState(w.root, LOCAL_ISSUE).phase).toBe('merge');
    });
    it('on for this repository in the user config: the engine merges the exact head and the run finishes merged', async () => {
        w = localWorld();
        const before = gitIn(w.root, 'rev-parse', BASE);
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [docs(), review('approve')]), { autoMergeUserConfig: auto(w.root) }));
        expect(out.exitCode, out.message).toBe(0);
        const state = readFactoryState(w.root, LOCAL_ISSUE);
        expect(state.phase).toBe('merged');
        const after = gitIn(w.root, 'rev-parse', BASE);
        expect(after).not.toBe(before);
        expect(gitIn(w.root, 'rev-parse', `${after}^2`)).toBe(state.head);
        expect(gitIn(w.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
        const note = state.history.find((h) => h.note.startsWith('auto-merged by tier docs'))?.note ?? '';
        expect(note).toMatch(/factory review approved/);
        expect(note).toMatch(/CI green at [0-9a-f]{12}: local-gate/);
        expect(note).toMatch(/every file fits tier docs/);
        expect(state.history.at(-1)?.note).toMatch(/merged on .* by the factory \(auto-merge tier docs\)/);
        // The engine's merge ran without hooks and only as ship's exact shape.
        expect(w.calls.filter((c) => c.startsWith('git merge '))).toEqual([`git merge --no-ff --no-edit --no-verify ${state.head}`]);
    });
    it('a committed factory.merge on the base is ignored with a notice', async () => {
        w = localWorld();
        writeFileSync(join(w.root, '.copilot', 'omg.jsonc'), JSON.stringify(auto(w.root)));
        gitIn(w.root, 'add', '.copilot/omg.jsonc');
        gitIn(w.root, 'commit', '-q', '-m', 'committed auto-merge');
        const baseSha = gitIn(w.root, 'rev-parse', BASE);
        const gateConfig = () => ({ config: { ...resolveShipConfig(undefined), requiredChecks: ['Test'], advisoryChecks: [], trustedBaseCommit: baseSha }, known: [] });
        const warnings = [];
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [docs(), review('approve')]), { gateConfig, warn: (m) => warnings.push(m) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(warnings.join('\n')).toMatch(/factory\.merge in the committed \.copilot\/omg\.jsonc is ignored/);
    });
    it('a change outside the enabled tiers parks at the human merge and says why', async () => {
        w = localWorld();
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [commitFile('src/greet.js', 'export const greet = () => "hi";\n'), review('approve')]), { autoMergeUserConfig: auto(w.root) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(out.gate?.reason).toMatch(/auto-merge \(factory\.merge\.auto\) not taken: no enabled tier fits \(docs: src\/greet\.js is not docs\)/);
        expect(w.calls.some((c) => c.startsWith('git merge '))).toBe(false);
    });
    it('uncommitted tracked changes in your checkout keep the merge human', async () => {
        w = localWorld();
        const first = await runFactoryEngine(localOpts(w, lanesFor(w, [docs(), review('approve')])));
        expect(first.gate?.name, first.message).toBe('merge');
        // Parked at the human merge, the user edits a tracked file, then turns auto-merge on and reruns.
        writeFileSync(join(w.root, 'README.md'), 'edited\n');
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, []), { autoMergeUserConfig: auto(w.root) }));
        expect(out.gate?.name, out.message).toBe('merge');
        expect(out.gate?.reason).toMatch(/not taken: your repository has uncommitted changes to tracked files/);
        expect(w.calls.some((c) => c.startsWith('git merge '))).toBe(false);
    });
    it('a head that moves between the check and the merge keeps the merge human', async () => {
        w = localWorld();
        const exec = w.exec;
        let moved = false;
        w.exec = (cmd, args, opts) => {
            const res = exec(cmd, args, opts);
            if (!moved && cmd === 'git' && args.includes('--numstat')) {
                // Right after the tier read: the PR branch in the mirror moves to another commit.
                moved = true;
                gitIn(w.config.repo.url, 'update-ref', `refs/heads/factory/issue-${LOCAL_ISSUE}`, gitIn(w.root, 'rev-parse', BASE));
            }
            return res;
        };
        const out = await runFactoryEngine(localOpts(w, lanesFor(w, [docs(), review('approve')]), { autoMergeUserConfig: auto(w.root) }));
        expect(moved).toBe(true);
        expect(w.calls.some((c) => c.startsWith('git merge '))).toBe(false);
        expect(readFactoryState(w.root, LOCAL_ISSUE).phase).not.toBe('merged');
        expect(`${out.gate?.name}: ${out.gate?.reason}`).toMatch(/PR changed between the check and the merge|head-moved/);
    });
});
//# sourceMappingURL=engine.local.auto-merge.test.js.map