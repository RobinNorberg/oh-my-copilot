/**
 * The `omg factory attention` terminal view: a summary line, then one
 * section per non-empty group in the fixed order, one block per item.
 * Plain text with chalk (which honours NO_COLOR and FORCE_COLOR), as
 * `omg factory board` renders. Every string in AttentionData already went
 * through plainText in collect.ts; commands are printed from their argv.
 */
import type { AttentionData } from './collect.js';
export declare function ageText(ms: number | null): string;
export declare function summaryLine(d: AttentionData): string;
/** Characters of reason per line: with its prefix a line stays inside an 80-column terminal, so the terminal does not wrap it. */
export declare const REASON_WIDTH = 64;
/**
 * The reason cut into lines of REASON_WIDTH, each behind a fixed prefix
 * (`reason: `, then `| `): no reason text starts a line, so none can look
 * like a `$` command row.
 */
export declare function reasonLines(reason: string): string[];
export declare function renderAttention(d: AttentionData, o?: {
    verbose?: boolean;
}): string;
//# sourceMappingURL=render.d.ts.map