/**
 * Windows executable search hardening (ESM runtime): re-exports
 * scripts/lib/windows-search.cjs so both module systems share one copy.
 * Source of truth: src/utils/windows-search.ts.
 */

export { hardenWindowsExeSearch, childEnv } from './windows-search.cjs';
