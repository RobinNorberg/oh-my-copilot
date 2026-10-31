/**
 * Read-only GitHub, Azure DevOps and git access for `omg factory heal`
 * through an injected Exec. healGuardExec allows only the fixed read shapes
 * below; PR 1 issues no GitHub write (a rerun is recorded as an intent,
 * never run), so `gh run rerun`, `gh api` and every other command are
 * refused before they spawn. `az` goes to the Azure DevOps guard with the
 * `read` policy (ADO parity design §3.5): GET routes of the forge repo only.
 */
import { ShipSafetyError, TRUSTED_READ_ENV } from '../../ship/exec.js';
import { isAdoCommand, runGuardedAdo } from '../../forge/ado/guard.js';
import { RUN_LIST_FIELDS } from '../../forge/github/ci.js';
export { RUN_LIST_FIELDS };
export class HealSafetyError extends ShipSafetyError {
    constructor(message) {
        super(message);
        this.name = 'HealSafetyError';
    }
}
const NUMBER = /^\d{1,20}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const BRANCH = /^[\w.][\w./-]*$/;
const WORKFLOW = /^[\w.-]+\.ya?ml$/;
const REPO_PATH = /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/;
const same = (args, shape) => args.length === shape.length && shape.every((v, i) => args[i] === v);
const isBranch = (s) => typeof s === 'string' && BRANCH.test(s) && !s.includes('..');
function ghAllowed(a) {
    const [group, sub, ...r] = a;
    if (group !== 'run')
        return false;
    if (sub === 'list') {
        // gh run list [--branch <b>] --workflow <file> --event <push|pull_request> --json <fields> --limit <n>
        const rest = r[0] === '--branch' && isBranch(r[1]) ? r.slice(2) : r;
        return rest.length === 8 && rest[0] === '--workflow' && WORKFLOW.test(rest[1])
            && rest[2] === '--event' && (rest[3] === 'push' || rest[3] === 'pull_request')
            && rest[4] === '--json' && rest[5] === RUN_LIST_FIELDS && rest[6] === '--limit' && NUMBER.test(rest[7]);
    }
    if (sub === 'view') {
        return (r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && r[2] === 'jobs')
            || (r.length === 3 && r[0] === '--job' && NUMBER.test(r[1]) && r[2] === '--log');
    }
    return false;
}
function gitAllowed(a) {
    const [sub, ...r] = a;
    switch (sub) {
        case 'rev-parse':
            return same(r, ['--show-toplevel']);
        case 'cat-file':
            return r.length === 2 && r[0] === '-e' && /^[0-9a-f]{40}\^\{commit\}$/.test(r[1]);
        case 'merge-base': {
            // Is the first red sha on the integration branch: git merge-base --is-ancestor <sha> refs/remotes/origin/<base>
            const m = r.length === 3 && r[0] === '--is-ancestor' && /^[0-9a-f]{40}$/.test(r[1]) ? /^refs\/remotes\/origin\/(.+)$/.exec(r[2]) : null;
            return Boolean(m) && isBranch(m[1]);
        }
        case 'rev-list':
            return r.length === 2 && r[0] === '--count' && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(r[1]);
        case 'log':
            // Evidence bundle commit subjects: git log --oneline --no-decorate --no-color -n <n> <green>..<red>
            return r.length === 6 && r[0] === '--oneline' && r[1] === '--no-decorate' && r[2] === '--no-color' && r[3] === '-n'
                && /^\d{1,3}$/.test(r[4]) && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(r[5]);
        case 'diff':
            return r.length === 3 && r[0] === '--name-only' && r[1] === '--no-renames' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]);
        case 'show': {
            const m = r.length === 1 ? /^refs\/remotes\/origin\/([\w.][\w./-]*):(.+)$/.exec(r[0]) : null;
            return Boolean(m) && isBranch(m[1]) && REPO_PATH.test(m[2]) && !m[2].split('/').includes('..');
        }
        default:
            return false;
    }
}
const gitBase = (cmd) => cmd.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
export function assertHealCommand(cmd, args) {
    const base = gitBase(cmd);
    const ok = args.every((x) => typeof x === 'string') && (base === 'gh' ? ghAllowed(args) : base === 'git' ? gitAllowed(args) : false);
    if (!ok)
        throw new HealSafetyError(`omg factory heal refuses \`${base} ${args.join(' ')}\`: not one of its read-only command shapes`);
}
/**
 * The exec every heal command runs through: allowlisted read shapes, git with replace refs off.
 * `ado`: the Azure DevOps guard context (adoReadGuardContext); without one every az call is refused.
 */
export function healGuardExec(exec, ado = () => undefined) {
    return (cmd, args, opts) => {
        if (isAdoCommand(cmd)) {
            const fail = (reason) => new HealSafetyError(`omg factory heal refuses \`${gitBase(cmd)} ${args.join(' ')}\`: ${reason}`);
            return runGuardedAdo(exec, cmd, args, opts, ado(), 'read', fail);
        }
        assertHealCommand(cmd, args);
        return exec(cmd, args, gitBase(cmd) === 'git' ? { ...opts, env: TRUSTED_READ_ENV } : opts);
    };
}
// The run and job reads are the GitHub forge's CI history (src/forge/github/ci.ts).
export { jobLog, listRuns, parseRunJobs, parseRunList, viewRunJobs } from '../../forge/github/ci.js';
export const MAX_RANGE_FILES = 50;
const CODE_PATH = /^(?:src\/|tests\/|scripts\/|package(?:-lock)?\.json$)/;
/** The range lastGreen..firstRed from local git; undefined when either commit is not fetched. */
export function shaRange(exec, root, green, red) {
    if (!HEX40.test(green) || !HEX40.test(red))
        return undefined;
    for (const sha of [green, red]) {
        if (exec('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status !== 0)
            return undefined;
    }
    const count = exec('git', ['rev-list', '--count', `${green}..${red}`], { cwd: root });
    const diff = exec('git', ['diff', '--name-only', '--no-renames', `${green}...${red}`], { cwd: root });
    if (count.status !== 0 || diff.status !== 0)
        return undefined;
    const files = diff.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    return { commits: Number(count.stdout.trim()) || 0, codeFiles: files.filter((f) => CODE_PATH.test(f)).length, files: files.slice(0, MAX_RANGE_FILES) };
}
//# sourceMappingURL=history.js.map