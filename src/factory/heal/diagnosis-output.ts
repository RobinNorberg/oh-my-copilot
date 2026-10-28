/**
 * The debugger lane's output contract (design §5). The final assistant
 * message ends with exactly one fenced `json` block, under the same fence
 * rules as the review lane (review-output.ts):
 *
 *   { "class": "regression" | "env-change" | "test-bug" | "flaky" | "unknown",
 *     "rootCause": "...", "evidence": ["failures/1.log:12", "env-diff.json:git"],
 *     "reproduced": true | false, "reproCommand"?: "npx vitest run <file>",
 *     "fix": { "summary": "...", "files": ["src/..."], "acceptance": ["..."] } | null }
 *
 * The lane read untrusted CI text, so anything off-contract is `invalid`.
 * Each evidence citation must name a file in the bundle and an anchor in it:
 * a line number within the file, or, for a JSON file, a key it holds. A
 * schema-valid diagnosis is `rejected` (recorded, never acted on) when its
 * class is `flaky` (known-flaky additions are human-only) or its fix names a
 * protected path.
 */

import { protectedChanges } from '../../ship/merge.js';
import { ANY_JSON_FENCE, FENCE } from '../run/review-output.js';
import type { EvidenceBundle } from './heal-evidence.js';

export const DIAGNOSIS_CLASSES = ['regression', 'env-change', 'test-bug', 'flaky', 'unknown'] as const;
export type DiagnosisClass = (typeof DIAGNOSIS_CLASSES)[number];

export const DIAGNOSIS_LIMITS = Object.freeze({
  rootCause: 2000,
  evidence: 20,
  citation: 200,
  reproCommand: 300,
  fixSummary: 1000,
  fixFiles: 20,
  acceptance: 10,
  acceptanceItem: 300,
});

const REPO_PATH = /^[\w.@-][\w.@-]*(?:\/[\w.@-][\w.@-]*)*$/;
const REPRO = /^npx vitest run(?: [\w@./:=-]+)+$/;

export interface Diagnosis {
  class: DiagnosisClass;
  rootCause: string;
  evidence: string[];
  reproduced: boolean;
  reproCommand?: string;
  fix: { summary: string; files: string[]; acceptance: string[] } | null;
}

export type ParsedDiagnosis =
  | { kind: 'valid'; diagnosis: Diagnosis }
  | { kind: 'rejected'; diagnosis: Diagnosis; reason: string }
  | { kind: 'invalid'; reason: string };

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const oneLine = (s: string) => !/[\r\n\p{Zl}\p{Zp}]/u.test(s);
/** Multi-line prose: control characters other than newline are refused (they would reach the terminal). */
const prose = (v: unknown, max: number): string | null => {
  const t = text(v, max);
  return t !== null && !/(?!\n)\p{Cc}/u.test(t) ? t : null;
};

/** Why a citation does not point into the bundle, or null. */
export function citationProblem(citation: string, bundle: EvidenceBundle): string | null {
  const m = /^([\w./-]+):([\w.-]+)$/.exec(citation);
  if (!m) return `citation ${JSON.stringify(citation.slice(0, 80))} is not <file>:<line or key>`;
  const [, name, anchor] = m;
  // Own keys only: `constructor`, `__proto__` or `toString` must not resolve to Object.prototype.
  const file = Object.hasOwn(bundle.files, name) ? bundle.files[name] : undefined;
  if (!file) return `citation ${citation} names a file outside the bundle`;
  if (/^\d+$/.test(anchor)) {
    const line = Number(anchor);
    return line >= 1 && line <= file.lines.length ? null : `citation ${citation} is past the end of ${name} (${file.lines.length} lines)`;
  }
  if (file.jsonKeys?.includes(anchor)) return null;
  return file.jsonKeys ? `citation ${citation} names no key of ${name}` : `citation ${citation}: ${name} is cited by line number`;
}

export function parseDiagnosisOutput(finalText: string | null | undefined, bundle: EvidenceBundle): ParsedDiagnosis {
  const invalid = (reason: string): ParsedDiagnosis => ({ kind: 'invalid', reason });
  if (typeof finalText !== 'string' || !finalText.trim()) return invalid('the debugger lane left no final message');
  const blocks = [...finalText.matchAll(FENCE)];
  if (blocks.length === 0) return invalid('no fenced json diagnosis block');
  if (blocks.length > 1) return invalid(`${blocks.length} fenced json blocks; the contract is exactly one`);
  const fences = [...finalText.matchAll(ANY_JSON_FENCE)].length;
  if (fences > 1) return invalid(`${fences} json fences (quoted or indented ones included); the contract is exactly one block`);
  const block = blocks[0];
  if (finalText.slice(block.index! + block[0].length).trim()) return invalid('text after the diagnosis block');
  let raw: unknown;
  try {
    raw = JSON.parse(block[1]);
  } catch (error) {
    return invalid(`diagnosis block is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return checkDiagnosis(raw, bundle);
}

/**
 * The contract on a parsed diagnosis object. `bundle` null skips the
 * citation check only: the ci-heal engine re-checks its sealed copy of a
 * diagnosis whose citations were checked when the lane answered.
 */
export function checkDiagnosis(raw: unknown, bundle: EvidenceBundle | null): ParsedDiagnosis {
  const invalid = (reason: string): ParsedDiagnosis => ({ kind: 'invalid', reason });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('diagnosis block is not an object');
  const o = raw as Record<string, unknown>;
  const allowed = new Set(['class', 'rootCause', 'evidence', 'reproduced', 'reproCommand', 'fix']);
  const extra = Object.keys(o).filter((k) => !allowed.has(k));
  if (extra.length > 0) return invalid(`unknown field(s): ${extra.slice(0, 5).join(', ')}`);
  if (!DIAGNOSIS_CLASSES.includes(o.class as DiagnosisClass)) return invalid(`class must be one of ${DIAGNOSIS_CLASSES.join(', ')}`);
  const rootCause = prose(o.rootCause, DIAGNOSIS_LIMITS.rootCause);
  if (!rootCause) return invalid(`rootCause must be a non-empty string of at most ${DIAGNOSIS_LIMITS.rootCause} characters without control characters`);
  if (!Array.isArray(o.evidence) || o.evidence.length === 0 || o.evidence.length > DIAGNOSIS_LIMITS.evidence) {
    return invalid(`evidence must be an array of 1 to ${DIAGNOSIS_LIMITS.evidence} citations`);
  }
  const evidence: string[] = [];
  for (const [i, e] of o.evidence.entries()) {
    if (typeof e !== 'string' || e.length > DIAGNOSIS_LIMITS.citation) return invalid(`evidence[${i}] must be a string of at most ${DIAGNOSIS_LIMITS.citation} characters`);
    const problem = bundle ? citationProblem(e, bundle) : null;
    if (problem) return invalid(problem);
    evidence.push(e);
  }
  if (typeof o.reproduced !== 'boolean') return invalid('reproduced must be true or false');
  let reproCommand: string | undefined;
  if (o.reproCommand !== undefined && o.reproCommand !== null) {
    const r = text(o.reproCommand, DIAGNOSIS_LIMITS.reproCommand);
    if (!r || !REPRO.test(r)) return invalid('reproCommand must be one line of the form "npx vitest run <file> ..."');
    reproCommand = r;
  }
  let fix: Diagnosis['fix'] = null;
  if (o.fix !== null) {
    if (typeof o.fix !== 'object' || o.fix === undefined || Array.isArray(o.fix)) return invalid('fix must be an object or null');
    const f = o.fix as Record<string, unknown>;
    const summary = prose(f.summary, DIAGNOSIS_LIMITS.fixSummary);
    if (!summary) return invalid(`fix.summary must be a non-empty string of at most ${DIAGNOSIS_LIMITS.fixSummary} characters without control characters`);
    // A segment ending in `.` is one Windows would resolve to another name (`workflows.` is `workflows`).
    if (!Array.isArray(f.files) || f.files.length === 0 || f.files.length > DIAGNOSIS_LIMITS.fixFiles
      || !f.files.every((p) => typeof p === 'string' && p.length <= 300 && REPO_PATH.test(p) && !p.split('/').some((s) => s.endsWith('.')))) {
      return invalid(`fix.files must be 1 to ${DIAGNOSIS_LIMITS.fixFiles} repository-relative paths`);
    }
    if (!Array.isArray(f.acceptance) || f.acceptance.length === 0 || f.acceptance.length > DIAGNOSIS_LIMITS.acceptance
      || !f.acceptance.every((a) => text(a, DIAGNOSIS_LIMITS.acceptanceItem) !== null && oneLine(a as string))) {
      return invalid(`fix.acceptance must be 1 to ${DIAGNOSIS_LIMITS.acceptance} one-line criteria of at most ${DIAGNOSIS_LIMITS.acceptanceItem} characters`);
    }
    fix = { summary, files: [...new Set(f.files as string[])], acceptance: (f.acceptance as string[]).map((a) => a.trim()) };
  }
  const diagnosis: Diagnosis = { class: o.class as DiagnosisClass, rootCause, evidence, reproduced: o.reproduced, ...(reproCommand ? { reproCommand } : {}), fix };
  if (diagnosis.class === 'flaky') return { kind: 'rejected', diagnosis, reason: 'class flaky: a known-flaky entry is a human decision, never a heal PR' };
  const guarded = protectedChanges(fix?.files ?? []);
  if (guarded.length > 0) return { kind: 'rejected', diagnosis, reason: `fix.files names protected path(s): ${guarded.join(', ')}` };
  if (!fix) return { kind: 'rejected', diagnosis, reason: 'no fix proposed' };
  return { kind: 'valid', diagnosis };
}
