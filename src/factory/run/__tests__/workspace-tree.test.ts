import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GATE_TREE_MARKER, gateTreeHasLinks, linkNodeModules, trustedNestedRels, unlinkNodeModules } from '../prepare.js';
import { expandWorkspaceDirs, parseWorkspacePatterns, plainDirUnder, validWorkspaceRel, WORKSPACE_MAX_PACKAGES } from '../workspace-tree.js';

// L3 (review-501): a hook run right after plainDirUnder answers, to swap a dir for a junction in that window.
const swap = vi.hoisted(() => ({ after: null as null | ((base: string, rel: string, out: string | null) => void) }));
vi.mock('../workspace-tree.js', async (orig) => {
  const m = await orig<typeof import('../workspace-tree.js')>();
  return { ...m, plainDirUnder: (base: string, rel: string) => { const out = m.plainDirUnder(base, rel); swap.after?.(base, rel, out); return out; } };
});

const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const real = (p: string) => realpathSync.native(p);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omg-ws-'));
  dirs.push(d);
  return d;
}

function file(p: string, body = '{}\n'): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

/** A user checkout with packages/a, packages/b (and their package.json) and the same dirs in a gate checkout. */
function monorepo(): { dir: string; root: string; checkout: string } {
  const dir = tmp();
  const root = join(dir, 'root');
  const checkout = join(dir, 'checkout');
  for (const base of [root, checkout]) {
    file(join(base, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    file(join(base, 'packages', 'a', 'package.json'));
    file(join(base, 'packages', 'b', 'package.json'));
  }
  file(join(root, 'packages', 'a', 'index.js'), 'yours\n');
  file(join(checkout, 'packages', 'a', 'index.js'), 'gate\n');
  file(join(root, 'node_modules', 'typescript', 'package.json'));
  return { dir, root, checkout };
}

describe('workspace globs from the base', () => {
  it('reads npm and yarn package.json workspaces and pnpm-workspace.yaml (block and flow), comments dropped', () => {
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: ['packages/*', 'apps/web'] }), null)).toEqual(['packages/*', 'apps/web']);
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: { packages: ['libs/**'], nohoist: ['x'] } }), null)).toEqual(['libs/**']);
    expect(parseWorkspacePatterns(null, "packages:\n  # the apps\n  - 'apps/*'\n  - \"libs/**\" # deep\n  - '!**/test/**'\ncatalog:\n  x: 1\n")).toEqual(['apps/*', 'libs/**', '!**/test/**']);
    expect(parseWorkspacePatterns(null, "packages: ['a/*', \"b\"]\n")).toEqual(['a/*', 'b']);
    expect(parseWorkspacePatterns('not json', 'nothing: here\n')).toEqual([]);
    expect(parseWorkspacePatterns(JSON.stringify({ workspaces: [1, null, ' '] }), null)).toEqual([]);
  });

  it('validWorkspaceRel and plainDirUnder take exact relative shapes only', () => {
    for (const bad of ['', '/abs', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'C:/x', 'a/b/c/d/e/f/g', '.omg/w', 'a/.git', 'a/node_modules/b', 'Node_Modules/foo', 'node_modules./foo', 'NODE_M~1/foo', 'a /b', 'a./b', 'pack~1/a']) expect(validWorkspaceRel(bad)).toBe(false);
    expect(validWorkspaceRel('packages/a')).toBe(true);
    const dir = tmp();
    mkdirSync(join(dir, 'real', 'pkg'), { recursive: true });
    const outside = tmp();
    mkdirSync(join(outside, 'pkg'));
    symlinkSync(outside, join(dir, 'link'), linkType);
    expect(plainDirUnder(dir, 'real/pkg')).toBe(join(dir, 'real', 'pkg'));
    expect(plainDirUnder(dir, 'link/pkg')).toBeNull();
    expect(plainDirUnder(dir, '../x')).toBeNull();
  });

  it('expands globs to package dirs in your checkout: negations, ** bounded, links never followed, .. and absolute globs dropped', () => {
    const { root } = monorepo();
    file(join(root, 'packages', 'nested', 'deep', 'package.json'));
    file(join(root, 'packages', 'no-pkg', 'readme.md'), 'x');
    file(join(root, 'packages', 'a', 'node_modules', 'x', 'package.json'));
    const outside = tmp();
    file(join(outside, 'evil', 'package.json'));
    symlinkSync(join(outside, 'evil'), join(root, 'packages', 'linked'), linkType);
    const notes: string[] = [];
    const r = expandWorkspaceDirs(root, ['packages/*', 'packages/**', '!packages/b', '../outside/*', '/etc/*', 'C:/x'], (m) => notes.push(m));
    expect(r.problem).toBeNull();
    expect(r.dirs).toEqual(['packages/a', 'packages/nested/deep']);
    expect(notes.join('\n')).toMatch(/"\.\.\/outside\/\*" is ignored .*leaves the repository/);
    expect(notes.join('\n')).toMatch(/"\/etc\/\*" is ignored .*absolute/);
    expect(notes.join('\n')).toMatch(/"C:\/x" is ignored .*absolute/);
  });

  it('names Yarn PnP, a nested git repository and a layout over the bounds as the problem', () => {
    const pnp = monorepo();
    file(join(pnp.root, '.pnp.cjs'), '');
    expect(expandWorkspaceDirs(pnp.root, ['packages/*']).problem).toMatch(/Yarn Plug'n'Play .*\.pnp\.cjs.*nodeLinker: node-modules/);
    const git = monorepo();
    mkdirSync(join(git.root, 'packages', 'b', '.git'));
    expect(expandWorkspaceDirs(git.root, ['packages/*']).problem).toMatch(/packages\/b is a nested git repository/);
    const big = monorepo();
    for (let i = 0; i <= WORKSPACE_MAX_PACKAGES; i++) file(join(big.root, 'many', `p${i}`, 'package.json'));
    const over = expandWorkspaceDirs(big.root, ['many/*']);
    expect(over.problem).toMatch(new RegExp(`more than ${WORKSPACE_MAX_PACKAGES} workspace packages`));
    expect(over.dirs).toEqual([]);
  });
});

describe('the gate node_modules tree in a workspace', () => {
  it('npm: workspace self-links resolve to the gate checkout, nested node_modules get their own tree; removal leaves yours whole', () => {
    const { root, checkout } = monorepo();
    const nm = join(root, 'node_modules');
    // npm: `@scope/a -> ../../packages/a`, `b -> ../packages/b` (junctions with absolute targets on win32).
    mkdirSync(join(nm, '@scope'));
    file(join(nm, '@scope', 'tool', 'package.json'));
    symlinkSync(join(root, 'packages', 'a'), join(nm, '@scope', 'a'), linkType);
    symlinkSync(join(root, 'packages', 'b'), join(nm, 'b'), linkType);
    // A version conflict: packages/a has its own node_modules, with your vite cache in it.
    file(join(root, 'packages', 'a', 'node_modules', 'left-pad', 'package.json'), '{"version":"2"}');
    file(join(root, 'packages', 'a', 'node_modules', '.vite', 'old.json'), 'yours\n');
    expect(linkNodeModules(root, checkout, undefined, ['packages/*'])).toBeNull();

    const tree = join(checkout, 'node_modules');
    expect(lstatSync(join(tree, '@scope')).isSymbolicLink()).toBe(false);
    expect(real(join(tree, '@scope', 'a'))).toBe(real(join(checkout, 'packages', 'a')));
    expect(readFileSync(join(tree, '@scope', 'a', 'index.js'), 'utf-8')).toBe('gate\n');
    expect(real(join(tree, '@scope', 'tool'))).toBe(real(join(nm, '@scope', 'tool')));
    expect(real(join(tree, 'b'))).toBe(real(join(checkout, 'packages', 'b')));
    expect(real(join(tree, 'typescript'))).toBe(real(join(nm, 'typescript')));

    const nested = join(checkout, 'packages', 'a', 'node_modules');
    expect(lstatSync(nested).isSymbolicLink()).toBe(false);
    expect(real(join(nested, 'left-pad'))).toBe(real(join(root, 'packages', 'a', 'node_modules', 'left-pad')));
    expect(readdirSync(join(nested, '.vite'))).toEqual([]);
    writeFileSync(join(nested, '.vite', 'results.json'), '{}');
    expect(existsSync(join(root, 'packages', 'a', 'node_modules', '.vite', 'results.json'))).toBe(false);
    // packages/b has no node_modules of yours: none is made.
    expect(existsSync(join(checkout, 'packages', 'b', 'node_modules'))).toBe(false);
    expect(readFileSync(join(tree, GATE_TREE_MARKER), 'utf-8')).toBe('packages/a\n');

    expect(gateTreeHasLinks(checkout)).toBe(true);
    unlinkNodeModules(root, checkout);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(gateTreeHasLinks(checkout)).toBe(false);
    expect(readFileSync(join(root, 'packages', 'a', 'index.js'), 'utf-8')).toBe('yours\n');
    expect(readFileSync(join(root, 'packages', 'a', 'node_modules', '.vite', 'old.json'), 'utf-8')).toBe('yours\n');
    expect(existsSync(join(root, 'packages', 'a', 'node_modules', 'left-pad', 'package.json'))).toBe(true);
    expect(existsSync(join(nm, '@scope', 'a', 'index.js'))).toBe(true);
    expect(readFileSync(join(checkout, 'packages', 'a', 'index.js'), 'utf-8')).toBe('gate\n');
  });

  it('pnpm: the .pnpm store is linked read-only, per-package links into it and to sibling packages, caches fresh per package', () => {
    const { root, checkout } = monorepo();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    const store = join(root, 'node_modules', '.pnpm', 'vitest@4.0.0', 'node_modules', 'vitest');
    file(join(store, 'package.json'));
    file(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
    symlinkSync(store, join(root, 'node_modules', 'vitest'), linkType);
    const pa = join(root, 'packages', 'a', 'node_modules');
    mkdirSync(join(pa, '@scope'), { recursive: true });
    symlinkSync(store, join(pa, 'vitest'), linkType);
    symlinkSync(join(root, 'packages', 'b'), join(pa, '@scope', 'b'), linkType);
    mkdirSync(join(root, 'packages', 'b', 'node_modules', '.vitest'), { recursive: true });
    expect(linkNodeModules(root, checkout, undefined, parseWorkspacePatterns(null, readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8')))).toBeNull();

    const tree = join(checkout, 'node_modules');
    expect(lstatSync(join(tree, '.pnpm')).isSymbolicLink()).toBe(true);
    expect(real(join(tree, 'vitest'))).toBe(real(store));
    expect(lstatSync(join(tree, '.modules.yaml')).isFile()).toBe(true);
    const ca = join(checkout, 'packages', 'a', 'node_modules');
    expect(real(join(ca, 'vitest'))).toBe(real(store));
    expect(real(join(ca, '@scope', 'b'))).toBe(real(join(checkout, 'packages', 'b')));
    for (const p of ['a', 'b']) {
      for (const cache of ['.vite', '.vitest', '.cache']) {
        const d = join(checkout, 'packages', p, 'node_modules', cache);
        expect(lstatSync(d).isDirectory()).toBe(true);
        expect(lstatSync(d).isSymbolicLink()).toBe(false);
      }
    }
    unlinkNodeModules(root, checkout);
    expect(existsSync(ca)).toBe(false);
    expect(existsSync(join(store, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'packages', 'b', 'node_modules', '.vitest'))).toBe(true);
  });

  it('yarn classic: the workspaces object form builds the same trees', () => {
    const { root, checkout } = monorepo();
    file(join(root, 'packages', 'b', 'node_modules', 'dep', 'package.json'));
    symlinkSync(join(root, 'packages', 'a'), join(root, 'node_modules', 'a'), linkType);
    const patterns = parseWorkspacePatterns(JSON.stringify({ private: true, workspaces: { packages: ['packages/*'] } }), null);
    expect(linkNodeModules(root, checkout, undefined, patterns)).toBeNull();
    expect(real(join(checkout, 'node_modules', 'a'))).toBe(real(join(checkout, 'packages', 'a')));
    expect(real(join(checkout, 'packages', 'b', 'node_modules', 'dep'))).toBe(real(join(root, 'packages', 'b', 'node_modules', 'dep')));
    unlinkNodeModules(root, checkout);
    expect(existsSync(join(checkout, 'packages', 'b', 'node_modules'))).toBe(false);
  });

  it('a malicious head: only the base globs count, a glob out of the checkout and a package dir the PR made a link are left out', () => {
    const { dir, root, checkout } = monorepo();
    const outside = join(dir, 'outside');
    file(join(outside, 'pkg', 'package.json'));
    file(join(outside, 'pkg', 'node_modules', 'secret', 'key.txt'), 'secret\n');
    // The head's package.json adds `../outside/*` and `evil`; the engine passes the base's globs only.
    file(join(checkout, 'package.json'), JSON.stringify({ workspaces: ['packages/*', '../outside/*', 'evil'] }));
    file(join(root, 'evil', 'package.json'));
    file(join(root, 'evil', 'node_modules', 'x', 'package.json'));
    mkdirSync(join(checkout, 'evil'));
    // The PR replaced packages/b by a link (to your checkout's dir) and wants a tree in it.
    file(join(root, 'packages', 'b', 'node_modules', 'dep', 'package.json'));
    rmSync(join(checkout, 'packages', 'b'), { recursive: true });
    symlinkSync(join(root, 'packages', 'b'), join(checkout, 'packages', 'b'), linkType);
    const notes: string[] = [];
    // The base itself listing `../outside/*` is dropped too.
    expect(linkNodeModules(root, checkout, (m) => notes.push(m), ['packages/*', '../outside/*'])).toBeNull();
    expect(notes.join('\n')).toMatch(/\.\.\/outside\/\*.*leaves the repository/);
    expect(existsSync(join(checkout, 'evil', 'node_modules'))).toBe(false);
    expect(existsSync(join(outside, 'pkg', 'node_modules', '.vite'))).toBe(false);
    // Nothing was written into your packages/b through the PR's link.
    expect(readdirSync(join(root, 'packages', 'b', 'node_modules'))).toEqual(['dep']);
    unlinkNodeModules(root, checkout);
    expect(existsSync(join(root, 'packages', 'b', 'node_modules', 'dep', 'package.json'))).toBe(true);
  });

  it('a self-link to a package the PR removed is left out with a note, never linked to your working tree', () => {
    const { root, checkout } = monorepo();
    symlinkSync(join(root, 'packages', 'b'), join(root, 'node_modules', 'b'), linkType);
    rmSync(join(checkout, 'packages', 'b'), { recursive: true });
    const notes: string[] = [];
    linkNodeModules(root, checkout, (m) => notes.push(m), ['packages/*']);
    expect(existsSync(join(checkout, 'node_modules', 'b'))).toBe(false);
    expect(notes.join('\n')).toMatch(/packages\/b of your checkout, which is not a plain dir in the gate checkout/);
    unlinkNodeModules(root, checkout);
  });

  it('a marker line the PR rewrote (.. or through a link) is ignored by the removal; a planted link in a nested tree is unlinked, never followed', () => {
    const { dir, root, checkout } = monorepo();
    file(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'));
    const outside = join(dir, 'outside');
    file(join(outside, 'node_modules', GATE_TREE_MARKER), '');
    file(join(outside, 'node_modules', 'keep.txt'), 'keep\n');
    linkNodeModules(root, checkout, undefined, ['packages/*']);
    symlinkSync(outside, join(checkout, 'via-link'), linkType);
    writeFileSync(join(checkout, 'node_modules', GATE_TREE_MARKER), 'packages/a\n../outside\nvia-link\n/abs\n');
    symlinkSync(outside, join(checkout, 'packages', 'a', 'node_modules', '.vite', 'planted'), linkType);
    unlinkNodeModules(root, checkout);
    expect(readFileSync(join(outside, 'node_modules', 'keep.txt'), 'utf-8')).toBe('keep\n');
    expect(existsSync(join(checkout, 'packages', 'a', 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'))).toBe(true);
  });

  it('with the root marker deleted the nested trees built in this process still go link-safe', () => {
    const { root, checkout } = monorepo();
    file(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'));
    linkNodeModules(root, checkout, undefined, ['packages/*']);
    rmSync(join(checkout, 'node_modules', GATE_TREE_MARKER));
    expect(gateTreeHasLinks(checkout)).toBe(true);
    unlinkNodeModules(root, checkout);
    expect(existsSync(join(checkout, 'packages', 'a', 'node_modules'))).toBe(false);
    expect(gateTreeHasLinks(checkout)).toBe(false);
    expect(existsSync(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'))).toBe(true);
  });

  it('review-501 M1/L2: trustedNestedRels is the engine\'s own record, or after a restart the base globs ∩ the marker; a marker line alone counts for nothing', () => {
    const { root, checkout } = monorepo();
    file(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'));
    file(join(root, 'tools', 'scratch', 'package.json'));
    file(join(root, 'tools', 'scratch', 'node_modules', 'x', 'package.json'));
    linkNodeModules(root, checkout, undefined, ['packages/*']);
    file(join(checkout, 'src', 'node_modules', 'vitest', 'package.json'));
    file(join(checkout, 'tools', 'scratch', 'node_modules', 'x', 'package.json'));
    writeFileSync(join(checkout, 'node_modules', GATE_TREE_MARKER), 'packages/a\nsrc\ntools/scratch\n');
    // In this process: the record, whatever the marker says now.
    expect(trustedNestedRels(root, checkout, ['packages/*'])).toEqual(['packages/a']);
    unlinkNodeModules(root, checkout);
    // A restart (no record): a tree the engine built earlier, its marker rewritten by the PR's code.
    mkdirSync(join(checkout, 'node_modules'));
    mkdirSync(join(checkout, 'packages', 'a', 'node_modules'));
    writeFileSync(join(checkout, 'node_modules', GATE_TREE_MARKER), 'packages/a\nsrc\ntools/scratch\n');
    expect(trustedNestedRels(root, checkout, ['packages/*'])).toEqual(['packages/a']);
    expect(trustedNestedRels(root, checkout, [])).toEqual([]);
    rmSync(join(checkout, 'node_modules', GATE_TREE_MARKER));
    expect(trustedNestedRels(root, checkout, ['packages/*'])).toEqual([]);
  });

  it('review-501 L3: a package dir swapped for a junction after plainDirUnder is refused; nothing is made outside the checkout', () => {
    const { dir, root, checkout } = monorepo();
    file(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'));
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    swap.after = (base, rel, out) => {
      if (base !== checkout || rel !== 'packages/a' || !out) return;
      swap.after = null;
      rmSync(out, { recursive: true });
      symlinkSync(outside, out, linkType);
    };
    try {
      expect(() => linkNodeModules(root, checkout, undefined, ['packages/*'])).toThrow(/resolves to .*outside.*a dir on its way was replaced by a link/);
    } finally {
      swap.after = null;
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(checkout, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'packages', 'a', 'node_modules', 'dep', 'package.json'))).toBe(true);
    // The swapped-in link is left for the caller's link-safe removal (never walked).
    expect(lstatSync(join(checkout, 'packages', 'a')).isSymbolicLink()).toBe(true);
  });

  it('Yarn PnP returns the problem naming the file; no workspaces keeps the single-tree behaviour', () => {
    const pnp = monorepo();
    file(join(pnp.root, '.pnp.cjs'), '');
    expect(linkNodeModules(pnp.root, pnp.checkout, undefined, ['packages/*'])).toMatch(/Plug'n'Play .*\.pnp\.cjs/);
    unlinkNodeModules(pnp.root, pnp.checkout);
    const plain = monorepo();
    file(join(plain.root, 'packages', 'a', 'node_modules', 'dep', 'package.json'));
    expect(linkNodeModules(plain.root, plain.checkout)).toBeNull();
    expect(existsSync(join(plain.checkout, 'packages', 'a', 'node_modules'))).toBe(false);
    expect(readFileSync(join(plain.checkout, 'node_modules', GATE_TREE_MARKER), 'utf-8')).toBe('');
    unlinkNodeModules(plain.root, plain.checkout);
  });
});
