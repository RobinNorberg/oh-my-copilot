/**
 * The team MCP bundle (scripts/build-team-server.mjs, entry
 * src/mcp/team-server.ts) does not externalize `@ast-grep/napi`, so any path
 * from the team code to the MCP tool registry pulls a native `.node` binary
 * into the bundle and `npm run build` fails ("No loader is configured for
 * .node files"). esbuild inlines literal dynamic imports too, so a lazy
 * `await import('../mcp/tool-registry.js')` does not help: this walker follows
 * both static and literal dynamic imports, as the bundler does.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..');

const IMPORT_PATTERNS = [
  // import x from '…' / export { x } from '…' (possibly multi-line); type-only
  // imports are erased by esbuild, so they are skipped.
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/g,
  // side-effect import '…'
  /(?:^|\n)\s*import\s+()['"]([^'"]+)['"]/g,
  // literal dynamic import('…')
  /\bimport\(\s*()['"]([^'"]+)['"]\s*\)/g,
];

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Repo-relative paths (posix) of every reachable source file, plus bare package specifiers. */
function reachable(root: string): { files: Map<string, string>; packages: Map<string, string> } {
  const files = new Map<string, string>(); // file -> importer
  const packages = new Map<string, string>(); // package -> importer
  const start = resolve(REPO, root);
  const queue = [start];
  files.set(rel(start), '(root)');
  while (queue.length) {
    const file = queue.shift()!;
    const text = readFileSync(file, 'utf-8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        if (m[1]) continue; // import type / export type
        const spec = m[2];
        if (spec.startsWith('.')) {
          const target = resolveRelative(file, spec);
          if (!target || files.has(rel(target))) continue;
          files.set(rel(target), rel(file));
          queue.push(target);
        } else if (!packages.has(spec)) {
          packages.set(spec, rel(file));
        }
      }
    }
  }
  return { files, packages };
}

function rel(p: string): string {
  return relative(REPO, p).split('\\').join('/');
}

function chain(files: Map<string, string>, leaf: string): string {
  const out = [leaf];
  let cur = files.get(leaf);
  while (cur && cur !== '(root)') { out.push(cur); cur = files.get(cur); }
  return out.reverse().join(' -> ');
}

describe('team bundle stays free of native modules', () => {
  for (const root of ['src/team/sdk-host.ts', 'src/team/sdk-transport.ts', 'src/smoke/copilot-session-env.ts']) {
    it(`${root} reaches no src/mcp/**, src/tools/**, or @ast-grep`, () => {
      const { files, packages } = reachable(root);
      expect(files.size).toBeGreaterThan(1);
      const bad = [...files.keys()].filter((f) => f.startsWith('src/mcp/') || f.startsWith('src/tools/'));
      expect(bad.map((f) => chain(files, f))).toEqual([]);
      const native = [...packages.keys()].filter((p) => p.startsWith('@ast-grep'));
      expect(native.map((p) => `${packages.get(p)} -> ${p}`)).toEqual([]);
    });
  }

  it('the team MCP server entry reaches neither the tool registry nor @ast-grep', () => {
    const { files, packages } = reachable('src/mcp/team-server.ts');
    expect(files.has('src/team/runtime-v2.ts')).toBe(true);
    const bad = ['src/mcp/tool-registry.ts', 'src/tools/ast-tools.ts'].filter((f) => files.has(f));
    expect(bad.map((f) => chain(files, f))).toEqual([]);
    const native = [...packages.keys()].filter((p) => p.startsWith('@ast-grep'));
    expect(native.map((p) => `${packages.get(p)} -> ${p}`)).toEqual([]);
  });

  // bridge/team.js is an ESM bundle: commander (CJS, `require('node:events')`)
  // throws "Dynamic require … is not supported" at import. The chain smoke
  // scenario reaches the factory CLI (commander), so it must stay out.
  for (const root of ['src/mcp/team-server.ts', 'src/team/runtime-v2.ts', 'src/team/sdk-host.ts']) {
    it(`${root} reaches neither the chain smoke scenario, src/factory/**, src/cli/commands/** nor commander`, () => {
      const { files, packages } = reachable(root);
      const bad = [...files.keys()].filter((f) => f === 'src/smoke/copilot-chain-scenario.ts' || f.startsWith('src/factory/') || f.startsWith('src/cli/commands/'));
      expect(bad.map((f) => chain(files, f))).toEqual([]);
      expect(packages.has('commander') ? `${packages.get('commander')} -> commander` : null).toBeNull();
    });
  }

  it('the walker sees literal dynamic imports (the tool registry reaches @ast-grep)', () => {
    const { packages } = reachable('src/mcp/tool-registry.ts');
    expect([...packages.keys()].some((p) => p.startsWith('@ast-grep'))).toBe(true);
  });
});
