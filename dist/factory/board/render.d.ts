/**
 * The `omg factory board` terminal view (ADO parity design §1): one section
 * per non-empty column, top to bottom (terminals are narrow). Every string
 * in the BoardJson was already passed through plainText by collect.ts.
 */
import type { BoardJson, BoardRow } from './collect.js';
/** `--source` as a short header text: `label factory`, `area-tag Web\Factory#factory`, … */
export declare function sourceText(source: Record<string, unknown>): string;
export declare function backlogLine(r: BoardRow): string;
export declare function runLine(r: BoardRow, prefix: string): string;
export declare function renderBoard(b: BoardJson): string;
//# sourceMappingURL=render.d.ts.map