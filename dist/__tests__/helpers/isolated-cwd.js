import { afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Run a test file from a throwaway git repository instead of the checkout.
 *
 * Hooks, HUD and state code resolve their state root from process.cwd() (a
 * `directory` outside it is replaced by the trusted cwd root), so a test that
 * triggers them from the checkout writes `.omg/state/sessions/<fake session>`
 * into the real repository. Call this at the top of such a file; the guard in
 * src/__tests__/setup/global-state-guard.ts fails the run when one still leaks.
 *
 * Returns a getter for the repository root (valid after beforeAll).
 */
export function useIsolatedCwd() {
    const original = process.cwd();
    let root = '';
    beforeAll(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'omg-isolated-cwd-')));
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
        process.chdir(root);
    });
    afterAll(() => {
        process.chdir(original);
        rmSync(root, { recursive: true, force: true });
    });
    return () => root;
}
//# sourceMappingURL=isolated-cwd.js.map