/**
 * The `factory-attention` notification: one message per attention item that
 * is new since the poll loop's previous tick. Notifications go to
 * third-party services (Discord, Telegram, Slack, Teams, webhooks), so the
 * payload holds ONLY engine-composed text: the repository's folder name,
 * the run key, the group, the gate name of a row whose state is the
 * engine's own, and the first next command without the repository path.
 * Never a title, reason, detail, note or any other string from a state or a
 * lane. The message also goes through the notification redaction.
 *
 * The event is off unless the user's notification config enables it
 * explicitly (`notifications.events["factory-attention"].enabled: true`;
 * see notify() in src/notifications/index.ts).
 */
import { basename } from 'path';
import { plainText } from '../check/score.js';
import { commandLine, GROUP_TITLES } from './actions.js';
/** A gate name the payload may carry: lowercase words and dashes, from a state the engine wrote. */
const GATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^(#\d{1,12}|heal-[0-9a-f]{8}|checkout|slots)$/;
/** The gate of a trusted row, when it is a plain gate name; null otherwise (an untrusted state names any gate). */
export function noticeGate(i) {
    return i.trust === 'ok' && typeof i.gate === 'string' && i.gate.length <= 60 && GATE_NAME.test(i.gate) ? i.gate : null;
}
/** The first next command as one line, `git -C <root> ...` as `git ...` (run in the repository root). */
export function noticeCommand(next) {
    const argv = next[0]?.argv;
    if (!argv || argv.length === 0)
        return null;
    return commandLine(argv[0] === 'git' && argv[1] === '-C' ? ['git', ...argv.slice(3)] : argv, 'linux');
}
export function attentionNotice(root, i) {
    if (!KEY.test(i.key))
        return null;
    return { repo: repoName(root), key: i.key, group: i.group, gate: noticeGate(i), next: noticeCommand(i.next) };
}
export function attentionMoreNotice(root, items) {
    const byGroup = {};
    for (const i of items)
        byGroup[i.group] = (byGroup[i.group] ?? 0) + 1;
    return { repo: repoName(root), more: items.length, byGroup };
}
export function attentionCountNotice(root, count) {
    return { repo: repoName(root), count };
}
const repoName = (root) => [...plainText(basename(root)).replace(/\s+/g, ' ').trim()].slice(0, 60).join('') || 'repository';
export function attentionNoticeText(n) {
    if ('count' in n)
        return `factory ${n.repo}: ${n.count} unverified or damaged state file(s) need inspection\ndetails: omg factory attention`;
    if ('more' in n) {
        const counts = Object.keys(GROUP_TITLES).filter((g) => n.byGroup[g]).map((g) => `${n.byGroup[g]} ${GROUP_TITLES[g].toLowerCase()}`);
        return `factory ${n.repo}: and ${n.more} more item(s) need you: ${counts.join(', ')}\ndetails: omg factory attention`;
    }
    const what = `${GROUP_TITLES[n.group]}${n.gate ? `: ${n.gate}` : ''}`;
    return `factory ${n.repo}: ${n.key} needs you (${what})${n.next ? `\nnext: ${n.next}` : ''}\ndetails: omg factory attention`;
}
/**
 * Send one notice (never throws). No session, pane or project field (notify()
 * adds none for this event) and not replyable: nothing a
 * reply says is ever typed into a terminal. `notify` is the notification
 * stack's (lazily imported, so a poll without notifications never loads it).
 * Once `signal` aborts (the poll's timeout), the send is abandoned: the
 * returned promise settles and nothing more is started for it.
 */
export async function sendAttentionNotice(n, notify, signal) {
    try {
        if (signal?.aborted)
            return;
        const send = notify ?? (await import('../../notifications/index.js')).notify;
        const { redactTokens } = await import('../../notifications/redact.js');
        if (signal?.aborted)
            return;
        await untilAborted(send('factory-attention', { sessionId: 'factory-attention', message: redactTokens(attentionNoticeText(n)), replyable: false }), signal);
    }
    catch {
        // A notification is best effort: the poll tick printed the item already.
    }
}
/** Settles with `p`, or as soon as `signal` aborts (the promise is abandoned: its result is ignored). */
export function untilAborted(p, signal) {
    if (!signal)
        return p.then(() => undefined);
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        signal.addEventListener('abort', done, { once: true });
        p.then(done, (error) => { signal.removeEventListener('abort', done); reject(error); });
    });
}
//# sourceMappingURL=notify.js.map