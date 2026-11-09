import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { backlogListArgs, backlogShowArgs, isLocalBranchName, LOCAL_REMOTE, localCheckRecordPath, localMirrorPath, localPrStorePath, localRepoId, localStoreDir, mergedArgs, mirrorFetchArgs, mirrorInitArgs, mirrorPushArgs, mirrorRemoteAddArgs, mirrorRemoteGetUrlArgs, readMirrorRef, } from '../mirror.js';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const dirs = [];
afterEach(() => {
    for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
});
describe('localRepoId', () => {
    it('is the basename plus a 12-hex hash of the resolved root', () => {
        expect(localRepoId('/work/widgets', 'linux')).toMatch(/^widgets-[0-9a-f]{12}$/);
        expect(localRepoId('/work/widgets', 'linux')).toBe(localRepoId('/work/widgets/', 'linux'));
        expect(localRepoId('/work/widgets', 'linux')).not.toBe(localRepoId('/other/widgets', 'linux'));
    });
    it('folds case on Windows only', () => {
        expect(localRepoId('C:\\Work\\Widgets', 'win32')).toBe(localRepoId('c:/work/widgets', 'win32'));
        expect(localRepoId('/Work/w', 'linux')).not.toBe(localRepoId('/work/w', 'linux'));
    });
    it('keeps the name file-safe', () => {
        expect(localRepoId('/x/my repo!', 'linux')).toMatch(/^my_repo_-[0-9a-f]{12}$/);
        expect(localRepoId('/x/..hidden', 'linux').startsWith('_')).toBe(true);
    });
});
describe('the layout under stateDir', () => {
    it('puts the mirror, store and check records under <stateDir>/local', () => {
        const id = localRepoId('/r');
        expect(localMirrorPath('/s', '/r')).toBe(join('/s', 'local', `${id}.git`));
        expect(localStoreDir('/s', '/r')).toBe(join('/s', 'local', id));
        expect(localPrStorePath('/s', '/r')).toBe(join('/s', 'local', id, 'prs.json'));
        expect(localCheckRecordPath('/s', '/r', A)).toBe(join('/s', 'local', id, 'checks', `${A}.json`));
        expect(() => localCheckRecordPath('/s', '/r', '../x')).toThrow(/40-hex/);
    });
});
describe('argv builders', () => {
    it('build the exact shapes, on the omg-local remote, never origin', () => {
        expect(LOCAL_REMOTE).toBe('omg-local');
        expect(mirrorInitArgs('/m.git')).toEqual(['init', '--bare', '--quiet', '/m.git']);
        expect(mirrorRemoteAddArgs('/m.git')).toEqual(['remote', 'add', 'omg-local', '/m.git']);
        expect(mirrorRemoteGetUrlArgs()).toEqual(['remote', 'get-url', 'omg-local']);
        expect(mirrorPushArgs(A, 'factory/1-x')).toEqual(['push', 'omg-local', `${A}:refs/heads/factory/1-x`]);
        expect(mirrorFetchArgs('main')).toEqual(['fetch', 'omg-local', 'main']);
        expect(backlogListArgs(A, '.copilot/backlog')).toEqual(['ls-tree', '-z', '--name-only', A, '--', '.copilot/backlog/']);
        expect(backlogShowArgs(A, '.copilot/backlog/1-x.md')).toEqual(['show', `${A}:.copilot/backlog/1-x.md`]);
        expect(mergedArgs(A, B)).toEqual(['merge-base', '--is-ancestor', A, B]);
    });
    it('refuses a ref that is not a 40-hex sha, and a branch that is not plain', () => {
        expect(() => mirrorPushArgs('HEAD', 'main')).toThrow(/40-hex/);
        expect(() => mergedArgs(A, 'main')).toThrow(/40-hex/);
        for (const bad of ['-x', 'a..b', 'a//b', 'a.lock', 'a/.b', 'a@{1}', 'a b', 'a/', '']) {
            expect(isLocalBranchName(bad), bad).toBe(false);
            expect(() => mirrorFetchArgs(bad), bad).toThrow(/branch/);
        }
        expect(isLocalBranchName('factory/12-add-remove')).toBe(true);
    });
});
describe('readMirrorRef', () => {
    it('reads a loose ref, then packed-refs, and undefined when absent', () => {
        const m = mkdtempSync(join(tmpdir(), 'omg-mirror-'));
        dirs.push(m);
        expect(readMirrorRef(m, 'main')).toBeUndefined();
        writeFileSync(join(m, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${B} refs/heads/main\n${A} refs/heads/mainx\n`);
        expect(readMirrorRef(m, 'main')).toBe(B);
        mkdirSync(join(m, 'refs', 'heads', 'factory'), { recursive: true });
        writeFileSync(join(m, 'refs', 'heads', 'factory', 'x'), `${A}\n`);
        expect(readMirrorRef(m, 'factory/x')).toBe(A);
        writeFileSync(join(m, 'refs', 'heads', 'bad'), 'ref: refs/heads/main\n');
        expect(() => readMirrorRef(m, 'bad')).toThrow(/does not hold a commit sha/);
    });
});
//# sourceMappingURL=mirror.test.js.map