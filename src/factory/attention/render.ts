/**
 * The `omg factory attention` terminal view: a summary line, then one
 * section per non-empty group in the fixed order, one block per item.
 * Plain text with chalk (which honours NO_COLOR and FORCE_COLOR), as
 * `omg factory board` renders. Every string in AttentionData already went
 * through plainText in collect.ts; commands are printed from their argv.
 */

import chalk from 'chalk';
import { ATTENTION_GROUPS, commandText, GROUP_TITLES } from './actions.js';
import type { AttentionData, AttentionItem } from './collect.js';

export function ageText(ms: number | null): string {
  if (ms === null) return 'age unknown';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function summaryLine(d: AttentionData): string {
  const total = d.items.length;
  const parts = ATTENTION_GROUPS.filter((g) => d.summary.byGroup[g] > 0).map((g) => `${GROUP_TITLES[g].toLowerCase()} ${d.summary.byGroup[g]}`);
  const engines = d.summary.engines.live === 0 ? 'no engine running' : `${plural(d.summary.engines.live, 'engine')} running`;
  return `${total === 0 ? 'nothing needs you' : `${plural(total, 'item')} need${total === 1 ? 's' : ''} you`}${parts.length ? `: ${parts.join(', ')}` : ''}; ${engines}`;
}

/** Characters of reason per line: with its prefix a line stays inside an 80-column terminal, so the terminal does not wrap it. */
export const REASON_WIDTH = 64;

/**
 * The reason cut into lines of REASON_WIDTH, each behind a fixed prefix
 * (`reason: `, then `| `): no reason text starts a line, so none can look
 * like a `$` command row.
 */
export function reasonLines(reason: string): string[] {
  const chars = [...reason];
  const out: string[] = [];
  for (let k = 0; k < chars.length; k += REASON_WIDTH) out.push(`    ${k === 0 ? 'reason: ' : '      | '}${chars.slice(k, k + REASON_WIDTH).join('')}`);
  return out;
}

function itemLines(i: AttentionItem, verbose: boolean): string[] {
  const head = [chalk.bold(i.key)];
  if (i.title) head.push(i.title);
  const facts = [i.gate ? `awaiting-human: ${i.gate}` : null, i.phase ? `phase ${i.phase}` : null, ageText(i.ageMs)];
  if (i.credits !== null) facts.push(`${i.credits.toFixed(2)}${i.cap !== null ? ` of ${i.cap}` : ''} cr`);
  if (i.pr !== null) facts.push(`PR ${i.pr}`);
  if (i.trust !== 'ok') facts.push(chalk.red(`trust: ${i.trust}`));
  const lines = [`  ${head.join('  ')}`, `    ${facts.filter(Boolean).join('  ')}`, `    ${i.why}`];
  for (const n of i.notes) lines.push(chalk.yellow(`    note: ${n}`));
  // Only a trusted row carries a reason (collect.ts); the check here keeps an untrusted one off the screen regardless.
  if (verbose && i.reason && i.trust === 'ok') for (const l of reasonLines(i.reason)) lines.push(chalk.gray(l));
  for (const n of i.next) {
    const c = commandText(n.argv);
    if (c.inRoot) lines.push(chalk.gray('    run in the repository root:'));
    lines.push(`    ${chalk.cyan('$')} ${c.line}  ${chalk.gray(`# ${n.label}${n.billed ? ' (billed)' : ''}`)}`);
  }
  if (i.log) lines.push(chalk.gray(`    log: ${i.log}`));
  return lines;
}

export function renderAttention(d: AttentionData, o: { verbose?: boolean } = {}): string {
  const lines = [chalk.bold(`factory attention  ${d.forge ?? 'forge unknown'}  (local state only)`), summaryLine(d)];
  for (const g of ATTENTION_GROUPS) {
    const items = d.items.filter((i) => i.group === g);
    if (items.length === 0) continue;
    lines.push('', chalk.bold(`${GROUP_TITLES[g].toUpperCase()} (${items.length})`));
    for (const i of items) lines.push(...itemLines(i, Boolean(o.verbose)));
  }
  return lines.join('\n');
}
