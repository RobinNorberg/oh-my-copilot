/**
 * The review lane's output contract (design §5): the final assistant message
 * ends with exactly one fenced `json` block
 *
 *   { "verdict": "approve" | "request-changes", "sha": "<40 hex>",
 *     "findings": [{ "severity": "blocker"|"major"|"minor"|"nit", "file"?, "line"?, "summary" }],
 *     "notes"?: "<= 500 chars" }
 *
 * The lane reads untrusted PR content, so anything off-contract is `invalid`
 * (no verdict recorded): no block, two blocks (a quoted block could be the
 * PR's), text after the block, a wrong sha, bad fields. An approve carrying a
 * blocker or major finding counts as changes-requested (fail closed).
 */

import type { FactoryFinding } from './state.js';

export const MAX_REVIEW_NOTES = 500;
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

export type ParsedReview =
  | { kind: 'valid'; verdict: 'approve' | 'changes-requested'; sha: string; findings: FactoryFinding[]; notes: string; downgraded: boolean }
  | { kind: 'invalid'; reason: string };

/**
 * A verdict block: an opening line of exactly ```json and a closing line of
 * exactly ```, both at the start of a line. A block quoted from the diff
 * (`> ```json`, an indented or `+` diff line) or wrapped in a longer fence
 * never matches on its own; the lane's own block plus a pasted copy is two
 * blocks, which is invalid.
 */
const FENCE = /^```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*$/gm;
/** Any line opening a json fence, quoted, indented or longer: counted so a pasted copy cannot hide. */
const ANY_JSON_FENCE = /^[^\S\r\n]*(?:>[^\S\r\n]*)*`{3,}json\b/gm;

export function parseReviewOutput(finalText: string | null | undefined, expectedSha: string): ParsedReview {
  const invalid = (reason: string): ParsedReview => ({ kind: 'invalid', reason });
  if (typeof finalText !== 'string' || !finalText.trim()) return invalid('the review lane left no final message');
  const blocks = [...finalText.matchAll(FENCE)];
  if (blocks.length === 0) return invalid('no fenced json verdict block');
  if (blocks.length > 1) return invalid(`${blocks.length} fenced json blocks; the contract is exactly one`);
  const fences = [...finalText.matchAll(ANY_JSON_FENCE)].length;
  if (fences > 1) return invalid(`${fences} json fences (quoted or indented ones included); the contract is exactly one block`);
  const block = blocks[0];
  if (finalText.slice(block.index! + block[0].length).trim()) return invalid('text after the verdict block');
  let raw: unknown;
  try {
    raw = JSON.parse(block[1]);
  } catch (error) {
    return invalid(`verdict block is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('verdict block is not an object');
  const o = raw as Record<string, unknown>;
  if (o.verdict !== 'approve' && o.verdict !== 'request-changes') return invalid(`verdict must be "approve" or "request-changes", got ${JSON.stringify(o.verdict)}`);
  if (typeof o.sha !== 'string' || !/^[0-9a-f]{40}$/.test(o.sha)) return invalid('sha must be a full 40-hex commit id');
  if (o.sha !== expectedSha) return invalid(`sha ${o.sha.slice(0, 12)} is not the reviewed head ${expectedSha.slice(0, 12)}`);
  if (!Array.isArray(o.findings)) return invalid('findings must be an array');
  const findings: FactoryFinding[] = [];
  for (const [i, f] of o.findings.entries()) {
    const x = f as Record<string, unknown>;
    if (typeof f !== 'object' || f === null || !SEVERITIES.includes(x.severity as FactoryFinding['severity'])) return invalid(`findings[${i}].severity is not one of ${SEVERITIES.join(', ')}`);
    if (typeof x.summary !== 'string' || !x.summary.trim()) return invalid(`findings[${i}].summary must be a non-empty string`);
    if (x.file !== undefined && typeof x.file !== 'string') return invalid(`findings[${i}].file must be a string`);
    if (x.line !== undefined && !(Number.isInteger(x.line) && (x.line as number) > 0)) return invalid(`findings[${i}].line must be a positive integer`);
    findings.push({
      severity: x.severity as FactoryFinding['severity'],
      summary: x.summary.slice(0, 500),
      ...(typeof x.file === 'string' ? { file: x.file.slice(0, 300) } : {}),
      ...(typeof x.line === 'number' ? { line: x.line } : {}),
    });
  }
  if (o.notes !== undefined && typeof o.notes !== 'string') return invalid('notes must be a string');
  const notes = (o.notes as string | undefined ?? '').slice(0, MAX_REVIEW_NOTES);
  const serious = findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
  const downgraded = o.verdict === 'approve' && serious;
  return { kind: 'valid', verdict: o.verdict === 'approve' && !serious ? 'approve' : 'changes-requested', sha: o.sha, findings, notes, downgraded };
}

/** One-line ship verdict notes: the top findings by severity. */
export function verdictNotes(review: Extract<ParsedReview, { kind: 'valid' }>): string {
  const order = (s: FactoryFinding['severity']) => SEVERITIES.indexOf(s);
  const top = [...review.findings].sort((a, b) => order(a.severity) - order(b.severity)).slice(0, 3)
    .map((f) => `${f.severity}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.summary}`);
  const prefix = review.downgraded ? 'approve with blocker/major findings counted as changes-requested; ' : '';
  return `${prefix}${top.join(' | ') || review.notes || 'no findings'}`.slice(0, MAX_REVIEW_NOTES);
}

/** The PR comment the engine posts for a recorded review. */
export function reviewComment(review: Extract<ParsedReview, { kind: 'valid' }>, reviewer: string): string {
  const lines = [
    `### Factory review: ${review.verdict} at \`${review.sha.slice(0, 12)}\``,
    '',
    `Reviewer lane \`${reviewer}\` (fresh session on the exact head; a filter, not the merge gate).`,
  ];
  if (review.downgraded) lines.push('', 'The reviewer approved with a blocker or major finding; the engine counts that as changes requested.');
  if (review.findings.length > 0) {
    lines.push('', '| Severity | Where | Finding |', '|---|---|---|');
    for (const f of review.findings) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      lines.push(`| ${f.severity} | ${where} | ${f.summary.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |`);
    }
  }
  if (review.notes) lines.push('', review.notes);
  return `${lines.join('\n')}\n`;
}
