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
export declare function renderAttention(d: AttentionData, o?: {
    verbose?: boolean;
}): string;
//# sourceMappingURL=render.d.ts.map