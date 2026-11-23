/**
 * The `omg factory dashboard` page (schemaVersion 2 data): a pure
 * `render(JSON) -> HTML` step. One self-contained document: inline CSS and
 * SVG, NO script, no external font or request (a CSP forbids them), no
 * buttons or forms (the dashboard takes no action; commands are copyable
 * text). Light and dark through prefers-color-scheme; tables stack into
 * cards under 700 px. Every dynamic string goes through esc(): titles,
 * reasons, lane ids and bench rows are untrusted, also inside attributes
 * and SVG text.
 */
import type { DashboardDataV2 } from './collect-v2.js';
export declare const esc: (v: unknown) => string;
export declare function fmtDuration(msValue: number): string;
/** At most this many runs open in the Runs table; the rest sit behind one <details>. */
export declare const RUNS_OPEN = 50;
export interface RenderOptions {
    /** `--watch`: the page reloads itself every this many seconds (meta refresh). Absent: a one-shot page that never reloads. */
    refreshSeconds?: number;
}
export declare function renderDashboardHtml(d: DashboardDataV2, o?: RenderOptions): string;
//# sourceMappingURL=render.d.ts.map