/**
 * Copilot CLI fires SessionEnd after every agentStop (live 1.0.91). The
 * session-end worker must not clear live mode state, clean up teams or notify
 * until the session's events.jsonl records the real end (session.shutdown).
 * Events fixtures are the live probe's stop-stub session, slimmed.
 */
export {};
//# sourceMappingURL=copilot-liveness.test.d.ts.map