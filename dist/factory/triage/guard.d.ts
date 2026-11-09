/**
 * `omg factory triage --apply`'s GitHub write shape (the guard clause in
 * src/factory/run/exec.ts calls triageWriteGh):
 *
 *   issue edit <n> --repo <repo> (--add-label <l>)* (--remove-label <l>)*
 *
 * at least one flag, adds before removes, every label used once and named on
 * the write context's allowlist (the labels of the printed plan), plain
 * visible text, never a `factory:` or `harbor:` label. A title or body is
 * untrusted tracker text: it can only reach a label by being on the plan's
 * allowlist, and the plan names only the taxonomy's own labels (rules.ts).
 * Leaf module: it imports nothing from the guard, so exec.ts can import it.
 */
/** One triage label: plain text, no space or comma, no leading `-` (it would read as a flag). */
export declare const TRIAGE_LABEL: RegExp;
/** At most this many label flags on one write (an added priority, the other three removed, needs-split and needs-plan). */
export declare const MAX_TRIAGE_FLAGS = 6;
export declare const isTriageLabelName: (s: unknown) => s is string;
/**
 * true/false for a triage edit (`issue edit <n> --repo ... --add-label|--remove-label ...`);
 * null for every other shape, so the enqueue and engine shapes still decide those.
 */
export declare function triageWriteGh(a: string[], ctx: {
    repo: string;
    labels: readonly string[];
}): boolean | null;
/** `label list --repo <repo> --search <name> --json name --limit <n>`: triage's own GitHub label lookup (a read). */
export declare function triageLabelListGh(a: readonly string[], repo: string): boolean;
//# sourceMappingURL=guard.d.ts.map