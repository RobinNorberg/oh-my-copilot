/**
 * The forge layer (factory forges design §1-§2): one `Forge` per repository
 * host, built from the caller's already-guarded Exec. Adapters never spawn;
 * src/forge/__tests__/no-spawn.test.ts holds that. Normalized shapes reuse
 * the ship ones, so the GitHub adapter returns exactly what the ship parsers
 * return today.
 */
export const PROGRESS_STAGES = ['queued', 'building', 'reviewing', 'verifying', 'ready-to-merge', 'done', 'blocked', 'cancelled'];
/** The idempotency footer line enqueue renders (design §3.3). */
export const shipyardKeyLine = (spec, key) => `shipyard-key: ${spec}/${key}`;
/** The one GitHub search findByKey runs: the `shipyard-key: <spec>/` footer phrase in issue bodies. */
export const shipyardKeySearch = (spec) => `"shipyard-key: ${spec}/" in:body`;
/** The `shipyard-key:` footer lines of a body: `[spec, key]` per line, in order. The key is a C3 slug `[a-z0-9-]{3,60}`. */
export function shipyardKeys(body) {
    return [...body.matchAll(/^shipyard-key: (\d+)\/([a-z0-9-]{3,60})\r?$/gm)].map((m) => [Number(m[1]), m[2]]);
}
//# sourceMappingURL=types.js.map