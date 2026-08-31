/**
 * Integration test: tmux env var forwarding
 *
 * Verifies that env vars set on the omc process actually arrive inside
 * a tmux session created the same way runClaudeOutsideTmux does.
 * No Claude CLI or API tokens are involved — the test runs `printenv`
 * inside the tmux pane and reads the output from a temp file.
 *
 * Skipped when tmux is not available (CI without tmux, Windows, etc.).
 */
export {};
//# sourceMappingURL=tmux-env-forward.integration.test.d.ts.map