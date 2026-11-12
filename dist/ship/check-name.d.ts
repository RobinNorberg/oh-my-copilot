/**
 * A forge-reported check name or state in a reason text (it may reach a PR
 * comment, the console or progress sync): one line, no control or format
 * characters (bidi, zero-width), no backticks, no '@' that could mention
 * someone (a full-width '＠' instead), no '|' that could split a table cell
 * ('¦'), capped. Decisions keep the raw names; only the text is sanitised.
 */
export declare const checkText: (s: string, max: number) => string;
/** A check name in a code span, so markdown links, HTML and `owner/repo#1` cross-references stay literal text. */
export declare const checkName: (s: string) => string;
//# sourceMappingURL=check-name.d.ts.map