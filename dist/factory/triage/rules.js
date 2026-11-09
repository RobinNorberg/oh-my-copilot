/**
 * `omg factory triage` rules (pure): the labels and priority each item should
 * carry, from the item and its `omg factory check` result (read-only import
 * of the check rules). Taxonomy: priority:p0..p3 (mutually exclusive),
 * needs-split, needs-plan. owner:<x> comes with routing and is not proposed yet.
 */
import { isTriageLabelName } from './guard.js';
export const PRIORITY_LABELS = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'];
const PRIORITY_RE = /^priority:p([0-3])$/i;
export const DEFAULT_TRIAGE_CONFIG = { needsSplit: 'needs-split', needsPlan: 'needs-plan', sizeSplitAt: 5, defaultPriority: 2 };
export class TriageConfigError extends Error {
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * `factory.triage` from the trusted layers only (user config, then the base
 * branch's committed config; the working-tree project config never names a
 * label the write guard will allow). Later layers override earlier ones.
 */
export function resolveTriageConfig(layers) {
    const cfg = { ...DEFAULT_TRIAGE_CONFIG };
    for (const layer of layers) {
        const block = layer?.factory?.triage;
        if (block === undefined || block === null)
            continue;
        if (!isObject(block))
            throw new TriageConfigError('factory.triage must be an object');
        for (const key of Object.keys(block)) {
            if (!['labels', 'sizeSplitAt', 'defaultPriority'].includes(key))
                throw new TriageConfigError(`factory.triage.${key} is not a triage key (labels, sizeSplitAt, defaultPriority)`);
        }
        if (block.labels !== undefined) {
            if (!isObject(block.labels))
                throw new TriageConfigError('factory.triage.labels must be an object');
            for (const [key, value] of Object.entries(block.labels)) {
                if (key !== 'needsSplit' && key !== 'needsPlan')
                    throw new TriageConfigError(`factory.triage.labels.${key} is not renamable (needsSplit, needsPlan)`);
                if (!isTriageLabelName(value) || PRIORITY_RE.test(value))
                    throw new TriageConfigError(`factory.triage.labels.${key} must be a plain label name`);
                cfg[key] = value;
            }
        }
        if (block.sizeSplitAt !== undefined) {
            if (!Number.isInteger(block.sizeSplitAt) || block.sizeSplitAt < 1 || block.sizeSplitAt > 100)
                throw new TriageConfigError('factory.triage.sizeSplitAt must be an integer from 1 to 100');
            cfg.sizeSplitAt = block.sizeSplitAt;
        }
        if (block.defaultPriority !== undefined) {
            if (block.defaultPriority === false)
                cfg.defaultPriority = null;
            else if (Number.isInteger(block.defaultPriority) && block.defaultPriority >= 0 && block.defaultPriority <= 3)
                cfg.defaultPriority = block.defaultPriority;
            else
                throw new TriageConfigError('factory.triage.defaultPriority must be 0..3 or false');
        }
    }
    if (cfg.needsSplit.toLowerCase() === cfg.needsPlan.toLowerCase())
        throw new TriageConfigError('factory.triage.labels: needsSplit and needsPlan must differ');
    return cfg;
}
const SKIP_REASON = /^(?:closed|run-active|run-finished|pr-exists|branch-exists|merged|read-failed|wrong-type)/;
const has = (labels, name) => labels.find((l) => l.toLowerCase() === name.toLowerCase());
/** The proposal for one item. Pure: the printed plan and `--apply` both execute exactly this row. */
export function planItem(item, result, kind, cfg) {
    const taxonomy = [...PRIORITY_LABELS, cfg.needsSplit, cfg.needsPlan];
    const currentLabels = item.labels.filter((l) => taxonomy.some((t) => t.toLowerCase() === l.toLowerCase()));
    const base = {
        id: item.id, title: result.title, url: result.url, action: 'unchanged', skipReason: null, bucket: result.bucket, reasons: result.reasons,
        current: { labels: currentLabels, priority: result.priority }, add: [], remove: [], priority: null, why: [],
    };
    const reason = result.reasons[0] ?? '';
    if (SKIP_REASON.test(reason))
        return { ...base, action: 'skip', skipReason: reason };
    const { add, remove, why } = base;
    const want = (name, why1) => { if (!has(item.labels, name)) {
        add.push(name);
        why.push(why1);
    } };
    const drop = (name, why1) => { const own = has(item.labels, name); if (own) {
        remove.push(own);
        why.push(why1);
    } };
    // Priority: one label. The lowest p on the item wins; else the numeric field (ADO, local); else the default.
    const held = item.labels.map((l) => ({ l, m: PRIORITY_RE.exec(l) })).filter((x) => x.m !== null);
    let numeric = null;
    if (held.length > 0) {
        const target = Math.min(...held.map((x) => Number(x.m[1])));
        const keep = held.find((x) => Number(x.m[1]) === target).l;
        for (const x of held)
            if (x.l !== keep) {
                remove.push(x.l);
                why.push(`priority: keep ${keep}, drop ${x.l}`);
            }
        if (kind !== 'github' && item.priority !== target + 1) {
            numeric = target + 1;
            why.push(`priority field set to ${target + 1} to match ${keep}`);
        }
    }
    else if (item.priority === undefined && cfg.defaultPriority !== null) {
        const name = PRIORITY_LABELS[cfg.defaultPriority];
        want(name, `no priority: default ${name}`);
        if (kind !== 'github')
            numeric = cfg.defaultPriority + 1;
    }
    // Plan and split come from the check rules; a blocked item's plan is not evaluated, so it keeps its labels.
    const children = item.children.length;
    const wantSplit = children === 0 && (reason === 'needs-split' || reason === 'too-big' || (item.size !== undefined && item.size > cfg.sizeSplitAt));
    if (wantSplit)
        want(cfg.needsSplit, reason === 'needs-split' || reason === 'too-big' ? `check: ${reason}` : `size ${item.size} is above ${cfg.sizeSplitAt} and the item has no children`);
    else if (children > 0)
        drop(cfg.needsSplit, 'the item has children');
    else if (result.bucket === 'runnable')
        drop(cfg.needsSplit, 'check: runnable');
    if (result.bucket === 'needs-plan')
        want(cfg.needsPlan, `check: ${reason}`);
    else if (result.bucket === 'runnable')
        drop(cfg.needsPlan, 'check: runnable');
    const action = add.length > 0 || remove.length > 0 || numeric !== null ? 'change' : 'unchanged';
    return { ...base, priority: numeric, action, skipReason: null };
}
//# sourceMappingURL=rules.js.map