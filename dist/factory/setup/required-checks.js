/**
 * What the gates will require on GitHub (M1), for `omg factory setup` and
 * `omg factory check`: the configured `ship.requiredChecks`, else the base's
 * branch protection / rulesets, else every check GitHub reports for the PR
 * head; and the checks the base's latest commit reported, so a configured
 * name that matches nothing is a warning before a run waits on it. Reads
 * only (the exact GETs of src/forge/github/checks.ts).
 */
import { ghCommitCheckNames, ghRequiredChecks } from '../../forge/github/checks.js';
import { CHECK_SETTLE_MS, NO_CI_CHECKS_NOTE } from '../../ship/gates.js';
const list = (names) => (names.length > 0 ? names.join(', ') : 'none');
/** `configured`: the trusted ship.requiredChecks ([] = none); `where`: where the user changes it. */
export function gateRequirement(exec, repoArg, base, configured, where, cwd) {
    const notes = [];
    const warnings = [];
    const found = ghCommitCheckNames(exec, repoArg, base, cwd);
    const reported = found === undefined ? `the checks of the latest ${base} commit could not be read` : `the latest ${base} commit reported: ${list(found)}`;
    const unmatched = (names) => (found === undefined ? [] : names.filter((n) => !found.includes(n)));
    if (configured.length > 0) {
        notes.push(`gates: ship.requiredChecks requires ${list(configured)} (and every other reported check must pass); ${reported}`);
        const none = unmatched(configured);
        if (none.length > 0)
            warnings.push(`ship.requiredChecks name(s) ${list(none)} match no check reported on the latest ${base} commit (${list(found ?? [])}); a run would park at awaiting-human: missing-checks. Use the exact check names, in ${where}`);
        return { notes, warnings };
    }
    const protection = ghRequiredChecks(exec, repoArg, base, cwd);
    if (protection && protection.length > 0) {
        notes.push(`gates: no ship.requiredChecks; ${base}'s branch protection requires ${list(protection)}, so the gates wait for those and every other reported check must pass; ${reported}`);
        const none = unmatched(protection);
        if (none.length > 0)
            warnings.push(`${base}'s branch protection requires ${list(none)}, which the latest ${base} commit did not report; a run would park at awaiting-human: missing-checks if the PR does not report them either`);
        return { notes, warnings };
    }
    notes.push(`gates: no ship.requiredChecks${protection === undefined ? ' and the branch protection is not readable with your token' : ' and no required checks in the branch protection'}: the gates require every check GitHub reports for the PR head, once nothing new reported for ${Math.round(CHECK_SETTLE_MS / 1000)} s; ${reported}${found !== undefined && found.length === 0 ? `. With no CI at all the gates go green with the note "${NO_CI_CHECKS_NOTE}" (the merge stays a human step)` : ''}. To require exact names, set ship.requiredChecks in ${where}`);
    return { notes, warnings };
}
//# sourceMappingURL=required-checks.js.map