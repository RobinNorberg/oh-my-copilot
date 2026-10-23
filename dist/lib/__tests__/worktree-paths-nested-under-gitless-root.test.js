import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWorktreeCache, resolveStateWorkingDirectory, resolveWorkingDirectoryOrLinkedWorktree, validateWorkingDirectoryOrLinkedWorktree, withWorktreePathRenderScope, getOmcRoot, } from '../worktree-paths.js';
import { stateListActiveTool, stateWriteTool } from '../../tools/state-tools.js';
function initRepo(dir) {
    mkdirSync(dir, { recursive: true });
    execSync('git init -q', { cwd: dir, stdio: 'pipe' });
}
/** Session started in a git-less workspace folder; the project is a repository nested under it (C:/Code with C:/Code/OMC). */
describe('state working directory: repository nested under a git-less session root', () => {
    let temp;
    let workspace;
    let nested;
    let outside;
    let originalCwd;
    let originalStateDir;
    beforeEach(() => {
        originalCwd = process.cwd();
        originalStateDir = process.env.OMC_STATE_DIR;
        delete process.env.OMC_STATE_DIR;
        temp = realpathSync(mkdtempSync(join(tmpdir(), 'nested-gitless-')));
        workspace = join(temp, 'workspace');
        nested = join(workspace, 'project');
        outside = join(temp, 'elsewhere');
        mkdirSync(workspace, { recursive: true });
        initRepo(nested);
        initRepo(outside);
        process.chdir(workspace);
        clearWorktreeCache();
    });
    afterEach(() => {
        process.chdir(originalCwd);
        if (originalStateDir === undefined)
            delete process.env.OMC_STATE_DIR;
        else
            process.env.OMC_STATE_DIR = originalStateDir;
        clearWorktreeCache();
        rmSync(temp, { recursive: true, force: true });
    });
    it('accepts a repository below the git-less session root, and only below it', () => {
        expect(resolveWorkingDirectoryOrLinkedWorktree(nested)).toEqual({ status: 'ok', root: nested });
        expect(validateWorkingDirectoryOrLinkedWorktree(join(nested))).toBe(nested);
        expect(resolveWorkingDirectoryOrLinkedWorktree(outside).status).toBe('foreign_repository');
        expect(() => resolveWorkingDirectoryOrLinkedWorktree(temp)).toThrow(/outside the trusted worktree root/);
    });
    it('resolveStateWorkingDirectory returns the nested repository, not the session root', () => {
        expect(resolveStateWorkingDirectory(nested)).toBe(nested);
        const sub = join(nested, 'src');
        mkdirSync(sub);
        expect(resolveStateWorkingDirectory(sub)).toBe(nested);
        expect(() => resolveStateWorkingDirectory(outside)).toThrow(/belongs to a different repository/);
    });
    it('state_write lands under the nested repository state dir and state_list_active sees it', async () => {
        const result = await stateWriteTool.handler({ mode: 'ralph', active: true, session_id: 'nested-sess', workingDirectory: nested });
        expect(result.isError).toBeFalsy();
        expect(existsSync(join(nested, '.omg', 'state', 'sessions', 'nested-sess', 'ralph-state.json'))).toBe(true);
        expect(existsSync(join(workspace, '.omg'))).toBe(false);
        const listed = await stateListActiveTool.handler({ all: true, workingDirectory: nested });
        expect(listed.content[0].text).toContain('ralph');
        const foreign = await stateWriteTool.handler({ mode: 'ralph', active: true, workingDirectory: outside });
        expect(foreign.isError).toBe(true);
        expect(existsSync(join(outside, '.omg'))).toBe(false);
    });
    it('a render scope memoizes the state root for one call only', () => {
        const first = withWorktreePathRenderScope(() => [getOmcRoot(nested), getOmcRoot(nested)]);
        expect(first[0]).toBe(first[1]);
        expect(first[0]).toBe(join(nested, '.omg'));
        // The memo dies with the scope: the next call observes the environment as it is then.
        process.env.OMC_STATE_DIR = join(temp, 'central');
        expect(withWorktreePathRenderScope(() => getOmcRoot(nested))).toContain('central');
        expect(first[0]).not.toContain('central');
    });
});
//# sourceMappingURL=worktree-paths-nested-under-gitless-root.test.js.map