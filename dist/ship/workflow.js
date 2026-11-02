/**
 * A tight reader for this repo's GitHub Actions workflow files: job keys,
 * names, conditions and matrix axes, and the check names GitHub reports for
 * them. Used by the requiredChecks drift test and by the aggregator
 * (CI Gate) cross-check in gates.ts, which maps the job keys CI Gate names to
 * their checks.
 */
/** The workflow whose aggregator lines (CI Gate, the Test summary) gates.ts recognizes. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
const stripExpr = (s) => unquote(s).replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
/**
 * Tight parser for the subset these workflow files use: block-style `on:`
 * keys at 2 spaces with an optional `branches: [a, b]` flow list at 4, jobs
 * at 2 spaces under `jobs:`, `name:` / `if:` at 4, and
 * `strategy: matrix: <key>: [a, b]` flow lists at 8.
 */
export function parseWorkflow(text) {
    const triggers = [];
    const branches = {};
    const jobs = [];
    let section = null;
    let job = null;
    let inMatrix = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^\S/.test(line)) {
            section = line.startsWith('on:') ? 'on' : line.startsWith('jobs:') ? 'jobs' : null;
            job = null;
            continue;
        }
        if (section === 'on') {
            const m = /^ {2}([a-z_]+):/.exec(line);
            if (m)
                triggers.push(m[1]);
            const filter = /^ {4}branches:\s*\[(.*)\]\s*$/.exec(line);
            if (filter && triggers.length > 0)
                branches[triggers[triggers.length - 1]] = filter[1].split(',').map(unquote).filter(Boolean);
            continue;
        }
        if (section !== 'jobs')
            continue;
        const jobKey = /^ {2}([\w-]+):\s*$/.exec(line);
        if (jobKey) {
            job = { key: jobKey[1], matrix: {} };
            jobs.push(job);
            inMatrix = false;
            continue;
        }
        if (!job)
            continue;
        const prop = /^ {4}(name|if):\s*(.+)$/.exec(line);
        if (prop) {
            job[prop[1]] = prop[1] === 'if' ? stripExpr(prop[2]) : unquote(prop[2]);
            continue;
        }
        if (/^ {4}\S/.test(line))
            inMatrix = false;
        if (/^ {6}matrix:\s*$/.test(line)) {
            inMatrix = true;
            continue;
        }
        const axis = inMatrix ? /^ {8}([\w-]+):\s*\[(.*)\]\s*$/.exec(line) : null;
        if (axis)
            job.matrix[axis[1]] = axis[2].split(',').map(unquote).filter(Boolean);
    }
    return { triggers, branches, jobs };
}
/** GitHub's check names: `${{ matrix.x }}` substituted, else ` (<values>)` appended per combination. */
export function checkNames(job) {
    const base = job.name ?? job.key;
    const axes = Object.entries(job.matrix);
    if (axes.length === 0)
        return [base];
    let combos = [{}];
    for (const [axisKey, values] of axes)
        combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axisKey]: v })));
    return combos.map((combo) => {
        const substituted = base.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_m, k) => combo[k] ?? '');
        return substituted !== base ? substituted : `${base} (${Object.values(combo).join(', ')})`;
    });
}
/** Job key -> the check names it reports (`test-shards` -> `Test shard 1 of 4` ... `Test shard 4 of 4`). */
export function jobCheckNames(text) {
    return new Map(parseWorkflow(text).jobs.map((j) => [j.key, checkNames(j)]));
}
//# sourceMappingURL=workflow.js.map