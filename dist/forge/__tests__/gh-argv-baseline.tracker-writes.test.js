/**
 * gh argv baseline, tracker writes (shipyard-factory design PR 7a): the exact
 * gh calls of the GitHub tracker's findByKey / createItem / updateItem, run
 * through the factory guard with enqueue's TrackerWriteContext, so every
 * recorded line is also a shape the guard passes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factoryGuardExec } from '../../factory/run/exec.js';
import { ghRepoArg } from '../github/gh.js';
import { githubTracker } from '../github/tracker.js';
import { shipyardKeyLine, shipyardKeys } from '../types.js';
import { recordingExec } from './recording-exec.js';
const CWD = join(tmpdir(), 'omg-baseline-repo');
const BODIES = join(tmpdir(), 'omg-baseline-bodies');
/** The guard runs gh with its own copy of the body file (a fresh omg-gh-body-* dir): one stable name for it. */
const guardCopy = (calls) => calls.map((c) => c.replace(/"[^"]*omg-gh-body-[^"]*"/g, '"<guard-copy>"'));
const config = {
    kind: 'github',
    repo: { kind: 'github', host: 'github.com', owner: 'o', name: 'r', url: 'https://github.com/o/r' },
    intake: { source: { type: 'label', label: 'factory' }, itemTypes: [], limit: 50, marker: 'factory-ready' },
    check: { maxAcceptanceItems: 12, maxSize: 8, maxBodyChars: 20000 },
    progress: { enabled: false, stages: {} },
};
const ctx = { repo: ghRepoArg(config.repo), bodyDir: BODIES, labels: ['factory', 'priority:p0', 'priority:p1'] };
const issue = (n, body, repo = 'o/r') => JSON.stringify({ title: `t${n}`, body, labels: [], state: 'OPEN', url: `https://github.com/${repo}/issues/${n}`, author: { login: 'o' }, comments: [] });
/** A scripted gh behind the guarded, recorded exec. */
function tracker(answer) {
    const inner = (_cmd, args) => ({ status: 0, stdout: answer(args), stderr: '' });
    const r = recordingExec(inner, { '<cwd>': CWD, '<bodies>': BODIES }, ['gh']);
    return { t: githubTracker(factoryGuardExec(r.exec, () => [], () => undefined, () => ctx), CWD, config), calls: r.calls };
}
describe('gh argv baseline: tracker writes', () => {
    beforeAll(() => {
        mkdirSync(BODIES, { recursive: true });
        for (const name of ['auth-token-refresh.md', 'token-store-port.md', 'b.md'])
            writeFileSync(join(BODIES, name), 'Body\n');
    });
    afterAll(() => rmSync(BODIES, { recursive: true, force: true }));
    it('createItem: issue create with --repo, --title, --body-file and the labels', () => {
        const { t, calls } = tracker(() => 'Creating issue in o/r\n\nhttps://github.com/o/r/issues/77\n');
        expect(t.createItem({ title: 'Refresh tokens', bodyFile: join(BODIES, 'auth-token-refresh.md'), labels: ['factory', 'priority:p1'] })).toBe(77);
        expect(guardCopy(calls)).toEqual([
            'gh ["issue","create","--repo","github.com/o/r","--title","Refresh tokens","--body-file","<guard-copy>","--label","factory","--label","priority:p1"] cwd=<cwd>',
        ]);
    });
    it('createItem refuses a printed url of another repository', () => {
        const { t } = tracker(() => 'https://github.com/evil/r/issues/77\n');
        expect(() => t.createItem({ title: 'T', bodyFile: join(BODIES, 'b.md'), labels: [] })).toThrow(/no issue url of https:\/\/github.com\/o\/r/);
    });
    it('updateItem: issue edit with --repo, title, body file, adds then removes', () => {
        const { t, calls } = tracker(() => 'https://github.com/o/r/issues/77\n');
        t.updateItem(77, { title: 'Refresh tokens', bodyFile: join(BODIES, 'auth-token-refresh.md'), addLabels: ['priority:p0'], removeLabels: ['priority:p1'] });
        t.updateItem(78, { title: 'Store port', bodyFile: join(BODIES, 'token-store-port.md'), addLabels: [], removeLabels: [] });
        expect(guardCopy(calls)).toEqual([
            'gh ["issue","edit","77","--repo","github.com/o/r","--title","Refresh tokens","--body-file","<guard-copy>","--add-label","priority:p0","--remove-label","priority:p1"] cwd=<cwd>',
            'gh ["issue","edit","78","--repo","github.com/o/r","--title","Store port","--body-file","<guard-copy>"] cwd=<cwd>',
        ]);
    });
    it('a guard refusal reaches the caller: a label off the allowlist never runs', () => {
        const { t, calls } = tracker(() => '');
        expect(() => t.updateItem(77, { title: 'T', bodyFile: join(BODIES, 'b.md'), addLabels: ['bug'], removeLabels: [] })).toThrow(/refuses/);
        expect(calls).toEqual([]);
    });
    it('findByKey: one search, then a view per issue with exactly one key of the spec', () => {
        const bodies = {
            77: `Part of #412\n\n${shipyardKeyLine(412, 'auth-token-refresh')}\n`,
            78: `${shipyardKeyLine(412, 'token-store-port')}\r\n`,
            79: `${shipyardKeyLine(413, 'other-spec')}\n`,
            80: `${shipyardKeyLine(412, 'one')}\n${shipyardKeyLine(412, 'two')}\n`,
            81: `quoted: ${shipyardKeyLine(412, 'not-a-footer')}\n`,
        };
        const { t, calls } = tracker((args) => {
            if (args[1] === 'list')
                return JSON.stringify(Object.entries(bodies).map(([n, body]) => ({ number: Number(n), body })));
            const n = Number(args[2]);
            // 78's body changed between the search and the view: skipped.
            return issue(n, n === 78 ? `${shipyardKeyLine(412, 'renamed-key')}\n` : bodies[n]);
        });
        const found = t.findByKey(412);
        expect(found.map((f) => [f.key, f.item.id, f.item.parent])).toEqual([['auth-token-refresh', 77, 412]]);
        expect(calls).toEqual([
            'gh ["issue","list","--repo","github.com/o/r","--search","\\"shipyard-key: 412/\\" in:body","--state","all","--json","number,body","--limit","1000"] cwd=<cwd>',
            'gh ["issue","view","77","--json","title,body,labels,state,url,author,comments"] cwd=<cwd>',
            'gh ["issue","view","78","--json","title,body,labels,state,url,author,comments"] cwd=<cwd>',
        ]);
    });
    it('findByKey skips an issue of another repository', () => {
        const { t } = tracker((args) => (args[1] === 'list'
            ? JSON.stringify([{ number: 5, body: `${shipyardKeyLine(412, 'abc')}\n` }])
            : issue(5, `${shipyardKeyLine(412, 'abc')}\n`, 'evil/r')));
        expect(t.findByKey(412)).toEqual([]);
    });
    it('shipyardKeys reads whole footer lines only', () => {
        expect(shipyardKeys(`${shipyardKeyLine(1, 'abc')}\nshipyard-key: 1/AB\nshipyard-key: 1/abc x\n${shipyardKeyLine(2, 'de-f')}`)).toEqual([[1, 'abc'], [2, 'de-f']]);
    });
});
//# sourceMappingURL=gh-argv-baseline.tracker-writes.test.js.map