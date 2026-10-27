import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { clearWorktreeCache, probeGitTopLevel, setGitShowToplevelProbeForTests } from '../../lib/worktree-paths.js';
// A real (non-test-mode) git spawn that prints a *localized* "not a git
// repository" message unless the caller forces LC_ALL=C, mirroring what
// git's gettext layer does on a non-English system locale (e.g. Korean:
// "깃 저장소가 아닙니다"). isNotAGitRepositoryError() only recognizes the
// English string, so without forcing LC_ALL=C on the spawn, a plain "this
// directory is not a git repository" answer is misclassified as
// `probe_failed` instead of `not_a_repository` — which fails closed and
// breaks every caller (e.g. the HUD statusline) in a non-git directory.
function installLocaleAwareFakeGit(dir) {
    const bin = join(dir, 'fake-git-bin');
    mkdirSync(bin, { recursive: true });
    const gitPath = join(bin, 'git');
    writeFileSync(gitPath, [
        '#!/bin/sh',
        'if [ "$LC_ALL" = "C" ]; then',
        '  echo "fatal: not a git repository (or any of the parent directories): .git" 1>&2',
        'else',
        '  echo "fatal: (현재 폴더 또는 상위 폴더 중 일부가) 깃 저장소가 아닙니다: .git" 1>&2',
        'fi',
        'exit 128',
        '',
    ].join('\n'));
    chmodSync(gitPath, 0o755);
    return bin;
}
describe('probeGitTopLevel locale independence', () => {
    let tempDir;
    let plainDir;
    let originalPath;
    let originalLcAll;
    beforeEach(() => {
        originalPath = process.env.PATH;
        originalLcAll = process.env.LC_ALL;
        // Simulate a session whose ambient locale is Korean, not English.
        process.env.LC_ALL = 'ko_KR.UTF-8';
        tempDir = mkdtempSync(join(tmpdir(), 'probe-locale-'));
        plainDir = join(tempDir, 'plain-notes');
        mkdirSync(plainDir, { recursive: true });
        setGitShowToplevelProbeForTests(undefined);
        clearWorktreeCache();
    });
    afterEach(() => {
        process.env.PATH = originalPath;
        if (originalLcAll === undefined)
            delete process.env.LC_ALL;
        else
            process.env.LC_ALL = originalLcAll;
        setGitShowToplevelProbeForTests(undefined);
        clearWorktreeCache();
        rmSync(tempDir, { recursive: true, force: true });
    });
    it('classifies a localized "not a git repository" answer as not_a_repository, not probe_failed', () => {
        if (process.platform === 'win32')
            return; // fake git is a POSIX shell script
        const bin = installLocaleAwareFakeGit(tempDir);
        process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
        const result = probeGitTopLevel(plainDir);
        expect(result.status).toBe('not_a_repository');
    });
});
// Git 2.56.0 (jk/setup-gitfile-diag-fix, 54a441bcea) reworded the fatal error
// for a `.git` file whose gitdir is not a repository from "not a git
// repository: <gitdir>" to "gitfile does not point to a valid repository:
// <gitfile>". Both are the same exit-128 answer and must classify the same way,
// whichever git version the host runs.
describe('probeGitTopLevel invalid gitfile wording across git versions', () => {
    afterEach(() => {
        setGitShowToplevelProbeForTests(undefined);
        clearWorktreeCache();
    });
    it.each([
        ['git <= 2.55', 'fatal: not a git repository: /missing-omc-gitdir\n'],
        ['git >= 2.56', 'fatal: gitfile does not point to a valid repository: /work/parent/.git\n'],
    ])('classifies the %s invalid-gitfile answer as not_a_repository', (_version, stderr) => {
        setGitShowToplevelProbeForTests(() => {
            throw Object.assign(new Error('Command failed: git rev-parse --show-toplevel'), { status: 128, stderr });
        });
        expect(probeGitTopLevel(tmpdir()).status).toBe('not_a_repository');
    });
});
//# sourceMappingURL=worktree-paths-git-probe-locale.test.js.map