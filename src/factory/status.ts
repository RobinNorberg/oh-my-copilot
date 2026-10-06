/**
 * Factory chain audit view (D2): a read-only summary of what the chain did in
 * this project. Everything here reads the same durable artifacts the runtime
 * writes — the decisions trail, stop markers, link ledgers, the authoritative
 * route table — so the view can never disagree with the state the chain left
 * behind. Pure reads; no locking, no writes.
 */

import * as fs from 'fs';
import { join } from 'path';
import { detectStalledLinks, type StalledLink } from './watchdog.js';
import { factoryStateDir, readProjectRoutes } from '../hooks/session-end/chain-enqueuer.js';

/** One link of a chain, from its ledger `chain-<chainLink>.json`. */
export interface ChainLinkSummary {
  chainLink: string;
  stage: string;
  /** Host binary that ran the link (absent on ledgers written before v5.7.1). */
  host?: string;
  parentLink?: string;
  createdAt?: string;
  /** Set once the link's SessionEnd consumed the ledger. */
  closedAt?: string;
  /** Host session that ended the link; differs from chainLink on Copilot. */
  hostSessionId?: string;
  outcome?: string;
  /** The enqueuer decision that closed the link. */
  decision?: string;
}

export interface ChainIntentSummary {
  intentId: string;
  decisionCount: number;
  /** decision name -> occurrences, e.g. { enqueued: 3, 'chain-terminal': 1 }. */
  counts: Record<string, number>;
  lastDecision?: string;
  /** ISO 8601, from the decision record. */
  lastDecisionAt?: string;
  stopped?: { reason: string; stoppedAt: string };
  /** The chain's links in spawn order (ledgers still on disk). */
  links: ChainLinkSummary[];
}

export interface ChainStatus {
  directory: string;
  /** Keys of the project route table (the single authority, upstream #4176). */
  routeKeys: string[];
  /** Link ledgers on disk that no SessionEnd has closed yet (running or stalled links). */
  activeLedgers: number;
  /** Most-recently-active first. */
  intents: ChainIntentSummary[];
  stalled: StalledLink[];
}

function intentSummary(map: Map<string, ChainIntentSummary>, intentId: string): ChainIntentSummary {
  const existing = map.get(intentId);
  if (existing) return existing;
  const created: ChainIntentSummary = { intentId, decisionCount: 0, counts: {}, links: [] };
  map.set(intentId, created);
  return created;
}

function readDecisions(factoryDir: string, intents: Map<string, ChainIntentSummary>): void {
  try {
    for (const line of fs.readFileSync(join(factoryDir, 'chain-decisions.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: { intentId?: unknown; decision?: unknown; at?: unknown };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (typeof record.intentId !== 'string' || typeof record.decision !== 'string') continue;
      const summary = intentSummary(intents, record.intentId);
      summary.decisionCount += 1;
      summary.counts[record.decision] = (summary.counts[record.decision] ?? 0) + 1;
      if (typeof record.at === 'string' && (summary.lastDecisionAt === undefined || record.at > summary.lastDecisionAt)) {
        summary.lastDecision = record.decision;
        summary.lastDecisionAt = record.at;
      }
    }
  } catch {
    // no decisions trail yet
  }
}

function readStopMarkers(factoryDir: string, intents: Map<string, ChainIntentSummary>): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(factoryDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^chain-(.+)\.stopped\.json$/.exec(entry);
    if (!match) continue;
    let marker: { reason?: unknown; stoppedAt?: unknown };
    try {
      marker = JSON.parse(fs.readFileSync(join(factoryDir, entry), 'utf8')) as typeof marker;
    } catch {
      continue;
    }
    const summary = intentSummary(intents, match[1]);
    summary.stopped = {
      reason: typeof marker.reason === 'string' ? marker.reason : 'unknown',
      stoppedAt: typeof marker.stoppedAt === 'string' ? marker.stoppedAt : '',
    };
  }
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Group link ledgers into their intents, in spawn order (createdAt, then file
 * mtime for ledgers that predate it). Returns the count of open ledgers.
 */
function readLinkLedgers(factoryDir: string, intents: Map<string, ChainIntentSummary>): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(factoryDir);
  } catch {
    return 0;
  }
  let open = 0;
  const sortKeys = new Map<ChainLinkSummary, string>();
  for (const entry of entries) {
    const match = /^chain-([0-9a-f-]+)\.json$/i.exec(entry);
    if (!match) continue;
    let ledger: Record<string, unknown>;
    let mtime = '';
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(join(factoryDir, entry), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      ledger = parsed as Record<string, unknown>;
      mtime = fs.statSync(join(factoryDir, entry)).mtime.toISOString();
    } catch {
      continue;
    }
    const link: ChainLinkSummary = { chainLink: match[1], stage: optionalString(ledger.stage) ?? 'unknown' };
    for (const key of ['host', 'parentLink', 'createdAt', 'closedAt', 'hostSessionId', 'outcome', 'decision'] as const) {
      const value = optionalString(ledger[key]);
      if (value !== undefined) link[key] = value;
    }
    if (!link.closedAt) open += 1;
    sortKeys.set(link, link.createdAt ?? mtime);
    intentSummary(intents, optionalString(ledger.intentId) ?? `chain-${match[1]}`).links.push(link);
  }
  for (const intent of intents.values()) {
    intent.links.sort((a, b) => (sortKeys.get(a) ?? '').localeCompare(sortKeys.get(b) ?? ''));
  }
  return open;
}

export function readChainStatus(directory: string, now?: Date): ChainStatus {
  const factoryDir = factoryStateDir(directory);
  const intents = new Map<string, ChainIntentSummary>();
  readDecisions(factoryDir, intents);
  readStopMarkers(factoryDir, intents);
  const activeLedgers = readLinkLedgers(factoryDir, intents);
  return {
    directory,
    routeKeys: Object.keys(readProjectRoutes(directory) ?? {}),
    activeLedgers,
    intents: [...intents.values()].sort((a, b) => (b.lastDecisionAt ?? '').localeCompare(a.lastDecisionAt ?? '')),
    stalled: detectStalledLinks(factoryDir, now ? { now } : {}),
  };
}
