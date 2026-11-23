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
import type { AttentionData } from './collect.js';
export declare function ageText(ms: number | null): string;
export declare function summaryLine(d: AttentionData): string;
/** The narrowest and the assumed terminal width (no TTY, or one that reports no width). */
export declare const MIN_COLUMNS = 40;
export declare const DEFAULT_COLUMNS = 80;
/** The width lines are laid out for: the terminal's columns, at least MIN_COLUMNS, DEFAULT_COLUMNS when unknown. */
export declare function layoutColumns(columns: number | undefined): number;
/**
 * Columns one code point takes AT MOST: 1 for printable ASCII, 2 for
 * anything else. East Asian wide and fullwidth characters take 2, and so do
 * the "ambiguous" ones (many accented letters, Greek, Cyrillic, box drawing)
 * in a terminal set to draw them wide; no terminal cell grid gives a code
 * point more than 2. An upper bound, so a cut by it never overflows a line:
 * non-ASCII text gets shorter lines than it could, never longer.
 */
export declare function cellWidth(ch: string): number;
export declare function textWidth(s: string): number;
/** The longest prefix of `s` at most `max` columns wide (by cellWidth). */
export declare function cutToWidth(s: string, max: number): string;
/**
 * `text` laid out behind `first` on the first line and `cont` on the next
 * ones, each line at most `columns - 1` columns wide (one spare column: a
 * line exactly as wide as the terminal makes some terminals wrap). Breaks at
 * a space when the line has one, else mid-word. Every line starts with its
 * fixed prefix, so no text from `text` starts a screen line.
 */
export declare function wrapLines(first: string, cont: string, text: string, columns: number): string[];
/** The reason behind a fixed `reason: ` / `| ` prefix, wrapped to the terminal width. */
export declare function reasonLines(reason: string, columns?: number): string[];
/** A warning wrapped behind a fixed `warning: ` / `| ` prefix (it can quote an error message about a state file). */
export declare function warningLines(w: string, columns?: number): string[];
export declare function renderAttention(d: AttentionData, o?: {
    verbose?: boolean;
    columns?: number;
}): string;
//# sourceMappingURL=render.d.ts.map