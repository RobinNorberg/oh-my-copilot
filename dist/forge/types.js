/**
 * The forge layer (factory forges design §1-§2): one `Forge` per repository
 * host, built from the caller's already-guarded Exec. Adapters never spawn;
 * src/forge/__tests__/no-spawn.test.ts holds that. Normalized shapes reuse
 * the ship ones, so the GitHub adapter returns exactly what the ship parsers
 * return today.
 */
export const PROGRESS_STAGES = ['queued', 'building', 'reviewing', 'verifying', 'ready-to-merge', 'done', 'blocked', 'cancelled'];
//# sourceMappingURL=types.js.map