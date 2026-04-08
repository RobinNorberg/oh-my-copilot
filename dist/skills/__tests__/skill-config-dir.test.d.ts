/**
 * Regression test: skill markdown files must use COPILOT_CONFIG_DIR
 *
 * Ensures that bash code blocks in skill files never hardcode $HOME/.copilot
 * without a ${COPILOT_CONFIG_DIR:-...} fallback. This prevents skills from
 * ignoring the user's custom config directory.
 */
export {};
//# sourceMappingURL=skill-config-dir.test.d.ts.map