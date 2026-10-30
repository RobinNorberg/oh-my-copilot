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
import { ADO_PIPELINE_PATHS } from './lane-commit.js';
import { runLabel } from './state.js';
// The merge view is the GitHub forge's `gh pr view --json MERGE_VIEW_FIELDS` read.
export { MERGE_VIEW_FIELDS, parseMergeView } from '../../forge/github/reviews.js';
/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 * With an Azure DevOps `forge` the gate read goes through it, its blocking
 * branch policies are reasons too, a PR touching the Azure Pipelines
 * definitions (ADO_PIPELINE_PATHS) needs the owner as PROTECTED_PATHS do, and
 * the command is its head-pinned PATCH.
 */
export function mergeDecision(exec, root, ship, view, config, known, forge) {
    const gate = evaluateGates(exec, view.number, config, known, root, view.headRefOid, forge);
    const reviewed = latestVerdict(ship)?.sha;
    const commits = readCommitsSinceReview(exec, root, reviewed, view.headRefOid, view.baseRefOid, ship.housekeepingCommits);
    const extraProtected = [
        ...(config.knownFlakyFile !== DEFAULT_SHIP_CONFIG.knownFlakyFile ? [config.knownFlakyFile] : []),
        ...(forge ? ADO_PIPELINE_PATHS : []),
    ];
    const decision = decideMerge({
        state: ship, pr: view, gate, ...commits,
        changedFiles: listChangedFiles(exec, root, view.baseRefOid, view.headRefOid),
        extraProtected,
    });
    if (!forge)
        return decision;
    const reasons = [...decision.reasons, ...forge.merge.blockingPolicies(view.number, view.headRefOid).map((r) => `Azure DevOps branch policy: ${r}`)];
    const human = forge.merge.humanMerge?.(view.number, view.headRefOid);
    return {
        ok: reasons.length === 0,
        reasons,
        command: human?.command ?? forge.merge.humanMergeCommand(view.number, view.headRefOid),
        ...(human ? { body: { file: human.bodyFile, sha256: human.bodySha256 } } : {}),
    };
}
/** The body file's lines under the command (ADO): its path and SHA-256, for the human to check before running it. */
const bodyLines = (decision) => decision.body ? ['', `The command reads its body from \`${decision.body.file}\` (SHA-256 \`${decision.body.sha256}\`); check that file before running it.`] : [];
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
            ...bodyLines(decision),
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
            ...bodyLines(decision),
            '',
        ].join('\n');
}
//# sourceMappingURL=merge-policy.js.map