/**
 * The `omg factory attention` terminal view: a summary line, then one
 * section per non-empty group in the fixed order, one block per item.
 * Plain text with chalk (which honours NO_COLOR and FORCE_COLOR), as
 * `omg factory board` renders. Every string in AttentionData already went
 * through plainText in collect.ts; commands are printed from their argv.
 *
 * Width: every line that can hold text from a state (the title line, the
 * facts, the why, the notes, the reason, the warnings) is cut or wrapped by
 * display width to the terminal's width, so the terminal never wraps it: a
 * wrapped tail would start a screen line with text from the state, which
 * could look like a `$` command row. Continuation lines get a fixed `| `
 * marker. Command lines are built from validated fields only and are never
 * cut (a cut command is not copyable).
 */
import chalk from 'chalk';
import { stripAnsi } from '../../utils/string-width.js';
import { ATTENTION_GROUPS, commandText, GROUP_TITLES } from './actions.js';
export function ageText(ms) {
    if (ms === null)
        return 'age unknown';
    const m = Math.floor(ms / 60_000);
    if (m < 60)
        return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48)
        return `${h} h`;
    return `${Math.floor(h / 24)} d`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function summaryLine(d) {
    const total = d.items.length;
    const parts = ATTENTION_GROUPS.filter((g) => d.summary.byGroup[g] > 0).map((g) => `${GROUP_TITLES[g].toLowerCase()} ${d.summary.byGroup[g]}`);
    const engines = d.summary.engines.live === 0 ? 'no engine running' : `${plural(d.summary.engines.live, 'engine')} running`;
    return `${total === 0 ? 'nothing needs you' : `${plural(total, 'item')} need${total === 1 ? 's' : ''} you`}${parts.length ? `: ${parts.join(', ')}` : ''}; ${engines}`;
}
/** The narrowest and the assumed terminal width (no TTY, or one that reports no width). */
export const MIN_COLUMNS = 40;
export const DEFAULT_COLUMNS = 80;
/** The width lines are laid out for: the terminal's columns, at least MIN_COLUMNS, DEFAULT_COLUMNS when unknown. */
export function layoutColumns(columns) {
    return typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.max(MIN_COLUMNS, Math.floor(columns)) : DEFAULT_COLUMNS;
}
/**
 * Columns one code point takes AT MOST: 1 for printable ASCII, 2 for
 * anything else. East Asian wide and fullwidth characters take 2, and so do
 * the "ambiguous" ones (many accented letters, Greek, Cyrillic, box drawing)
 * in a terminal set to draw them wide; no terminal cell grid gives a code
 * point more than 2. An upper bound, so a cut by it never overflows a line:
 * non-ASCII text gets shorter lines than it could, never longer.
 */
export function cellWidth(ch) {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0x20 && cp <= 0x7e ? 1 : 2;
}
export function textWidth(s) {
    let w = 0;
    for (const ch of stripAnsi(s))
        w += cellWidth(ch);
    return w;
}
/** The longest prefix of `s` at most `max` columns wide (by cellWidth). */
export function cutToWidth(s, max) {
    let w = 0;
    let out = '';
    for (const ch of s) {
        const c = cellWidth(ch);
        if (w + c > max)
            break;
        out += ch;
        w += c;
    }
    return out;
}
/**
 * `text` laid out behind `first` on the first line and `cont` on the next
 * ones, each line at most `columns - 1` columns wide (one spare column: a
 * line exactly as wide as the terminal makes some terminals wrap). Breaks at
 * a space when the line has one, else mid-word. Every line starts with its
 * fixed prefix, so no text from `text` starts a screen line.
 */
export function wrapLines(first, cont, text, columns) {
    const max = columns - 1;
    const out = [];
    let rest = text;
    let prefix = first;
    for (;;) {
        const room = Math.max(1, max - textWidth(prefix));
        if (textWidth(rest) <= room) {
            out.push(prefix + rest);
            return out;
        }
        let chunk = cutToWidth(rest, room);
        if (chunk.length === 0)
            chunk = [...rest][0];
        const space = chunk.lastIndexOf(' ');
        if (space > 0 && rest[chunk.length] !== ' ')
            chunk = chunk.slice(0, space);
        out.push(prefix + chunk.trimEnd());
        rest = rest.slice(chunk.length).replace(/^ +/, '');
        prefix = cont;
        if (rest.length === 0)
            return out;
    }
}
const CONT = '      | ';
/** The reason behind a fixed `reason: ` / `| ` prefix, wrapped to the terminal width. */
export function reasonLines(reason, columns = DEFAULT_COLUMNS) {
    return wrapLines('    reason: ', '          | ', reason, columns);
}
function itemLines(i, verbose, columns) {
    const keyPart = `  ${i.key}`;
    // The title is cut, never wrapped: one line per row head.
    const title = i.title ? cutToWidth(i.title, columns - 1 - textWidth(keyPart) - 2) : '';
    // An untrusted row has no title (collect.ts); the fixed note says why.
    const lines = [title ? `${chalk.bold(keyPart)}  ${title}` : i.trust !== 'ok' ? `${chalk.bold(keyPart)}  ${chalk.gray('(title withheld)')}` : chalk.bold(keyPart)];
    const facts = [i.gate ? `awaiting-human: ${i.gate}` : null, i.phase ? `phase ${i.phase}` : null, ageText(i.ageMs)];
    if (i.credits !== null)
        facts.push(`${i.credits.toFixed(2)}${i.cap !== null ? ` of ${i.cap}` : ''} cr`);
    if (i.pr !== null)
        facts.push(`PR ${i.pr}`);
    // An untrusted row leads with its trust, so the warning is never the part a narrow terminal wraps away.
    const trust = i.trust !== 'ok' ? `trust: ${i.trust}` : null;
    if (trust)
        facts.unshift(trust);
    for (const l of wrapLines('    ', CONT, facts.filter(Boolean).join('  '), columns))
        lines.push(trust && l.startsWith(`    ${trust}`) ? `    ${chalk.red(trust)}${l.slice(4 + trust.length)}` : l);
    lines.push(...wrapLines('    ', CONT, i.why, columns));
    for (const n of i.notes)
        for (const l of wrapLines('    note: ', CONT, n, columns))
            lines.push(chalk.yellow(l));
    // Only a trusted row carries a reason (collect.ts); the check here keeps an untrusted one off the screen regardless.
    if (verbose && i.reason && i.trust === 'ok')
        for (const l of reasonLines(i.reason, columns))
            lines.push(chalk.gray(l));
    // The read error of an untrusted row (it can quote the file's bytes and a local path): --verbose only, behind a prefix.
    if (verbose && i.error)
        for (const l of wrapLines('    error: ', '          | ', i.error, columns))
            lines.push(chalk.gray(l));
    for (const n of i.next) {
        const c = commandText(n.argv);
        if (c.inRoot)
            lines.push(chalk.gray('    run in the repository root:'));
        lines.push(`    ${chalk.cyan('$')} ${c.line}  ${chalk.gray(`# ${n.label}${n.billed ? ' (billed)' : ''}`)}`);
    }
    if (i.log)
        lines.push(chalk.gray(`    log: ${i.log}`));
    return lines;
}
/** A warning wrapped behind a fixed `warning: ` / `| ` prefix (it can quote an error message about a state file). */
export function warningLines(w, columns = DEFAULT_COLUMNS) {
    return wrapLines('warning: ', '  | ', w, columns);
}
export function renderAttention(d, o = {}) {
    const columns = layoutColumns(o.columns);
    // The summary holds counts and fixed words only: the terminal may wrap it.
    const lines = [chalk.bold(`factory attention  ${d.forge ?? 'forge unknown'}  (local state only)`), summaryLine(d)];
    for (const g of ATTENTION_GROUPS) {
        const items = d.items.filter((i) => i.group === g);
        if (items.length === 0)
            continue;
        lines.push('', chalk.bold(`${GROUP_TITLES[g].toUpperCase()} (${items.length})`));
        for (const i of items)
            lines.push(...itemLines(i, Boolean(o.verbose), columns));
    }
    return lines.join('\n');
}
//# sourceMappingURL=render.js.map