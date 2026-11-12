import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeChanges } from '../job.js';
import { runHostGit } from '../../team/git-worktree.js';
import { gitIn, scratchRepo } from './fake-sdk.js';
let root;
let repo;
beforeEach(() => {
    ({ root, repo } = scratchRepo('omg-copilot-run-large-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});
const ONE_MIB = 1024 * 1024;
/**
 * Commit a tree of `count` index-only entries with long paths (all the empty
 * blob, skip-worktree, so nothing is written to disk): `ls-tree -r` and
 * `ls-files --stage` then print well over Node's 1 MiB default maxBuffer.
 */
function commitLargeTree(count) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: '', encoding: 'utf8' }).trim();
    const dir = 'deep/'.repeat(40);
    const info = Array.from({ length: count }, (_, i) => `100644 ${blob}\t${dir}file-${String(i).padStart(6, '0')}.txt\n`).join('');
    execFileSync('git', ['update-index', '--index-info'], { cwd: repo, input: info, stdio: ['pipe', 'ignore', 'pipe'] });
    const paths = Array.from({ length: count }, (_, i) => `${dir}file-${String(i).padStart(6, '0')}.txt`).join('\0');
    execFileSync('git', ['update-index', '-z', '--skip-worktree', '--stdin'], { cwd: repo, input: paths, stdio: ['pipe', 'ignore', 'pipe'] });
    gitIn(repo, 'commit', '-q', '-m', 'large tree');
}
describe('host git output above 1 MiB', () => {
    it('summarizeChanges returns a real summary when ls-tree and ls-files exceed 1 MiB', () => {
        commitLargeTree(5000);
        const base = gitIn(repo, 'rev-parse', 'HEAD');
        expect(runHostGit(repo, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).length).toBeGreaterThan(ONE_MIB);
        expect(runHostGit(repo, ['ls-files', '-z', '--stage']).length).toBeGreaterThan(ONE_MIB);
        writeFileSync(join(repo, 'README.md'), 'changed by the lane\n');
        writeFileSync(join(repo, 'new.txt'), 'new\n');
        const summary = summarizeChanges(repo, base);
        expect(summary).not.toBeNull();
        expect(summary?.changedFiles).toEqual(['README.md']);
        expect(summary?.untrackedFiles).toEqual(['new.txt']);
        expect(summary?.newGitlinks).toEqual([]);
        expect(summary?.protectedChanges).toEqual([]);
    }, 60_000);
});
//# sourceMappingURL=job.large-tree.test.js.map