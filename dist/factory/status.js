/**
 * Factory chain audit view (D2): a read-only summary of what the chain did in
 * this project. Everything here reads the same durable artifacts the runtime
 * writes — the decisions trail, stop markers, link ledgers, the authoritative
 * route table — so the view can never disagree with the state the chain left
 * behind. Pure reads; no locking, no writes.
 */
import * as fs from 'fs';
import { join } from 'path';
import { detectStalledLinks } from './watchdog.js';
import { factoryStateDir, readProjectRoutes } from '../hooks/session-end/chain-enqueuer.js';
function intentSummary(map, intentId) {
    const existing = map.get(intentId);
    if (existing)
        return existing;
    const created = { intentId, decisionCount: 0, counts: {}, links: [] };
    map.set(intentId, created);
    return created;
}
function readDecisions(factoryDir, intents) {
    try {
        for (const line of fs.readFileSync(join(factoryDir, 'chain-decisions.jsonl'), 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (typeof record.intentId !== 'string' || typeof record.decision !== 'string')
                continue;
            const summary = intentSummary(intents, record.intentId);
            summary.decisionCount += 1;
            summary.counts[record.decision] = (summary.counts[record.decision] ?? 0) + 1;
            if (typeof record.at === 'string' && (summary.lastDecisionAt === undefined || record.at > summary.lastDecisionAt)) {
                summary.lastDecision = record.decision;
                summary.lastDecisionAt = record.at;
            }
        }
    }
    catch {
        // no decisions trail yet
    }
}
function readStopMarkers(factoryDir, intents) {
    let entries;
    try {
        entries = fs.readdirSync(factoryDir);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const match = /^chain-(.+)\.stopped\.json$/.exec(entry);
        if (!match)
            continue;
        let marker;
        try {
            marker = JSON.parse(fs.readFileSync(join(factoryDir, entry), 'utf8'));
        }
        catch {
            continue;
        }
        const summary = intentSummary(intents, match[1]);
        summary.stopped = {
            reason: typeof marker.reason === 'string' ? marker.reason : 'unknown',
            stoppedAt: typeof marker.stoppedAt === 'string' ? marker.stoppedAt : '',
        };
    }
}
const optionalString = (value) => (typeof value === 'string' && value ? value : undefined);
/**
 * Group link ledgers into their intents, in spawn order (createdAt, then file
 * mtime for ledgers that predate it). Returns the count of open ledgers.
 */
function readLinkLedgers(factoryDir, intents) {
    let entries;
    try {
        entries = fs.readdirSync(factoryDir);
    }
    catch {
        return 0;
    }
    let open = 0;
    const sortKeys = new Map();
    for (const entry of entries) {
        const match = /^chain-([0-9a-f-]+)\.json$/i.exec(entry);
        if (!match)
            continue;
        let ledger;
        let mtime = '';
        try {
            const parsed = JSON.parse(fs.readFileSync(join(factoryDir, entry), 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                continue;
            ledger = parsed;
            mtime = fs.statSync(join(factoryDir, entry)).mtime.toISOString();
        }
        catch {
            continue;
        }
        const link = { chainLink: match[1], stage: optionalString(ledger.stage) ?? 'unknown' };
        for (const key of ['host', 'parentLink', 'createdAt', 'closedAt', 'hostSessionId', 'outcome', 'decision']) {
            const value = optionalString(ledger[key]);
            if (value !== undefined)
                link[key] = value;
        }
        if (!link.closedAt)
            open += 1;
        sortKeys.set(link, link.createdAt ?? mtime);
        intentSummary(intents, optionalString(ledger.intentId) ?? `chain-${match[1]}`).links.push(link);
    }
    for (const intent of intents.values()) {
        intent.links.sort((a, b) => (sortKeys.get(a) ?? '').localeCompare(sortKeys.get(b) ?? ''));
    }
    return open;
}
export function readChainStatus(directory, now) {
    const factoryDir = factoryStateDir(directory);
    const intents = new Map();
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
//# sourceMappingURL=status.js.map