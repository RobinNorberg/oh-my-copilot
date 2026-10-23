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
export declare function useIsolatedCwd(): () => string;
//# sourceMappingURL=isolated-cwd.d.ts.map