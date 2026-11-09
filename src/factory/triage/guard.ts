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
export const TRIAGE_LABEL = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,48}$/;
const RESERVED = /^(?:factory|harbor):/i;
const NUMBER = /^[1-9]\d{0,9}$/;
/** At most this many label flags on one write (an added priority, the other three removed, needs-split and needs-plan). */
export const MAX_TRIAGE_FLAGS = 6;

export const isTriageLabelName = (s: unknown): s is string => typeof s === 'string' && TRIAGE_LABEL.test(s) && !RESERVED.test(s);

/**
 * true/false for a triage edit (`issue edit <n> --repo ... --add-label|--remove-label ...`);
 * null for every other shape, so the enqueue and engine shapes still decide those.
 */
export function triageWriteGh(a: string[], ctx: { repo: string; labels: readonly string[] }): boolean | null {
  if (a[0] !== 'issue' || a[1] !== 'edit' || a[3] !== '--repo' || (a[5] !== '--add-label' && a[5] !== '--remove-label')) return null;
  if (!NUMBER.test(a[2] ?? '') || a[4] !== ctx.repo) return false;
  const flags = a.slice(5);
  if (flags.length % 2 !== 0 || flags.length / 2 > MAX_TRIAGE_FLAGS) return false;
  const seen: string[] = [];
  let removing = false;
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === '--remove-label') removing = true;
    else if (flags[i] !== '--add-label' || removing) return false;
    const label = flags[i + 1];
    if (!isTriageLabelName(label) || !ctx.labels.includes(label) || seen.includes(label.toLowerCase())) return false;
    seen.push(label.toLowerCase());
  }
  return true;
}
