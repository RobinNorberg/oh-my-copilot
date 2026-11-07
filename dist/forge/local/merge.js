/**
 * The local forge's merge (offline forge plan §1.1): the human merges the
 * exact head into the base with git; the next `run`/`poll` fast-forwards the
 * mirror's base, and the PR then reads MERGED. The engine still never merges.
 */
export function localMerge(root) {
    return {
        humanMergeCommand(pr, headSha) {
            if (!/^[0-9a-f]{40}$/.test(headSha))
                throw new Error(`merge command for local PR #${pr} needs a 40-hex head sha, got ${JSON.stringify(headSha)}`);
            return ['git', '-C', root, 'merge', '--no-ff', headSha];
        },
        // No server-side policies: the gates (local-gate) are the whole decision.
        blockingPolicies: () => [],
    };
}
//# sourceMappingURL=merge.js.map