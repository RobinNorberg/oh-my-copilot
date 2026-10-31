/**
 * The `omg factory board` terminal view (ADO parity design §1): one section
 * per non-empty column, top to bottom (terminals are narrow). Every string
 * in the BoardJson was already passed through plainText by collect.ts.
 */

import chalk from 'chalk';
import { plainText } from '../check/score.js';
import { runLabel } from '../run/state.js';
import type { BoardJson, BoardRow } from './collect.js';

/** `--source` as a short header text: `label factory`, `area-tag Web\Factory#factory`, … */
export function sourceText(source: Record<string, unknown>): string {
  const v = (k: string) => String(source[k] ?? '');
  switch (source.type) {
    case 'label': return `label ${v('label')}`;
    case 'milestone': return `milestone ${v('milestone')}`;
    case 'wiql-query': return `wiql-query ${v('queryId')}`;
    case 'board-column': return `board-column ${v('team')}/${v('board')}/${v('column')}`;
    case 'area-tag': return `area-tag ${v('areaPath')}#${v('tag')}`;
    default: return v('type');
  }
}

const BUCKET_COLOR = { runnable: chalk.green, 'needs-plan': chalk.yellow, blocked: chalk.red } as const;

function flagText(r: BoardRow): string[] {
  return r.flags.map((f) => {
    if (f === 'drift') return chalk.yellow(`drift: live ${JSON.stringify(r.liveText ?? r.stage.live)} != recorded ${r.stage.recorded}`);
    if (f === 'unsynced') return chalk.yellow(`unsynced: recorded ${r.stage.recorded ?? '-'} != expected ${r.stage.expected}`);
    if (f === 'seal') return chalk.red('seal!');
    return chalk.yellow('stale');
  });
}

export function backlogLine(r: BoardRow): string {
  const id = runLabel(r.id).padEnd(6);
  if (r.error) return `  ${chalk.red('read-failed'.padEnd(10))}  ${id}  ${r.error}`;
  const pri = r.check?.priority ? `P${r.check.priority}` : '- ';
  const title = r.title.slice(0, 40).padEnd(40);
  if (!r.check) return `  ${id}  ${title}${r.flags.length ? `  ${flagText(r).join('  ')}` : ''}`;
  const bucket = BUCKET_COLOR[r.check.bucket](r.check.bucket.padEnd(10));
  return `  ${bucket}  ${id}  ${pri}  ${title}  ${r.check.reasons[0] ?? ''}${r.check.reasons.length ? `  ${chalk.gray(r.check.detail)}` : ''}${r.flags.length ? `  ${flagText(r).join('  ')}` : ''}`;
}

export function runLine(r: BoardRow, prefix: string): string {
  const run = r.run;
  const parts = [runLabel(r.id).padEnd(6)];
  if (r.error) parts.push(chalk.red(`read-failed: ${r.error}`));
  if (run) {
    parts.push(run.gate ? chalk.yellow(`awaiting-human: ${run.gate.name}`) : run.phase);
    if (run.runningLane) parts.push(`lane ${run.runningLane} running`);
    parts.push(`${run.credits.toFixed(2)} cr`);
    if (run.pr !== undefined) parts.push(`PR ${prefix}${run.pr}`);
    if (run.head) parts.push(`head ${run.head.slice(0, 12)}`);
  }
  if (r.gates) parts.push(`verdict ${r.gates.verdict} @ ${r.gates.sha.slice(0, 12)}`);
  if (r.title) parts.push(r.title.slice(0, 40));
  parts.push(...flagText(r));
  const lines = [`  ${parts.join('  ')}`];
  if (run?.gate) lines.push(chalk.gray(`        ${run.gate.reason}`));
  return lines.join('\n');
}

export function renderBoard(b: BoardJson): string {
  const prefix = b.forge === 'azure-devops' ? '!' : '#';
  const items = b.columns.reduce((n, c) => n + c.items.length, 0);
  const runs = b.columns.reduce((n, c) => n + c.items.filter((r) => r.run).length, 0) + b.outside.length;
  const source = b.parent ? `spec #${b.parent.id} ${b.parent.title}` : b.source ? `source ${plainText(sourceText(b.source))}` : 'no intake source';
  const lines = [chalk.bold(`factory board  ${b.forge} ${b.repo}  ${source}  (${items} item${items === 1 ? '' : 's'}, ${runs} run${runs === 1 ? '' : 's'})`)];
  for (const c of b.columns) {
    if (c.items.length === 0) continue;
    lines.push('');
    lines.push(chalk.bold(c.title === c.stage ? c.stage.toUpperCase() : `${c.stage.toUpperCase()} (${c.title})`));
    for (const r of c.items) lines.push(c.stage === 'backlog' ? backlogLine(r) : runLine(r, prefix));
  }
  if (b.outside.length > 0) {
    lines.push('');
    lines.push(chalk.bold('RUNS NOT IN THE INTAKE SOURCE'));
    for (const r of b.outside) lines.push(runLine(r, prefix));
  }
  if (items === 0 && b.outside.length === 0) lines.push('no items and no runs in flight');
  return lines.join('\n');
}
