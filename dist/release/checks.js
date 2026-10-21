/**
 * Pure checks behind `omg release`: version order, release prose, version
 * stamps, dist orphans, vitest report diffs, smoke reports and tag targets.
 * No I/O beyond the `exists` callback, so each rule is tested directly.
 */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** `5.12.2` (a leading `v` is dropped); throws on anything but X.Y.Z. */
export function parseReleaseVersion(raw) {
    const v = raw.trim().replace(/^v/, '');
    if (!VERSION_RE.test(v))
        throw new Error(`version must be X.Y.Z, got ${JSON.stringify(raw)}`);
    return v;
}
/** Negative / 0 / positive like a sort comparator; both sides must be X.Y.Z. */
export function compareVersions(a, b) {
    const pa = parseReleaseVersion(a).split('.').map(Number);
    const pb = parseReleaseVersion(b).split('.').map(Number);
    for (let i = 0; i < 3; i++)
        if (pa[i] !== pb[i])
            return pa[i] - pb[i];
    return 0;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Problems with the release prose humans or agents write before a release:
 * CHANGELOG.md needs the `## [X.Y.Z]` section AND the `# <name> vX.Y.Z` H1
 * the tag-run boundary greps for; `.github/release-body.md` (the GitHub
 * Release body) must mention the version.
 */
export function releaseProseProblems(version, changelog, releaseBody) {
    const problems = [];
    const v = escapeRe(version);
    if (changelog === null)
        problems.push('CHANGELOG.md is missing');
    else {
        if (!new RegExp(`^## \\[${v}\\]`, 'm').test(changelog))
            problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
        if (!new RegExp(`^# .+ v${v}(?:[:\\s]|$)`, 'm').test(changelog))
            problems.push(`CHANGELOG.md has no "# oh-my-copilot v${version}" heading (the release boundary greps for it)`);
    }
    if (releaseBody === null || releaseBody.trim() === '')
        problems.push('.github/release-body.md is missing or empty');
    else if (!releaseBody.includes(version))
        problems.push(`.github/release-body.md does not mention ${version}`);
    return problems;
}
/**
 * Files and the version pattern each one carries; mirrors scripts/sync-version.sh plus the stamps it does not cover.
 * The plugin manifests carry one top-level "version" first, so only the first match is replaced (a nested one stays).
 */
export const VERSION_STAMPS = [
    { file: '.claude-plugin/plugin.json', pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
    { file: 'plugin.json', pattern: /"version": "[^"]*"/, replace: (v) => `"version": "${v}"` },
    { file: '.claude-plugin/marketplace.json', pattern: /"version": "[^"]*"/g, replace: (v) => `"version": "${v}"` },
    { file: 'docs/CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
    { file: 'CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
    { file: '.github/CLAUDE.md', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
    { file: 'tests/fixtures/prompt-projection/claude-managed-block.golden', pattern: /<!-- OMC:VERSION:[^ ]* -->/g, replace: (v) => `<!-- OMC:VERSION:${v} -->` },
    { file: '.github/upstream-port.json', pattern: /"fork_version": "[^"]*"/g, replace: (v) => `"fork_version": "${v}"` },
];
/** The stamped content, or null when the file carries no stamp (a silent no-op would ship a stale version). */
export function stampVersion(content, stamp, version) {
    const pattern = new RegExp(stamp.pattern.source, stamp.pattern.flags);
    if (!pattern.test(content))
        return null;
    return content.replace(new RegExp(stamp.pattern.source, stamp.pattern.flags), stamp.replace(version));
}
const DIST_OUTPUT = /^dist\/(.+?)\.(?:d\.ts\.map|d\.ts|js\.map|js)$/;
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];
/**
 * Tracked tsc outputs under dist/ whose source under src/ is gone (tsc never
 * deletes them, and the runtime-closure check fails on a stale module).
 * Other dist files (copied JSON, bundled .cjs) are not tsc outputs and are skipped.
 */
export function findDistOrphans(trackedDist, exists) {
    const orphans = [];
    for (const raw of trackedDist) {
        const file = raw.replace(/\\/g, '/');
        const m = DIST_OUTPUT.exec(file);
        if (!m)
            continue;
        if (!SOURCE_EXTS.some((ext) => exists(`src/${m[1]}${ext}`)))
            orphans.push(file);
    }
    return orphans;
}
const REPO_DIRS = /(?:^|\/)((?:src|tests|scripts|benchmark|bridge|skills|hooks)\/.+)$/;
/** Repo-relative forward-slash path of a test file from any checkout (`C:\x\src\a.test.ts` -> `src/a.test.ts`). */
export function repoRelativeTestPath(file) {
    const norm = file.replace(/\\/g, '/');
    return REPO_DIRS.exec(norm)?.[1] ?? norm;
}
/**
 * `<file> > <full title>` for every failed test in a vitest JSON report; a
 * file that failed with no failed test (a collection error) is listed as the
 * file alone.
 */
export function failingTitlesFromVitestJson(text) {
    const report = JSON.parse(text);
    if (!Array.isArray(report?.testResults))
        throw new Error('not a vitest JSON report (no testResults)');
    const out = new Set();
    for (const file of report.testResults) {
        const rel = repoRelativeTestPath(file.name ?? '');
        const failed = (file.assertionResults ?? []).filter((a) => a.status === 'failed');
        for (const a of failed)
            out.add(`${rel} > ${a.fullName ?? a.title ?? ''}`);
        if (failed.length === 0 && file.status === 'failed')
            out.add(rel);
    }
    return [...out].sort();
}
/** A baseline is a vitest JSON report or a text file with one `<file> > <title>` per line. */
export function parseBaselineTitles(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{'))
        return failingTitlesFromVitestJson(trimmed);
    return trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        .map((l) => {
        const [file, ...rest] = l.split(' > ');
        return rest.length > 0 ? `${repoRelativeTestPath(file)} > ${rest.join(' > ')}` : repoRelativeTestPath(file);
    });
}
/** Failing titles absent from the baseline (the suite gate fails only on these). */
export function newFailures(failing, baseline) {
    const known = new Set(baseline);
    return failing.filter((t) => !known.has(t));
}
/** Why a `smoke copilot --json` report is not a pass; empty = all checks passed. */
export function smokeProblems(stdout) {
    const start = stdout.indexOf('{');
    let report;
    try {
        report = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
    }
    catch {
        return ['smoke did not print a JSON report'];
    }
    const problems = [];
    if (typeof report.skipped === 'string' && report.skipped)
        problems.push(`smoke skipped: ${report.skipped}`);
    const checks = Array.isArray(report.checks) ? report.checks : [];
    if (checks.length === 0)
        problems.push('smoke reported no checks');
    for (const c of checks)
        if (c.ok !== true)
            problems.push(`${String(c.id)}: ${String(c.detail ?? 'failed')}`);
    if (report.ok !== true && problems.length === 0)
        problems.push('smoke report ok=false');
    return problems;
}
/**
 * The commit an annotated tag points at on the remote, from
 * `git ls-remote --tags <remote> refs/tags/<tag> 'refs/tags/<tag>^{}'`:
 * the peeled `^{}` line for an annotated tag, else the plain line
 * (lightweight). Null when the tag is absent.
 */
export function remoteTagTarget(lsRemote, tag) {
    let object;
    let peeled;
    for (const line of lsRemote.split(/\r?\n/)) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref === `refs/tags/${tag}`)
            object = sha;
        else if (ref === `refs/tags/${tag}^{}`)
            peeled = sha;
    }
    if (!object)
        return null;
    return { object, commit: peeled ?? object, annotated: peeled !== undefined };
}
/** Why a tag is not an annotated tag on `expected` (null = it is). */
export function tagTargetProblem(tag, objectType, peeled, expected) {
    if (objectType.trim() !== 'tag')
        return `${tag} is a ${objectType.trim() || 'missing'} object, not an annotated tag`;
    if (peeled.trim() !== expected)
        return `${tag}^{} is ${peeled.trim().slice(0, 12) || 'unresolved'}, not the main merge commit ${expected.slice(0, 12)}`;
    return null;
}
//# sourceMappingURL=checks.js.map