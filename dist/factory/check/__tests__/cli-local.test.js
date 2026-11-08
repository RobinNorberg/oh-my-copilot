import { afterEach, describe, expect, it, vi } from 'vitest';
import { localForgeLimitations } from '../../../forge/local/index.js';
import { STATE_CHANGE_LOG_FLAGS } from '../../../forge/local/mirror.js';
import { factoryCheckCommand } from '../../../cli/commands/factory-check.js';
import { CheckIncompatibleError, EXIT_CHECK_INCOMPATIBLE, isLocalReadShape, runFactoryCheck } from '../cli.js';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveForgeConfig } from '../../../forge/config.js';
import { getGlobalOmcStatePath } from '../../../utils/paths.js';
import { backlogItem, checkDeps, commitAll, LOCAL_PROJECT_CONFIG, localRepo, programs, removeFile, writeFile } from './local-repo.js';
const SHA = 'a'.repeat(40);
afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
});
describe('omg factory check on the local (offline) forge', () => {
    it('works with no origin: committed items are trusted, an uncommitted one is blocked, the limitations print', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        writeFile(repo, '.copilot/backlog/2-draft.md', backlogItem('Draft, not committed'));
        expect(await runFactoryCheck({ ids: [] }, checkDeps(repo))).toBe(0);
        const text = repo.out.join('\n');
        for (const line of localForgeLimitations('main'))
            expect(text).toContain(line);
        expect(text).toMatch(/#1\s+runnable/);
        expect(text).toMatch(/#2\s+blocked\s+-\s+uncommitted/);
        // No tsconfig, eslint, vitest or inventory generator here: prepare runs none of this repository's own tooling.
        expect(text).toContain('prepare checks: none');
        expect(programs(repo)).toEqual(['git']);
    });
    it('prints the prepare checks: detected tsc, or ship.prepare.checks from the trusted user config', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        writeFile(repo, 'tsconfig.json', '{}\n');
        commitAll(repo);
        writeFile(repo, 'node_modules/typescript/bin/tsc', '\n');
        expect(await runFactoryCheck({ ids: ['1'], json: true }, checkDeps(repo))).toBe(0);
        expect(JSON.parse(repo.out.join('\n')).prepareChecks).toEqual(['tsc --noEmit']);
        repo.out.length = 0;
        const deps = { ...checkDeps(repo), trustedUser: () => ({ ship: { trustedBases: ['main'], prepare: { checks: [['cargo', 'check']] } } }) };
        expect(await runFactoryCheck({ ids: ['1'] }, deps)).toBe(0);
        expect(repo.out.join('\n')).toContain('prepare checks: cargo check');
    });
    it('describes the prepare checks from the base commit, like prepare: an uncommitted tsconfig.json adds nothing', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        writeFile(repo, 'tsconfig.json', '{}\n');
        writeFile(repo, 'node_modules/typescript/bin/tsc', '\n');
        expect(await runFactoryCheck({ ids: ['1'], json: true }, checkDeps(repo))).toBe(0);
        expect(JSON.parse(repo.out.join('\n')).prepareChecks).toEqual([]);
    });
    it('F31 + F30: a child whose local PR merged reads as closed (warning names the file); its spec is children-done, never runnable', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/2-cli-flags.md', backlogItem('CLI flags'));
        writeFile(repo, '.copilot/backlog/3-version-flag.md', backlogItem('add a --version flag', 'open', 'Part of #2\n\n'));
        commitAll(repo);
        expect(await runFactoryCheck({ ids: ['2', '3'] }, checkDeps(repo))).toBe(0);
        expect(repo.out.join('\n')).toMatch(/#2\s+blocked\s+-\s+needs-split/);
        // The engine recorded PR #1 of #3 as MERGED in its store (the human merged it on main).
        const config = resolveForgeConfig(undefined, undefined, LOCAL_PROJECT_CONFIG, undefined, { root: repo.root, stateDir: getGlobalOmcStatePath('forge') }).config;
        const store = join(config.repo.url.slice(0, -'.git'.length), 'prs.json');
        mkdirSync(dirname(store), { recursive: true });
        writeFileSync(store, JSON.stringify({ version: 1, next: 2, prs: [{ number: 1, head: 'factory/issue-3', base: 'main', title: 't', state: 'MERGED', isDraft: false, itemId: 3, createdAt: new Date().toISOString() }] }));
        repo.out.length = 0;
        repo.err.length = 0;
        expect(await runFactoryCheck({ ids: ['2', '3'] }, checkDeps(repo))).toBe(0);
        const text = [...repo.out, ...repo.err].join('\n');
        expect(text).toMatch(/#2\s+blocked\s+-\s+children-done/);
        expect(text).toMatch(/#3\s+blocked\s+-\s+closed/);
        expect(text).toContain('the item is merged (local PR #1)');
        expect(text).toContain('#3 is merged (local PR #1) but .copilot/backlog/3-version-flag.md still says state: open; set state: closed there and commit it');
        // The intake source no longer lists the merged item; the spec is listed and blocked.
        repo.out.length = 0;
        expect(await runFactoryCheck({ ids: [], json: true }, checkDeps(repo))).toBe(0);
        const json = JSON.parse(repo.out.join('\n'));
        expect(json.items.map((r) => [r.id, r.bucket, r.reasons[0]])).toEqual([[2, 'blocked', 'children-done']]);
    });
    it('F31: only a PR merged into the current base closes its item, and a change of the file on the base after the merge reopens it', async () => {
        const repo = localRepo();
        const git = (...args) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' }).trim();
        const file3 = '.copilot/backlog/3-version-flag.md';
        writeFile(repo, file3, backlogItem('add a --version flag'));
        writeFile(repo, '.copilot/backlog/4-help-flag.md', backlogItem('add a --help flag'));
        commitAll(repo);
        // The factory branch of #3, and a change of #3's file on main while the PR is open (before the merge).
        git('checkout', '-q', '-b', 'factory/issue-3');
        writeFile(repo, 'version.txt', '1\n');
        commitAll(repo, 'feat: version');
        const head = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
        writeFile(repo, file3, backlogItem('add a --version flag', 'open', 'Edited while the PR was open.\n\n'));
        commitAll(repo, 'backlog: edit #3');
        git('merge', '-q', '--no-ff', '-m', 'merge factory/issue-3', 'factory/issue-3');
        const config = resolveForgeConfig(undefined, undefined, LOCAL_PROJECT_CONFIG, undefined, { root: repo.root, stateDir: getGlobalOmcStatePath('forge') }).config;
        const store = join(config.repo.url.slice(0, -'.git'.length), 'prs.json');
        mkdirSync(dirname(store), { recursive: true });
        const at = new Date().toISOString();
        writeFileSync(store, JSON.stringify({ version: 1, next: 3, prs: [
                { number: 1, head: 'factory/issue-3', base: 'main', title: 't', state: 'MERGED', isDraft: false, itemId: 3, createdAt: at, mergedHead: head },
                // #4's PR merged into another base: it does not close #4 on main.
                { number: 2, head: 'factory/issue-4', base: 'release', title: 't', state: 'MERGED', isDraft: false, itemId: 4, createdAt: at },
            ] }));
        const reasons = async () => {
            repo.out.length = 0;
            expect(await runFactoryCheck({ ids: ['3', '4'], json: true }, checkDeps(repo))).toBe(0);
            return Object.fromEntries(JSON.parse(repo.out.join('\n')).items.map((r) => [r.id, r.reasons[0]]));
        };
        // Merged: closed, though the base edited the file before the merge.
        let now = await reasons();
        expect(now[3]).toBe('closed');
        expect(now[4]).not.toBe('closed');
        expect(repo.out.join('\n')).toContain('to reopen #3 later, commit state: open again after that: only a change of the state: line after the merge reopens it');
        // An edit of the body after the merge does not reopen it (review-450b): only the state: line counts.
        writeFile(repo, file3, backlogItem('add a --version flag', 'open', 'A note after the merge.\n\n'));
        commitAll(repo, 'backlog: note on #3');
        expect((await reasons())[3]).toBe('closed');
        // Nor does a merge commit whose side branch changed only the body (the merge commit itself has no diff for -G).
        git('checkout', '-q', '-b', 'notes');
        writeFile(repo, file3, backlogItem('add a --version flag', 'open', 'A note from a side branch.\n\n'));
        commitAll(repo, 'backlog: side note on #3');
        git('checkout', '-q', 'main');
        writeFile(repo, 'other.txt', 'x\n');
        commitAll(repo, 'other');
        git('merge', '-q', '--no-ff', '-m', 'merge notes', 'notes');
        expect((await reasons())[3]).toBe('closed');
        // Reopened after the merge: the human closes the file, then sets state: open again; the file wins.
        writeFile(repo, file3, backlogItem('add a --version flag', 'closed', 'Done.\n\n'));
        commitAll(repo, 'backlog: close #3');
        expect((await reasons())[3]).toBe('closed');
        writeFile(repo, file3, backlogItem('add a --version flag', 'open', 'Reverted; do it again.\n\n'));
        commitAll(repo, 'backlog: reopen #3');
        now = await reasons();
        expect(now[3]).not.toBe('closed');
        expect([...repo.out, ...repo.err].join('\n')).not.toContain('#3 is merged (local PR #1)');
        expect(programs(repo)).toEqual(['git']);
    });
    it('F20: a missing local base exits 2 naming ship.base (not exit 0 with "no items")', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        const deps = { ...checkDeps(repo), base: () => 'dev' };
        await expect(runFactoryCheck({ ids: [] }, deps)).rejects.toThrow(/the base branch dev does not exist.*set ship\.base in \.copilot\/omg\.jsonc/);
        await factoryCheckCommand(deps).parseAsync([], { from: 'user' });
        expect(process.exitCode).toBe(2);
    });
    it('puts the limitations in --json and checks one id', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        commitAll(repo);
        expect(await runFactoryCheck({ ids: ['1'], json: true }, checkDeps(repo))).toBe(0);
        const json = JSON.parse(repo.out.join('\n'));
        expect(json.forge).toBe('local');
        expect(json.limitations).toEqual(localForgeLimitations('main'));
        expect(json.prepareChecks).toEqual([]);
        expect(json.items.map((i) => [i.id, i.bucket])).toEqual([[1, 'runnable']]);
        expect(programs(repo)).toEqual(['git']);
    });
    it('prints skipped backlog files (tracker warnings)', async () => {
        const repo = localRepo();
        writeFile(repo, '.copilot/backlog/1-add-remove.md', backlogItem('Add remove'));
        writeFile(repo, '.copilot/backlog/3-broken.md', 'no frontmatter at all\n');
        commitAll(repo);
        // A malformed file only in the commit: the committed read skips it with a warning (the working-tree read is lane A's follow-up).
        removeFile(repo, '.copilot/backlog/3-broken.md');
        expect(await runFactoryCheck({ ids: [], json: true }, checkDeps(repo))).toBe(0);
        const json = JSON.parse(repo.out.join('\n'));
        expect(json.warnings.some((w) => /local backlog: skipped .*3-broken\.md/.test(w))).toBe(true);
    });
    it('no origin and no local forge config: unsupported forge with the --forge local hint (exit 5)', async () => {
        const repo = localRepo();
        await expect(runFactoryCheck({ ids: [] }, checkDeps(repo, null))).rejects.toThrow(CheckIncompatibleError);
        await expect(runFactoryCheck({ ids: [] }, checkDeps(repo, null))).rejects.toThrow(/^unsupported forge: .*omg factory setup --forge local/);
        await factoryCheckCommand(checkDeps(repo, null)).parseAsync([], { from: 'user' });
        expect(process.exitCode).toBe(EXIT_CHECK_INCOMPATIBLE);
        expect(repo.err.join('\n')).toMatch(/unsupported forge: .*--forge local/);
        expect(programs(repo)).toEqual(['git']);
    });
});
describe('isLocalReadShape', () => {
    it('passes the backlog listing and the local base branch only', () => {
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog/'])).toBe(true);
        expect(isLocalReadShape(['rev-parse', '--verify', 'refs/heads/main'])).toBe(true);
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', 'HEAD', '--', '.copilot/backlog/'])).toBe(false);
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', '../outside/'])).toBe(false);
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', '-x/'])).toBe(false);
        expect(isLocalReadShape(['ls-tree', '-r', '-z', '--name-only', SHA, '--', 'docs/'])).toBe(false);
        expect(isLocalReadShape(['rev-parse', '--verify', 'refs/heads/-x'])).toBe(false);
        expect(isLocalReadShape(['rev-parse', '--verify', 'refs/tags/main'])).toBe(false);
    });
    it('passes the last state: change of one backlog file at a commit (F31 reopen), nothing looser', () => {
        const log = (commit, path, flags = STATE_CHANGE_LOG_FLAGS) => isLocalReadShape(['log', ...flags, commit, '--', path]);
        expect(log(SHA, '.copilot/backlog/3-x.md')).toBe(true);
        expect(log('HEAD', '.copilot/backlog/3-x.md')).toBe(false);
        expect(log(SHA, '../outside.md')).toBe(false);
        expect(log(SHA, '-x.md')).toBe(false);
        expect(log(SHA, '.copilot/./backlog/3-x.md')).toBe(false);
        // The pre-review any-change shape, a log without the no-driver flags, another pickaxe or format.
        expect(log(SHA, '.copilot/backlog/3-x.md', ['-1', '--no-show-signature', '--format=%H'])).toBe(false);
        expect(log(SHA, '.copilot/backlog/3-x.md', ['-1', '--no-show-signature', '-G^state:', '--format=%H'])).toBe(false);
        expect(log(SHA, '.copilot/backlog/3-x.md', STATE_CHANGE_LOG_FLAGS.map((f) => (f === '-G^state:' ? '-G.' : f)))).toBe(false);
        expect(log(SHA, '.copilot/backlog/3-x.md', STATE_CHANGE_LOG_FLAGS.map((f) => (f === '--format=%H' ? '--format=%G?' : f)))).toBe(false);
    });
    it('refuses a . segment in a backlog path, like the engine guard (both share isPlainRepoPath)', () => {
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/./backlog/'])).toBe(false);
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', './backlog/'])).toBe(false);
        expect(isLocalReadShape(['ls-tree', '-z', '--name-only', SHA, '--', '.copilot/backlog/'])).toBe(true);
    });
});
//# sourceMappingURL=cli-local.test.js.map