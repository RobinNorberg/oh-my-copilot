/**
 * Root discovery for `--all-repos` (ledger-roots.ts): which repositories a
 * ledger lists, and every way a record is refused. A temp ledger dir only,
 * never the real one.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLedgerDir, EngineLedger, ledgerRepoId } from '../ledger.js';
import { checkPinnedRoot, discoverLedgerRoots, probeRoot } from '../ledger-roots.js';

let dir: string;
let ledgerDir: string;

beforeEach(() => {
  // The real path: a short (8.3) or linked temp dir would read as "reached through a link".
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'omg-roots-')));
  ledgerDir = join(dir, 'ledger');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function repo(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  return root;
}

/** A ledger record as the engine writes one (EngineLedger.record persists it). */
function record(root: string, key = 1): void {
  EngineLedger.open(ledgerDir, root, key).record(join(root, '.omg', 'state', 'factory', `run-${key}.json`), null);
}

/** A record written by hand into `id`'s dir (a forged or copied one). */
function forged(id: string, root: unknown, key = 1, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(ledgerDir, id), { recursive: true });
  writeFileSync(join(ledgerDir, id, `run-${key}.json`), JSON.stringify({ version: 1, root, issue: key, files: {}, baselines: {}, ...extra }));
}

function snapshot(path: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
    else out.push(`${p}:${st.size}:${st.mtimeMs}:${readFileSync(p).toString('base64')}`);
  };
  walk(path);
  return out;
}

describe('discoverLedgerRoots', () => {
  it('lists every recorded repository with its ledger id', async () => {
    const a = repo('alpha');
    const b = repo('beta');
    record(a, 1);
    record(a, 2);
    record(b, 7);
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots).toEqual([
      { id: ledgerRepoId(a), root: a, source: 'ledger', recorded: true, stateRoot: join(a, '.omg') },
      { id: ledgerRepoId(b), root: b, source: 'ledger', recorded: true, stateRoot: join(b, '.omg') },
    ]);
    expect(got.skipped).toEqual([]);
    expect(got.warnings).toEqual([]);
  });

  it('refuses a record whose dir name is not the id the engine derives from its root (copied or forged)', async () => {
    const a = repo('alpha');
    record(a);
    forged('0123456789abcdef', a);
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots.map((r) => r.root)).toEqual([a]);
    expect(got.skipped).toEqual([{ id: '0123456789abcdef', reason: 'id-mismatch', root: a }]);
  });

  it('refuses a subdirectory of a repository, a plain folder and a missing root; a missing one is counted, not an error', async () => {
    const a = repo('alpha');
    const sub = join(a, 'packages', 'x');
    mkdirSync(sub, { recursive: true });
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const gone = join(dir, 'deleted-fixture');
    for (const r of [sub, plain, gone]) forged(ledgerRepoId(r), r);
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    forged(ledgerRepoId(file), file);
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots).toEqual([]);
    const why = Object.fromEntries(got.skipped.map((s) => [s.root, s.reason]));
    expect(why).toEqual({ [sub]: 'not-a-repository', [plain]: 'not-a-repository', [gone]: 'missing', [file]: 'not-a-directory' });
  });

  it('accepts a linked worktree or submodule (.git is a gitdir: file) and refuses a .git file that is not one', async () => {
    const wt = join(dir, 'wt');
    mkdirSync(wt);
    // A worktree-shaped pointer (its target holds HEAD) is a root; a dangling one is not (M1).
    mkdirSync(join(dir, 'main.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(dir, 'main.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${join(dir, 'main.git', 'worktrees', 'wt')}\n`);
    const gone = join(dir, 'gone-wt');
    mkdirSync(gone);
    writeFileSync(join(gone, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const fake = join(dir, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, '.git'), 'not a pointer');
    forged(ledgerRepoId(wt), wt);
    forged(ledgerRepoId(gone), gone);
    forged(ledgerRepoId(fake), fake);
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots.map((r) => r.root)).toEqual([wt]);
    expect(got.skipped.sort((x, y) => x.root!.localeCompare(y.root!))).toEqual([
      { id: ledgerRepoId(fake), reason: 'not-a-repository', root: fake },
      { id: ledgerRepoId(gone), reason: 'not-a-repository', root: gone },
    ]);
  });

  it('refuses a root reached through a junction or symlink (its real path is another directory)', async () => {
    const a = repo('alpha');
    const link = join(dir, 'link-to-alpha');
    symlinkSync(a, link, process.platform === 'win32' ? 'junction' : 'dir');
    forged(ledgerRepoId(link), link);
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots).toEqual([]);
    expect(got.skipped).toEqual([{ id: ledgerRepoId(link), reason: 'link', root: link }]);
  });

  it('dedupes roots that differ only in case where the filesystem folds case (one ledger id; a claim adds nothing)', async () => {
    const a = repo('Alpha');
    record(a);
    const upper = a.toUpperCase();
    mkdirSync(join(ledgerDir, 'claims', 'aaaaaaaaaaaaaaaa'), { recursive: true });
    writeFileSync(join(ledgerDir, 'claims', 'aaaaaaaaaaaaaaaa', 'run-3.owner'), JSON.stringify({ hostname: 'h', run: '3', root: upper, parkedAt: '2026-11-20T00:00:00.000Z' }));
    const got = await discoverLedgerRoots({ ledgerDir });
    // The engine's id lower-cases the root, so both spellings name one ledger dir on every platform.
    expect(ledgerRepoId(upper)).toBe(ledgerRepoId(a));
    expect(got.roots).toEqual([{ id: ledgerRepoId(a), root: a, source: 'ledger', recorded: true, stateRoot: join(a, '.omg') }]);
  });

  it('skips a malformed or unreadable record with a fixed warning, never failing', async () => {
    const a = repo('alpha');
    record(a);
    const bad = join(dir, 'bad');
    mkdirSync(join(ledgerDir, ledgerRepoId(bad)), { recursive: true });
    writeFileSync(join(ledgerDir, ledgerRepoId(bad), 'run-1.json'), '{not json');
    forged(ledgerRepoId(join(dir, 'wrong-issue')), join(dir, 'wrong-issue'), 2, { issue: 9 });
    forged(ledgerRepoId(join(dir, 'v2')), join(dir, 'v2'), 1, { version: 2 });
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots.map((r) => r.root)).toEqual([a]);
    expect(got.skipped.map((s) => s.reason).sort()).toEqual(['unreadable', 'unreadable', 'unreadable']);
    expect(got.warnings).toHaveLength(3);
    // Fixed text: no parser message and no path.
    for (const w of got.warnings) {
      expect(w).toMatch(/^engine ledger dir [0-9a-f]{16}: none of its first 1 run record\(s\) is a readable engine record; skipped$/);
    }
  });

  it('a dir with heal seals only (no run record) names no root and is not counted', async () => {
    mkdirSync(join(ledgerDir, '00000000000000aa', 'heal'), { recursive: true });
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got).toEqual({ roots: [], skipped: [], warnings: [] });
  });

  it('caps the repository dirs it reads', async () => {
    for (const n of ['r1', 'r2', 'r3']) record(repo(n));
    const got = await discoverLedgerRoots({ ledgerDir, maxRepos: 2 });
    expect(got.roots).toHaveLength(2);
    expect(got.warnings).toEqual(['the engine ledger has 3 repository dirs; only the first 2 were read']);
  });

  it('adds a claim owner\'s root when its ledger dir is gone, validated like the others', async () => {
    const c = repo('gamma');
    const claims = join(ledgerDir, 'claims', 'bbbbbbbbbbbbbbbb');
    mkdirSync(claims, { recursive: true });
    writeFileSync(join(claims, 'run-4.owner'), JSON.stringify({ hostname: 'h', run: '4', root: c, parkedAt: '2026-11-20T00:00:00.000Z' }));
    writeFileSync(join(claims, 'run-5.owner'), JSON.stringify({ hostname: 'h', run: '5', root: join(dir, 'gone'), parkedAt: '2026-11-20T00:00:00.000Z' }));
    writeFileSync(join(claims, 'run-6.owner'), 'garbage');
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots).toEqual([{ id: ledgerRepoId(c), root: c, source: 'claim', recorded: false, stateRoot: join(c, '.omg') }]);
    expect(got.skipped).toEqual([{ id: ledgerRepoId(join(dir, 'gone')), reason: 'missing', root: join(dir, 'gone') }]);
  });

  it('rejects hostile root strings in forged records before any probe; a hostile but real directory keeps its exact name', async () => {
    const hostile = ['C:\\x\n; rm -rf /', '/tmp/a\u0007b', 'relative/path', '\\\\server\\share\\repo', '/tmp/../tmp/x', '', 42, null];
    hostile.forEach((r, i) => forged(`ff00000000000${String(i).padStart(3, '0')}`, r));
    const got = await discoverLedgerRoots({ ledgerDir });
    expect(got.roots).toEqual([]);
    expect(new Set(got.skipped.map((s) => s.reason))).toEqual(new Set(['invalid-root']));
    // A skipped root is kept only as sanitised text (no control character survives).
    for (const s of got.skipped) if (s.root !== undefined) expect(s.root).not.toMatch(/[\u0000-\u001f]/);
  });

  it('pins the set with --repo: a recorded root keeps its record, an unrecorded one is listed as such', async () => {
    const a = repo('alpha');
    const b = repo('beta');
    const c = repo('gamma');
    record(a);
    record(b);
    const got = await discoverLedgerRoots({ ledgerDir, pinned: [b, c, b] });
    expect(got.roots).toEqual([
      { id: ledgerRepoId(b), root: b, source: 'ledger', recorded: true, stateRoot: join(b, '.omg') },
      { id: ledgerRepoId(c), root: c, source: 'pinned', recorded: false },
    ]);
    expect(await checkPinnedRoot(join(a, '.git'))).toEqual({ error: expect.stringMatching(/is not a repository top level/) as unknown as string });
    expect(await checkPinnedRoot(a)).toEqual({ root: a });
  });

  it('honours OMC_STATE_DIR exactly as the engine does', () => {
    vi.stubEnv('OMC_STATE_DIR', join(dir, 'state'));
    expect(defaultLedgerDir()).toBe(join(dir, 'state', 'factory-ledger'));
    vi.stubEnv('OMC_STATE_DIR', '  ');
    expect(defaultLedgerDir().endsWith(join('.omg', 'factory-ledger'))).toBe(true);
  });

  it('probes a root without following it anywhere', async () => {
    const a = repo('alpha');
    expect(await probeRoot(a)).toEqual({ real: expect.any(String) as unknown as string, stateRoot: join(a, '.omg') });
    expect(await probeRoot(join(dir, 'nope'))).toEqual({ reason: 'missing' });
  });

  it('writes nothing: the ledger and the repositories are byte- and mtime-identical afterwards', async () => {
    const a = repo('alpha');
    record(a);
    forged('0123456789abcdef', a);
    const before = [...snapshot(ledgerDir), ...snapshot(a)];
    await discoverLedgerRoots({ ledgerDir });
    await discoverLedgerRoots({ ledgerDir, pinned: [a] });
    expect([...snapshot(ledgerDir), ...snapshot(a)]).toEqual(before);
  });
});

describe('the state a listed root is read from is its own (M1)', () => {
  it('an empty .git dir, a dangling gitdir file, and a gitdir that is no git dir are not repositories', async () => {
    const empty = join(dir, 'empty');
    mkdirSync(join(empty, '.git'), { recursive: true });
    expect(await probeRoot(empty)).toEqual({ reason: 'not-a-repository' });
    const dangling = join(dir, 'dangling');
    mkdirSync(dangling);
    writeFileSync(join(dangling, '.git'), `gitdir: ${join(dir, 'nowhere')}\n`);
    expect(await probeRoot(dangling)).toEqual({ reason: 'not-a-repository' });
    const plainTarget = join(dir, 'plain-target');
    mkdirSync(plainTarget);
    const pointer = join(dir, 'pointer');
    mkdirSync(pointer);
    writeFileSync(join(pointer, '.git'), `gitdir: ${plainTarget}\n`);
    expect(await probeRoot(pointer)).toEqual({ reason: 'not-a-repository' });
    // Discovery refuses them too, with the reason.
    for (const r of [empty, dangling]) forged(ledgerRepoId(r), r);
    const found = await discoverLedgerRoots({ ledgerDir });
    expect(found.roots).toEqual([]);
    expect(found.skipped.map((s) => s.reason).sort()).toEqual(['not-a-repository', 'not-a-repository']);
  });

  it('a normal repository and a linked worktree are roots with their own .omg; a separate git dir too', async () => {
    const main = repo('main');
    execFileSync('git', ['-C', main, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = join(dir, 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', wt]);
    const sep = join(dir, 'sep');
    execFileSync('git', ['init', '-q', '--separate-git-dir', join(dir, 'sep.git'), sep]);
    for (const r of [main, wt, sep]) expect(await probeRoot(r)).toMatchObject({ stateRoot: join(r, '.omg') });
    // The git-free state root is the one getOmcRoot (git-based) resolves.
    const { getOmcRoot } = await import('../../../lib/worktree-paths.js');
    for (const r of [main, wt, sep]) expect(getOmcRoot(r)).toBe(join(r, '.omg'));
  });

  it('a submodule-shaped root (listed in the enclosing repository\'s .gitmodules) and a root under a workspace marker are state-elsewhere', async () => {
    const sup = repo('super');
    const sub = join(sup, 'libs', 'sub');
    mkdirSync(join(sup, '.git', 'modules', 'sub'), { recursive: true });
    writeFileSync(join(sup, '.git', 'modules', 'sub', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ../../.git/modules/sub\n`);
    writeFileSync(join(sup, '.gitmodules'), '[submodule "sub"]\n\tpath = libs/sub\n\turl = https://example.invalid/sub\n');
    expect(await probeRoot(sub)).toEqual({ reason: 'state-elsewhere' });
    // Nested in a repository that does not list it: its own state.
    const nested = join(sup, 'vendor', 'clone');
    mkdirSync(join(sup, 'vendor'));
    execFileSync('git', ['init', '-q', nested]);
    expect(await probeRoot(nested)).toMatchObject({ stateRoot: join(nested, '.omg') });
    // A workspace marker above the root anchors a shared .omg there.
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    writeFileSync(join(ws, '.omc-workspace'), '{}');
    const inWs = join(ws, 'member');
    mkdirSync(inWs);
    execFileSync('git', ['init', '-q', inWs]);
    expect(await probeRoot(inWs)).toEqual({ reason: 'state-elsewhere' });
  });

  it('no stateRoot with OMC_STATE_DIR (the centralized id is resolved the usual way)', async () => {
    const a = repo('a');
    vi.stubEnv('OMC_STATE_DIR', join(dir, 'central'));
    expect(await probeRoot(a)).toEqual({ real: expect.any(String) });
  });
});

describe('records in one ledger dir must agree (L4)', () => {
  it('a dir whose records name different roots is skipped (conflict), whatever the order', async () => {
    const a = repo('a');
    record(a, 1);
    record(a, 2);
    expect((await discoverLedgerRoots({ ledgerDir })).roots.map((r) => r.root)).toEqual([a]);
    // A second record in a's dir that fails the id check (another root): the dir is skipped, not decided by the first record.
    forged(ledgerRepoId(a), repo('b'), 3);
    const found = await discoverLedgerRoots({ ledgerDir });
    expect(found.roots).toEqual([]);
    expect(found.skipped).toEqual([expect.objectContaining({ id: ledgerRepoId(a), reason: 'id-mismatch' })]);
  });
});

describe('records in one ledger dir that pass the id check but disagree', () => {
  it('two spellings that fold to one id on a case-sensitive host are a conflict; a case variant on win32 is not', async () => {
    const a = repo('a');
    record(a, 1);
    record(a, 2);
    forged(ledgerRepoId(a), a.toUpperCase() === a ? a : a.replace(/a$/, 'A'), 3);
    const found = await discoverLedgerRoots({ ledgerDir });
    if (process.platform === 'win32' || process.platform === 'darwin') expect(found.roots.map((r) => r.root.toLowerCase())).toEqual([a.toLowerCase()]);
    else {
      expect(found.roots).toEqual([]);
      expect(found.skipped).toEqual([expect.objectContaining({ reason: 'conflict' })]);
      expect(found.warnings.some((w) => w.includes('name different roots'))).toBe(true);
    }
  });
});
