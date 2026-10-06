import { existsSync } from 'fs';
import { join } from 'path';
import { prepareCoreManifest } from './cleanup-manifest.js';
import { getOmcRoot, resolveToWorktreeRoot, validateSessionId } from '../../lib/worktree-paths.js';
// Mirrors spawn-next.ts CHAIN_LINK_ENV; importing it would load that graph eagerly.
const CHAIN_LINK_ENV = 'OMC_CHAIN_LINK';
/**
 * Fork: planChainEnqueue returns null without a link claim and without
 * `<omc>/state/factory/chain-<session>.json` (resolveChainLink + readChainLedger).
 * Checking that first skips importing chain-enqueuer's module graph (~45 ms of
 * the SessionEnd foreground budget) on the common no-chain session end.
 */
function mayHaveChain(directory, sessionId) {
    if (process.env[CHAIN_LINK_ENV]?.trim())
        return true;
    return existsSync(join(getOmcRoot(directory), 'state', 'factory', `chain-${sessionId}.json`));
}
/**
 * Publish the durable core cleanup intent (without sealing it) and hand off
 * to the existing worker. Core stays `prepared`, not `sealed`: sealing is
 * the worker's job via `recoverPreparedCoreProducer`, performed only after
 * `foreground-cleanup` durably completes. Sealing here would leave
 * `producers.core.state !== 'prepared'` permanently, which blocks the
 * worker's producer-grace bypass for `foreground-cleanup` and stalls the job.
 */
export async function publishSessionEndBootstrap(input) {
    validateSessionId(input.session_id);
    const directory = resolveToWorktreeRoot(input.cwd);
    // Plugin installs route SessionEnd here (hooks/hooks.json → scripts/session-end.mjs),
    // so the chain enqueue must happen on this path — the standalone settings.json
    // forwarder (processSessionEnd) is not registered when plugin hooks are enabled.
    const enqueuer = mayHaveChain(directory, input.session_id) ? await import('./chain-enqueuer.js') : null;
    const chain = enqueuer ? enqueuer.planChainEnqueue(directory, input.session_id, input.reason) : null;
    const payload = chain
        ? { transcriptPath: input.transcript_path, cwd: input.cwd, reason: input.reason, input, initialTeamNames: [], chain }
        : { transcriptPath: input.transcript_path, cwd: input.cwd, reason: input.reason, input, initialTeamNames: [] };
    const prepared = prepareCoreManifest(directory, input.session_id, payload);
    if (!prepared) {
        // The enqueuer already recorded 'enqueued'; without a manifest (another
        // writer holds the lease) nothing will ever execute that chain. Record the
        // stall so the audit trail names it instead of showing a phantom enqueue.
        // Keyed by the chain-link id (chain.sessionId), which differs from the host
        // session id on Copilot; the closed ledger is corrected to match.
        if (chain && enqueuer)
            enqueuer.recordChainHandoffFailure(directory, chain, 'manifest-unavailable');
        return { continue: true };
    }
    const { spawnSessionEndWorker } = await import('./worker.js');
    // A failed worker spawn is equally silent: the chain payload is durable but
    // no executor will pick it up. Name it in the same trail.
    if (!spawnSessionEndWorker({ directory, sessionId: input.session_id }) && chain && enqueuer) {
        enqueuer.recordChainHandoffFailure(directory, chain, 'worker-spawn-failed');
    }
    return { continue: true };
}
export default publishSessionEndBootstrap;
//# sourceMappingURL=foreground-bootstrap.js.map