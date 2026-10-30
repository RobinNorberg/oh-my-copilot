/**
 * Outcome write-back (shipyard ↔ factory design §3.6, §9 PR 6): at a phase
 * outcome the engine posts one outcome comment on the item and one rollup
 * line on its parent spec. Each post carries a hidden marker naming
 * (child, phase, head), so the engine finds its own earlier post even when
 * the run state lost the record of it. The spec body is never edited: the
 * rollup is comments only, through the tracker's existing comment path.
 */
import { runCredits } from './budget.js';
const GATE_NOTE = /^awaiting-human: ([^:]+): ([\s\S]*)$/;
export const outcomeMarker = (kind, child, event, head12) => `<!-- omg-factory-${kind}: #${child} ${event} ${head12} -->`;
/** A trusted comment on the target ends with `marker` as a whole line (an untrusted or quoted copy never suppresses a post). */
export function postedBefore(comments, marker) {
    return comments.some((c) => c.trusted && c.body.trimEnd().split('\n').pop()?.trim() === marker);
}
export function prUrl(forge, repoUrl, pr) {
    return forge === 'azure-devops' ? `${repoUrl}/pullrequest/${pr}` : `${repoUrl}/pull/${pr}`;
}
/** One line, no backticks, at most 200 characters: safe inside a code span. */
const oneLine = (text) => {
    const flat = text.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
};
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
/**
 * The posts for `event` on child `s.issue`: the outcome comment on the item
 * (terminal events only) and the rollup line on `parent` (when there is one).
 */
export function outcomePosts(s, event, parent, forge) {
    const child = s.issue;
    const head12 = (s.head ?? 'none').slice(0, 12);
    const pr = s.pr ? `PR #${s.pr} (${prUrl(forge, s.repoUrl, s.pr)})` : 'no PR';
    const reached = [...s.history].reverse().find((h) => h.to === event && h.from !== event);
    const lastGate = [...s.history].reverse().map((h) => GATE_NOTE.exec(h.note)).find(Boolean);
    const reason = event === 'merged' ? '' : (lastGate ? `${lastGate[1]}: ${lastGate[2]}` : reached?.note ?? event);
    const posts = [];
    if (event !== 'ready-to-merge') {
        const marker = outcomeMarker('outcome', child, event, head12);
        const gates = [...new Set(s.history.map((h) => GATE_NOTE.exec(h.note)?.[1]).filter((g) => Boolean(g)))];
        const lines = event === 'merged'
            ? [
                `Factory run for #${child} is **merged**: ${pr}.`,
                '',
                `- Review rounds: ${s.lanes.filter((l) => l.kind === 'review' && l.status === 'completed').length}`,
                `- Gates: ${s.history.some((h) => h.to === 'merge') ? `green at ${head12}` : 'not reached (merged by a human before the gates passed)'}`,
                `- AI credits: ${runCredits(s).toFixed(2)}`,
                `- Human gates: ${gates.length > 0 ? gates.join(', ') : 'none'}`,
            ]
            : [
                `Factory run for #${child} is **${event}** (${pr}).`,
                '',
                `${fence(reason)}text`,
                reason,
                fence(reason),
                '',
                `Details: \`omg factory run status ${child}\`.`,
            ];
        posts.push({ target: child, tag: `outcome:#${child}:${event}@${head12}`, marker, body: [...lines, '', marker, ''].join('\n') });
    }
    if (parent !== undefined && parent !== child) {
        const marker = outcomeMarker('rollup', child, event, head12);
        const url = s.pr ? prUrl(forge, s.repoUrl, s.pr) : 'no PR';
        const line = event === 'ready-to-merge' ? `- #${child} ready to merge: ${url}`
            : event === 'merged' ? `- #${child} merged (${url})`
                : `- #${child} ${event}: \`${oneLine(reason)}\``;
        posts.push({ target: parent, tag: `rollup:#${parent}:#${child}:${event}@${head12}`, marker, body: `${line}\n\n${marker}\n` });
    }
    return posts;
}
//# sourceMappingURL=outcome.js.map