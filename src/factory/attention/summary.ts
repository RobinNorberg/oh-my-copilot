/**
 * A cheap "what needs me" count for surfaces that ask often (the HUD
 * `factory` element): counts per group, the worst non-empty group, the live
 * engines and the total. It is derived from collectAttention's items, so the
 * trust rules are the same ones: an unverified state counts under Inspect,
 * nothing from a state's free text is in it.
 *
 * Cache: in memory only, per (root, ledger dir), keyed by the modification
 * time and size of the directories whose entries change when the engine
 * writes (the state dir, its heal/ and slots/ dirs, this repository's engine
 * ledger dir and heal ledger dir) and of the tamper hold, and at most
 * SUMMARY_TTL_MS old (owner liveness and ages change without a write). No
 * cache file: a file would be one more thing a lane could plant counts in,
 * and every engine write is an atomic rename, which changes its directory's
 * mtime. A process that renders once (the statusline command) pays one
 * collect per render; a long-lived one (`omg hud --watch`, the poll loop)
 * reuses it. A file rewritten in place (not by the engine) is seen once the
 * TTL ends.
 */

import { statSync } from 'fs';
import { dirname, join } from 'path';
import { healLedgerDir } from '../heal/run.js';
import { defaultLedgerDir, ledgerFilePath } from '../run/ledger.js';
import { tamperHoldPath } from '../run/tamper-quarantine.js';
import { defaultOwnerDeps, factoryStateDir, type OwnerDeps } from '../run/state.js';
import { ATTENTION_GROUPS, type AttentionGroup } from './actions.js';
import { collectAttention, type AttentionData } from './collect.js';

export interface AttentionSummary {
  total: number;
  byGroup: Record<AttentionGroup, number>;
  /** The first non-empty group in ATTENTION_GROUPS order (Inspect first); null when nothing needs the human. */
  worst: AttentionGroup | null;
  /** Live engines in this repository (as collectAttention counts them). */
  engines: number;
}

export const SUMMARY_TTL_MS = 5_000;
const CACHE_MAX = 32;

export interface AttentionSummaryOptions {
  ledgerDir?: string;
  now?: () => number;
  /**
   * Default: this host's owner deps WITHOUT the start-identity check, which
   * spawns a process per live engine on Windows and macOS (too slow for a
   * status line). A reused pid can then make a dead engine count as live
   * here until `omg factory attention` (which checks it) runs.
   */
  owner?: OwnerDeps;
  ttlMs?: number;
}

export function summarizeAttention(d: AttentionData): AttentionSummary {
  const byGroup = { ...d.summary.byGroup };
  return { total: d.items.length, byGroup, worst: ATTENTION_GROUPS.find((g) => byGroup[g] > 0) ?? null, engines: d.summary.engines.live };
}

const cache = new Map<string, { key: string; at: number; value: AttentionSummary }>();

/** Drops every cached summary (tests). */
export function clearAttentionSummaryCache(): void {
  cache.clear();
}

function stamp(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch {
    return '-';
  }
}

export function attentionSummary(root: string, o: AttentionSummaryOptions = {}): AttentionSummary {
  const ledgerDir = o.ledgerDir ?? defaultLedgerDir();
  const now = (o.now ?? Date.now)();
  const ttl = o.ttlMs ?? SUMMARY_TTL_MS;
  const stateDir = factoryStateDir(root);
  const key = [stateDir, join(stateDir, 'heal'), join(stateDir, 'slots'), dirname(ledgerFilePath(ledgerDir, root, 1)), healLedgerDir(ledgerDir, root), tamperHoldPath(ledgerDir, root)].map(stamp).join('|');
  const slot = `${root}\0${ledgerDir}`;
  const hit = cache.get(slot);
  if (hit && hit.key === key && now >= hit.at && now - hit.at < ttl) return { ...hit.value, byGroup: { ...hit.value.byGroup } };
  const { identityOf: _identity, ...owner } = defaultOwnerDeps();
  const value = summarizeAttention(collectAttention(root, { ledgerDir, now: () => now, owner: o.owner ?? owner }));
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(slot, { key, at: now, value });
  return { ...value, byGroup: { ...value.byGroup } };
}
