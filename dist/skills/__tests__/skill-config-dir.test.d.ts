/**
 * Regression test: skill markdown files must use COPILOT_HOME
 *
 * Ensures that bash code blocks in skill files never hardcode $HOME/.claude
 * without a ${COPILOT_HOME:-...} fallback. This prevents skills from
 * ignoring the user's custom config directory.
 */
export {};
//# sourceMappingURL=skill-config-dir.test.d.ts.map