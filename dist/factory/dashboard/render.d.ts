/**
 * The `omg factory dashboard` page: one self-contained HTML document (inline
 * CSS and SVG, no script, no external font or request; a CSP forbids them),
 * light and dark through prefers-color-scheme. Every dynamic string goes
 * through esc(): issue titles, park text and bench rows are untrusted.
 */
import type { DashboardData } from './collect.js';
export declare const esc: (v: unknown) => string;
export declare function fmtDuration(msValue: number): string;
export declare function renderDashboardHtml(d: DashboardData): string;
//# sourceMappingURL=render.d.ts.map