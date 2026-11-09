/**
 * `omg factory pr list|view|diff|review` (factory night 3, goal 2): the local
 * (offline) forge's PRs for a human. list, view and diff only read (round-2
 * F42's safe way to inspect a lane's work: the diff runs as the engine's
 * hardened git, no hooks, no external diff driver, no textconv); review plays
 * a human review back into the engine-owned PR store
 * (`<store>/prs/<n>/reviews.jsonl`), which the next `omg factory run` reads
 * through ForgeReviews.reviewFeedback. GitHub and Azure DevOps have their own
 * review UI: there the command refuses (exit 2).
 *
 * Every text a lane or reviewer could have written (titles, branch names,
 * bodies, authors, the diff with its file paths, error lines) goes through
 * visibleText: control characters dropped, bidi and zero-width characters
 * shown as <U+XXXX>. `pr diff` and `pr view` print the head they show;
 * `pr review` takes that head as `--head <sha>` (the full 40-hex sha, no
 * prefix: nothing to be ambiguous) and refuses when the PR's head moved since.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, statSync } from 'fs';
import { userInfo } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CheckIncompatibleError, CheckUsageError, EXIT_CHECK_FAILED, EXIT_CHECK_INCOMPATIBLE, EXIT_CHECK_USAGE, factoryErrorLine, openReadForge, parseItemId, } from '../../factory/check/cli.js';
import { factoryGuardExec, hardenedGitExec } from '../../factory/run/exec.js';
import { factoryForgeOptions } from '../../factory/run/forge-roots.js';
import { defaultLedgerDir, emptyHooksDir } from '../../factory/run/ledger.js';
import { appendLocalReview, engineOwnedDir, MAX_LOCAL_REVIEW_CHARS, readLocalReviews, readPrStore } from '../../forge/local/store.js';
import { REVIEW_HEAD, visibleLine, visibleText } from '../../forge/review-feedback.js';
export const FACTORY_PR_JSON_SCHEMA_VERSION = 1;
function openLocal(deps, warnings) {
    const { root, base, config, forge } = openReadForge({}, deps, warnings, 'omg factory pr');
    if (config.kind !== 'local') {
        throw new CheckUsageError(`omg factory pr works on the local forge only; this repository's forge is ${config.kind} (review its PRs there)`);
    }
    // The local forge's own store directory: <stateDir>/local/<repo-id> beside the mirror, never under an untrusted root.
    const storeDir = engineOwnedDir(config.repo.url.replace(/\.git$/, ''), [root, ...factoryForgeOptions(root).untrustedRoots]);
    return { root, base, forge, storeDir };
}
const view = (ctx, n) => {
    try {
        return ctx.forge.reviews.viewPr(n);
    }
    catch (error) {
        throw new CheckUsageError(error instanceof Error ? error.message : String(error));
    }
};
function readBody(path) {
    let st;
    try {
        st = statSync(path);
    }
    catch {
        throw new CheckUsageError(`--body-file ${path} does not exist`);
    }
    if (!st.isFile())
        throw new CheckUsageError(`--body-file ${path} is not a file`);
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    if (text.length > MAX_LOCAL_REVIEW_CHARS)
        throw new CheckUsageError(`--body-file ${path} is over ${MAX_LOCAL_REVIEW_CHARS} characters`);
    return text;
}
/** One `omg factory pr` action; returns the exit code. */
export async function runFactoryPr(action, o, deps) {
    const warnings = [];
    const say = (line) => deps.out(line);
    const pr = o.pr === undefined ? undefined : parseItemId(o.pr);
    let review;
    if (action === 'review') {
        const states = [['approved', o.approve], ['changes-requested', o.requestChanges], ['commented', o.comment]].filter(([, on]) => on);
        if (states.length !== 1)
            throw new CheckUsageError('omg factory pr review takes exactly one of --approve, --request-changes, --comment');
        const state = states[0][0];
        if (state !== 'approved' && o.bodyFile === undefined)
            throw new CheckUsageError(`--body-file is required with --${state === 'commented' ? 'comment' : 'request-changes'}`);
        const body = o.bodyFile === undefined ? '' : readBody(o.bodyFile);
        if (state !== 'approved' && body.trim() === '')
            throw new CheckUsageError(`--body-file ${o.bodyFile} is empty`);
        if (o.head === undefined || !REVIEW_HEAD.test(o.head.toLowerCase())) {
            throw new CheckUsageError('--head <sha> is required: the full 40-hex head that omg factory pr diff or view printed (what you reviewed)');
        }
        review = { state, body };
    }
    const ctx = openLocal(deps, warnings);
    for (const w of warnings)
        deps.err(chalk.yellow(visibleLine(w)));
    if (action === 'list') {
        const prs = readPrStore(join(ctx.storeDir, 'prs.json')).prs.map((p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, head: p.head, base: p.base, title: visibleText(p.title), itemId: p.itemId }));
        if (o.json)
            say(JSON.stringify({ schemaVersion: FACTORY_PR_JSON_SCHEMA_VERSION, ok: true, prs }, null, 2));
        else if (prs.length === 0)
            say('no local PRs');
        else
            for (const p of prs)
                say(`#${p.number}  ${p.state}${p.isDraft ? ' (draft)' : ''}  ${visibleLine(p.head)} -> ${visibleLine(p.base)}  ${visibleLine(p.title)}`);
        return 0;
    }
    const n = pr;
    const v = view(ctx, n);
    if (action === 'view') {
        const record = readPrStore(join(ctx.storeDir, 'prs.json')).prs.find((p) => p.number === n);
        const feedback = ctx.forge.reviews.reviewFeedback?.(n, v.headRefOid);
        const reviews = readLocalReviews(ctx.storeDir, n).map((r) => ({ ...r, body: visibleText(r.body) }));
        if (o.json) {
            say(JSON.stringify({ schemaVersion: FACTORY_PR_JSON_SCHEMA_VERSION, ok: true, pr: { ...v, title: visibleText(record.title) }, reviews, openThreads: feedback?.threads.length ?? 0 }, null, 2));
            return 0;
        }
        say(`#${v.number}  ${v.state}${v.isDraft ? ' (draft)' : ''}  ${visibleLine(record.title)}`);
        say(`  head ${v.headRefOid} (${visibleLine(v.headRefName)}) -> base ${v.baseRefOid} (${visibleLine(v.baseRefName)})`);
        for (const r of reviews)
            say(`  review ${r.state} by ${visibleLine(r.author)} at ${r.head.slice(0, 8)} (${r.at})${r.body ? `\n${r.body.replace(/^/gm, '    ')}` : ''}`);
        say(`  ${feedback?.threads.length ?? 0} open review note(s) on the current head; diff: omg factory pr diff ${n}; review: omg factory pr review ${n} --head ${v.headRefOid} ...`);
        return 0;
    }
    if (action === 'diff') {
        const ledgerDir = deps.ledgerDir ?? defaultLedgerDir();
        const git = factoryGuardExec(hardenedGitExec(deps.exec, emptyHooksDir(ledgerDir)), () => [ctx.base]);
        const r = git('git', ['diff', '--no-ext-diff', '--no-textconv', `${v.baseRefOid}...${v.headRefOid}`], { cwd: ctx.root });
        if (r.status !== 0) {
            deps.err(chalk.red(`git diff of local PR #${n} failed (exit ${r.status}): ${visibleLine(r.stderr.trim().split('\n')[0] ?? '')}`));
            return EXIT_CHECK_FAILED;
        }
        say(`local PR #${n} head ${v.headRefOid} base ${v.baseRefOid} (review it with --head ${v.headRefOid})`);
        say(visibleText(r.stdout).replace(/\n$/, ''));
        return 0;
    }
    // review
    if (v.state !== 'OPEN')
        throw new CheckUsageError(`local PR #${n} is ${v.state.toLowerCase()}; only an open PR takes a review`);
    if (o.head.toLowerCase() !== v.headRefOid) {
        throw new CheckUsageError(`local PR #${n} head moved: it is ${v.headRefOid} now, not the --head ${o.head.toLowerCase()} you reviewed; read omg factory pr diff ${n} again`);
    }
    const author = ((deps.user ?? defaultUser)().trim().toLowerCase()) || 'local';
    const record = { version: 1, id: randomUUID(), pr: n, author, state: review.state, body: review.body, head: v.headRefOid, at: new Date().toISOString() };
    appendLocalReview(ctx.storeDir, record);
    if (o.json)
        say(JSON.stringify({ schemaVersion: FACTORY_PR_JSON_SCHEMA_VERSION, ok: true, review: { id: record.id, pr: n, state: record.state, author, head: record.head } }, null, 2));
    else
        say(`recorded ${record.state} by ${visibleLine(author)} on local PR #${n} at ${record.head.slice(0, 8)}; the next omg factory run of its item reads it`);
    return 0;
}
const defaultUser = () => {
    try {
        return userInfo().username;
    }
    catch {
        return 'local';
    }
};
function action(name, deps) {
    return async (...args) => {
        const pr = typeof args[0] === 'string' ? args[0] : undefined;
        const o = (pr === undefined ? args[0] : args[1]);
        const json = o.json === true;
        try {
            process.exitCode = await runFactoryPr(name, { ...o, ...(pr === undefined ? {} : { pr }) }, deps);
        }
        catch (error) {
            const message = visibleLine(error instanceof Error ? error.message : String(error));
            if (json)
                deps.out(JSON.stringify({ schemaVersion: FACTORY_PR_JSON_SCHEMA_VERSION, ok: false, error: message }, null, 2));
            else
                deps.err(chalk.red(factoryErrorLine(message)));
            process.exitCode = error instanceof CheckUsageError ? EXIT_CHECK_USAGE : error instanceof CheckIncompatibleError ? EXIT_CHECK_INCOMPATIBLE : EXIT_CHECK_FAILED;
        }
    };
}
export function factoryPrCommand(deps) {
    const cmd = new Command('pr').description('Local forge PRs: list, view and diff (read-only), and play back a human review');
    cmd.addCommand(new Command('list').description('List the local PRs').option('--json', 'JSON output (schemaVersion 1)').action(action('list', deps)));
    cmd.addCommand(new Command('view').description('Show one local PR, its played-back reviews and open notes').argument('<n>', 'local PR number')
        .option('--json', 'JSON output (schemaVersion 1)').action(action('view', deps)));
    cmd.addCommand(new Command('diff').description('The PR diff (base...head) with the engine\'s hardened git: no hooks, no external diff, no textconv')
        .argument('<n>', 'local PR number').action(action('diff', deps)));
    cmd.addCommand(new Command('review').description('Record a human review on the PR\'s current head; the next omg factory run reads it').argument('<n>', 'local PR number')
        .option('--approve', 'approve')
        .option('--request-changes', 'request changes (needs --body-file)')
        .option('--comment', 'comment without a decision (needs --body-file)')
        .option('--body-file <file>', 'the review text')
        .option('--head <sha>', 'the full head sha you reviewed (pr diff / pr view print it); refused when the PR moved since')
        .option('--json', 'JSON output (schemaVersion 1)')
        .action(action('review', deps)));
    return cmd;
}
//# sourceMappingURL=factory-pr.js.map