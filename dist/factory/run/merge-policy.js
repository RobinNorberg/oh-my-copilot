/**
 * Merge policy for `omg factory run` (owner override of design §8): merge is
 * ALWAYS human. There is no `factory.merge` key and no auto mode, and nothing
 * here runs a merge (the factory guard refuses `gh pr merge` outright). After
 * green gates the engine asks ship's decideMerge for the verdict on the
 * current head, prints the exact admin merge command, comments it on the PR
 * and parks at `awaiting-human: merge`. A later run reads `gh pr view` and
 * finishes as `merged` once the human merged.
 */
import { DEFAULT_SHIP_CONFIG } from '../../ship/config.js';
import { evaluateGates } from '../../ship/gates.js';
import { decideMerge, listChangedFiles, readCommitsSinceReview } from '../../ship/merge.js';
import { latestVerdict } from '../../ship/state.js';
import { runLabel } from './state.js';
/** `gh pr view --json` fields the merge step reads. */
export const MERGE_VIEW_FIELDS = 'number,state,isDraft,baseRefName,baseRefOid,headRefOid';
const HEX40 = /^[0-9a-f]{40}$/;
/** Parse `gh pr view --json MERGE_VIEW_FIELDS`; null when a field is missing or malformed. */
export function parseMergeView(stdout) {
    let v;
    try {
        v = JSON.parse(stdout);
    }
    catch {
        return null;
    }
    if (typeof v !== 'object' || v === null)
        return null;
    const ok = typeof v.number === 'number' && typeof v.state === 'string' && typeof v.isDraft === 'boolean' && typeof v.baseRefName === 'string'
        && typeof v.baseRefOid === 'string' && HEX40.test(v.baseRefOid) && typeof v.headRefOid === 'string' && HEX40.test(v.headRefOid);
    return ok ? v : null;
}
/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 */
export function mergeDecision(exec, root, ship, view, config, known) {
    const gate = evaluateGates(exec, view.number, config, known, root, view.headRefOid);
    const reviewed = latestVerdict(ship)?.sha;
    const commits = readCommitsSinceReview(exec, root, reviewed, view.headRefOid, view.baseRefOid, ship.housekeepingCommits);
    const extraProtected = config.knownFlakyFile !== DEFAULT_SHIP_CONFIG.knownFlakyFile ? [config.knownFlakyFile] : [];
    return decideMerge({
        state: ship, pr: view, gate, ...commits,
        changedFiles: listChangedFiles(exec, root, view.baseRefOid, view.headRefOid),
        extraProtected,
    });
}
/** The PR comment of the merge gate: the decision and the exact command a human runs. */
export function mergeComment(issue, decision, resume = `omg factory run ${issue}`) {
    const cmd = decision.command.join(' ');
    const label = runLabel(issue);
    return decision.ok
        ? [
            `Factory run for ${label}: independent review approved, gates are green, and \`omg ship\`'s merge rule allows this head.`,
            '',
            'Merge is a human step. To merge exactly the head the gates checked:',
            '',
            '```',
            cmd,
            '```',
            '',
            `Then run \`${resume}\` to finish the run as merged.`,
            '',
        ].join('\n')
        : [
            `Factory run for ${label}: \`omg ship\`'s merge rule refuses this head:`,
            '',
            ...decision.reasons.map((r) => `- ${r}`),
            '',
            `Resolve it, then rerun \`${resume}\`. The command the rule would allow is \`${cmd}\`.`,
            '',
        ].join('\n');
}
//# sourceMappingURL=merge-policy.js.map