/**
 * What the engine does after a detected tamper of the shared git dir (audit
 * M3): quarantine what changed, put the snapshot's bytes back where that is
 * safe, and hold every new run in this checkout until a human clears it.
 *
 * Before, a lane-tampered park left the planted hook, config key or ref in
 * `.git`: the user's next commit or checkout ran it, and the next run took
 * the tampered state as its baseline.
 *
 * Now, on lane-tampered, review-tampered and prepare-tampered (and a late
 * change found by the recheck), compared with the snapshot taken by THIS run
 * before the lane or prepare (RepoSnapshot.restore keeps the bytes):
 * - hooks/ and info/ (not info/refs): every file added or changed is copied
 *   into `<ledgerDir>/quarantine/<repo>/<stamp>/`, then the snapshot's bytes
 *   are written back (an added file is removed); a deleted file is restored.
 * - config and config.worktree: copied into the quarantine always; put back
 *   from the snapshot only when an added or changed key is one that can run
 *   a program or redirect git (PROGRAM_KEYS: core.hooksPath, core.fsmonitor,
 *   alias.*, filter.*, include.*, url.*.insteadOf, ...). A user's own
 *   `git push -u`, `git remote add` or `git config user.email` during the run
 *   changes only other keys, so it is left in place (no clobbering).
 * - refs: a created refs/replace/* is deleted (its value saved); every other
 *   ref change is only listed with the update-ref command that undoes it,
 *   because the user's own commit or branch switch during a run moves refs
 *   too, and moving those back would hide their work.
 * Everything is copied before anything is changed; when a copy fails nothing
 * is changed and the result says so. Nothing is deleted that is not first
 * in the quarantine. A file the snapshot holds only as a hash (over 1 MiB)
 * is quarantined but cannot be restored; the result names it.
 *
 * The hold is set only when something that runs code or rewrites what git
 * reads changed (a hook, an info/ file, a program-running config key, a
 * replace ref) or the quarantine failed; ref moves and other config keys
 * alone are what a user's own git does during a run, so they are copied and
 * listed and only the run that saw them parks.
 * The hold (`<ledgerDir>/holds/<repo>.json`) makes `omg factory run`, the
 * poller's auto-start and the engine refuse (exit 6) with the quarantine
 * path, until `omg factory run release --tamper` (a human) prints what was
 * quarantined and removes it. An unreadable hold counts as held.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.js';
import { runHostGit } from '../../team/git-worktree.js';
import { sha256 } from './ledger.js';
import { restorableFiles } from './review-guard.js';
/** The checkout's key under quarantine/ and holds/ (the ledger's own per-root key). */
export const repoKey = (root) => sha256(resolve(root).toLowerCase()).slice(0, 16);
export const tamperHoldPath = (ledgerDir, root) => join(ledgerDir, 'holds', `${repoKey(root)}.json`);
export const RELEASE_TAMPER_COMMAND = 'omg factory run release --tamper';
/** Keys whose value runs a program or redirects git: a change to one is put back from the snapshot. */
const PROGRAM_KEYS = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand|worktree|attributesfile|excludesfile|bare)|alias\..*|filter\..*|diff\..*\.(?:textconv|command)|merge\..*\.driver|include\..*|includeif\..*|credential\..*|gpg\..*|commit\.gpgsign|tag\.gpgsign|sequence\.editor|pager\..*|uploadpack\..*|receive\..*|remote\..*\.(?:uploadpack|receivepack|proxy|vcs)|url\..*|http\..*|protocol\..*|hook\..*|sendemail\..*|(?:diff|merge)tool\..*|lfs\..*|submodule\..*|extensions\..*|safe\..*|transfer\..*|fetch\.fsck.*|fsck\..*|init\.templatedir)$/i;
/** `key=value` entries of a config file, as git parses it (--file follows no include). */
function configEntries(bytes, tmp) {
    if (bytes === null)
        return new Set();
    const file = join(tmp, `cfg-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, bytes);
    try {
        const out = runHostGit(tmp, ['config', '--file', file, '--null', '--list'], 30_000);
        return new Set(out.split('\0').filter(Boolean));
    }
    catch {
        return null;
    }
    finally {
        try {
            unlinkSync(file);
        }
        catch { /* temp */ }
    }
}
/** Whether `after` adds or changes a key that runs a program (or the file cannot be parsed: counted as such). */
function programKeyChanged(before, after, tmp) {
    const was = configEntries(before, tmp);
    const now = configEntries(after, tmp);
    if (!was || !now)
        return true;
    for (const entry of now) {
        if (was.has(entry))
            continue;
        const key = entry.split('\n')[0];
        if (PROGRAM_KEYS.test(key))
            return true;
    }
    return false;
}
/** The notRestored note of a config change that touched no program-running key (the only change that sets no hold). */
const BENIGN_CONFIG = 'no program-running key changed';
const decode = (v) => (v?.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64') : v?.startsWith('b64x:') ? Buffer.from(v.slice(5), 'base64') : null);
/**
 * Quarantine and restore after a tamper (see the module comment), then
 * write the hold. Never throws: a failure is in `failed`, and the hold is
 * still written when it can be.
 */
export function quarantineTamper(i) {
    const hold = { root: resolve(i.root), at: i.at, run: i.run, gate: i.gate, moved: [], restored: [], notRestored: [], refs: [] };
    const common = i.before.commonDir;
    const kept = i.before.restore;
    try {
        if (!kept) {
            hold.failed = 'the snapshot from before the lane was recorded by an older release and holds no bytes, so nothing was quarantined or restored';
        }
        else {
            const now = restorableFiles(common);
            const changed = [...new Set([...Object.keys(kept), ...Object.keys(now)])].filter((rel) => kept[rel] !== now[rel]).sort();
            const dir = join(i.ledgerDir, 'quarantine', repoKey(i.root), i.at.replace(/[:.]/g, '-'));
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            hold.quarantine = dir;
            // 1. Copy every changed item that exists now; nothing in the repository changes until all copies succeeded.
            for (const rel of changed) {
                if (now[rel] === undefined)
                    continue;
                const abs = join(common, ...rel.split('/'));
                const to = join(dir, ...rel.split('/'));
                mkdirSync(dirname(to), { recursive: true });
                if (lstatSync(abs).isSymbolicLink())
                    writeFileSync(`${to}.link`, readlinkSync(abs));
                else
                    copyFileSync(abs, to);
            }
            // 2. Decide and restore.
            const tmp = join(dir, '.tmp');
            mkdirSync(tmp, { recursive: true });
            for (const rel of changed) {
                const abs = join(common, ...rel.split('/'));
                const isConfig = rel === 'config' || rel === 'config.worktree';
                const old = decode(kept[rel]);
                if (isConfig) {
                    const current = existsSync(abs) ? readFileSync(abs) : null;
                    if (kept[rel] !== undefined && old === null) {
                        hold.notRestored.push(rel);
                        continue;
                    }
                    if (!programKeyChanged(old, current, tmp)) {
                        hold.notRestored.push(`${rel} (${BENIGN_CONFIG}; left as it is, a copy is in the quarantine)`);
                        continue;
                    }
                }
                if (kept[rel] === undefined) {
                    // Added since the snapshot: it is in the quarantine; remove it here.
                    rmSync(abs, { force: true });
                    hold.moved.push(rel);
                }
                else if (old !== null) {
                    if (now[rel] !== undefined)
                        hold.moved.push(rel);
                    mkdirSync(dirname(abs), { recursive: true });
                    if (existsSync(abs) && lstatSync(abs).isSymbolicLink())
                        unlinkSync(abs);
                    writeFileSync(abs, old);
                    if (kept[rel].startsWith('b64x:'))
                        chmodSync(abs, 0o755);
                    hold.restored.push(rel);
                }
                else {
                    hold.notRestored.push(`${rel} (${kept[rel].startsWith('link:') ? 'a link' : 'over 1 MiB'} in the snapshot: only its hash was kept)`);
                }
            }
            rmSync(tmp, { recursive: true, force: true });
        }
    }
    catch (error) {
        hold.failed = `the quarantine stopped: ${error instanceof Error ? error.message : String(error)}; what it did is listed, everything else is as it was`;
    }
    try {
        hold.refs = refChanges(i.before.refs, i.refsNow ?? i.before.refs, common, hold.quarantine, i.onlyRefs);
    }
    catch (error) {
        hold.failed = `${hold.failed ? `${hold.failed}; ` : ''}the ref changes could not be handled: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Nothing in .git differs from the snapshot (the change was elsewhere: the main checkout's files, the global config):
    // nothing is quarantined and no hold is needed, the park alone stops this run.
    if (!hold.failed && hold.moved.length + hold.restored.length + hold.notRestored.length + hold.refs.length === 0) {
        if (hold.quarantine)
            rmSync(hold.quarantine, { recursive: true, force: true });
        delete hold.quarantine;
        return hold;
    }
    // The hold is for what can run code or rewrite what git reads (a hook, an info/ file, a program-running config key,
    // a replace ref) or a quarantine that could not finish. Ref moves and other config keys are what the user's own git
    // does during a run (a branch, a commit, `push -u`): they are listed and copied, the park stops this run, no hold.
    // A hook, info/ file or config that could not be put back (over 1 MiB, a link) holds too.
    const replaced = hold.refs.some((r) => r.startsWith('refs/replace/'));
    const unrestored = hold.notRestored.some((r) => !r.includes(BENIGN_CONFIG));
    if (!hold.failed && hold.moved.length + hold.restored.length === 0 && !replaced && !unrestored)
        return hold;
    hold.held = true;
    try {
        writeTamperHold(i.ledgerDir, i.root, hold);
    }
    catch (error) {
        hold.failed = `${hold.failed ? `${hold.failed}; ` : ''}the hold could not be written: ${error instanceof Error ? error.message : String(error)}`;
    }
    return hold;
}
/** Ref changes since the snapshot: a created replace ref is deleted (value saved); others are listed with their undo command. */
function refChanges(before, now, common, quarantine, only) {
    const out = [];
    const saved = [];
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((n) => !only || only.includes(n)).sort()) {
        const was = before[name];
        const is = now[name];
        if (was === is)
            continue;
        if (was === undefined && name.startsWith('refs/replace/') && quarantine) {
            saved.push(`${name} ${is}`);
            runHostGit(common, ['--git-dir', common, 'update-ref', '-d', name, is], 30_000);
            out.push(`${name} was created at ${is.slice(0, 12)}: deleted (saved in refs.txt)`);
        }
        else if (was === undefined)
            out.push(`${name} was created at ${is.slice(0, 12)}; if you did not make it: git update-ref -d ${name} ${is}`);
        else if (is === undefined)
            out.push(`${name} was deleted (was ${was.slice(0, 12)}); to put it back: git update-ref ${name} ${was}`);
        else
            out.push(`${name} moved ${was.slice(0, 12)} -> ${is.slice(0, 12)}; if you did not move it: git update-ref ${name} ${was} ${is}`);
    }
    if (quarantine && out.length > 0)
        writeFileSync(join(quarantine, 'refs.txt'), `${[...saved, ...out].join('\n')}\n`);
    return out;
}
export function writeTamperHold(ledgerDir, root, hold) {
    const path = tamperHoldPath(ledgerDir, root);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify(hold, null, 2)}\n`);
}
/** The hold on this checkout: null when there is none; `unreadable` when the file exists but does not parse (held). */
export function readTamperHold(ledgerDir, root) {
    const path = tamperHoldPath(ledgerDir, root);
    if (!existsSync(path))
        return null;
    try {
        const h = JSON.parse(readFileSync(path, 'utf8'));
        return typeof h === 'object' && h !== null && typeof h.gate === 'string' ? h : 'unreadable';
    }
    catch {
        return 'unreadable';
    }
}
/** The refusal text while a hold exists, or null. */
export function tamperHoldMessage(ledgerDir, root) {
    const hold = readTamperHold(ledgerDir, root);
    if (hold === null)
        return null;
    const path = tamperHoldPath(ledgerDir, root);
    if (hold === 'unreadable')
        return `a tamper hold is set on this checkout (${path}, unreadable), so no factory run starts here; check the repository's .git (hooks, config, info, refs), then run ${RELEASE_TAMPER_COMMAND}`;
    return `a tamper hold is set on this checkout since ${hold.at} (run ${hold.run} parked at ${hold.gate}), so no factory run starts here${hold.quarantine ? `; what changed in .git is in ${hold.quarantine}` : ''}. Your own change to .git during that run (a program-running git config key, a hook husky or an editor installed) triggers this too: put it back from that folder if it was yours. Then run ${RELEASE_TAMPER_COMMAND}`;
}
/** `release --tamper`: the hold's report lines, after the hold file is removed; null when there was none. */
export function releaseTamperHold(ledgerDir, root) {
    const hold = readTamperHold(ledgerDir, root);
    if (hold === null)
        return null;
    const path = tamperHoldPath(ledgerDir, root);
    const lines = [];
    if (hold === 'unreadable')
        lines.push(`the hold file ${path} was unreadable`);
    else {
        lines.push(`tamper hold from ${hold.at}: run ${hold.run} parked at ${hold.gate}`);
        if (hold.quarantine)
            lines.push(`quarantine: ${hold.quarantine}`);
        for (const m of hold.moved)
            lines.push(`moved to the quarantine: .git/${m}`);
        for (const r of hold.restored)
            lines.push(`restored from the run's snapshot: .git/${r}`);
        for (const r of hold.notRestored)
            lines.push(`not restored: .git/${r}`);
        for (const r of hold.refs)
            lines.push(`ref: ${r}`);
        if (hold.failed)
            lines.push(`problem: ${hold.failed}`);
        if (hold.quarantine && existsSync(hold.quarantine)) {
            const walk = (d, rel) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
            lines.push(`quarantined files: ${walk(hold.quarantine, '').join(', ') || '(none)'}`);
        }
    }
    unlinkSync(path);
    lines.push('hold cleared: factory runs start again in this checkout');
    return lines;
}
//# sourceMappingURL=tamper-quarantine.js.map