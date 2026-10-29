import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Forge adapters get the caller's guarded Exec and never spawn (design §1).
// The rule covers adapter (production) code: tests and test helpers under
// __tests__ may spawn (the gh-argv baselines drive the real engines). It is
// transitive: a production file must not reach child_process through any
// value import, so src/forge imports URL parsing from the pure
// src/providers/remote-url.ts, not src/providers/index.ts.
const FORGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(FORGE_DIR, '..');
/**
 * child_process, and the bare packages that spawn on its behalf (critic
 * amendments §A.13): importing one is spawning by proxy.
 */
const SPAWNING_PACKAGES = [
  'execa', 'cross-spawn', 'cross-spawn-async', 'child-process-promise', 'child-process-async', 'spawn-sync', 'spawn-command',
  'shelljs', 'zx', 'node-pty', '@lydell/node-pty', 'tree-kill', 'ps-tree', 'npm-run-path', 'foreground-child', 'execa-cjs',
  '@npmcli/promise-spawn', '@npmcli/run-script', 'promisify-child-process', 'await-spawn', 'superspawn', 'nano-spawn', 'tinyexec', 'open',
];
const SPAWN_MODULE = `(?:(?:node:)?child_process|(?:${SPAWNING_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/[^'"]*)?)`;
const SPAWN_IMPORT = [
  new RegExp(`\\bfrom\\s*['"]${SPAWN_MODULE}['"]`),
  new RegExp(`\\bimport\\s*['"]${SPAWN_MODULE}['"]`),
  new RegExp(`\\b(?:require|import)\\s*\\(\\s*['"]${SPAWN_MODULE}['"]\\s*\\)`),
];
/** Relative value imports and re-exports; `import type`/`export type` are erased and never load. */
const RELATIVE_IMPORT = [
  /^[^\S\r\n]*(?:import|export)\s+(?!type\b)([^'";]*?)\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/gm,
  /^[^\S\r\n]*import\s*['"](\.{1,2}\/[^'"]+)['"]/gm,
  /\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];

const isTestFile = (path: string): boolean => /[\\/]__tests__[\\/]/.test(path) || /\.test\.[cm]?[tj]s$/.test(path);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** `{ type A, type B }` only: erased like `import type`. */
const typeOnlyClause = (clause: string): boolean => {
  const named = /^\{([^}]*)\}$/.exec(clause.trim())?.[1];
  if (named === undefined) return false;
  const members = named.split(',').map((m) => m.trim()).filter(Boolean);
  return members.length > 0 && members.every((m) => /^type\s/.test(m));
};

/** The source files `file` loads at runtime, resolved `.js` -> `.ts`. */
function valueImports(file: string, text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(RELATIVE_IMPORT[0])) if (!typeOnlyClause(m[1])) specs.push(m[2]);
  for (const re of RELATIVE_IMPORT.slice(1)) for (const m of text.matchAll(re)) specs.push(m[1]);
  return specs.map((spec) => {
    const base = resolve(dirname(file), spec);
    const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base, `${base}.ts`, join(base, 'index.ts')];
    const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (!found) throw new Error(`${relative(SRC_DIR, file)}: cannot resolve ${spec}`);
    return found;
  });
}

/** Every production file under src/forge whose runtime import graph reaches child_process, with the chain. */
function spawningChains(): string[] {
  const offenders: string[] = [];
  const memo = new Map<string, string[] | null>();
  const visit = (file: string, stack: Set<string>): string[] | null => {
    if (memo.has(file)) return memo.get(file)!;
    if (stack.has(file)) return null;
    stack.add(file);
    const text = readFileSync(file, 'utf8');
    let chain: string[] | null = SPAWN_IMPORT.some((re) => re.test(text)) ? [file] : null;
    for (const dep of chain ? [] : valueImports(file, text)) {
      const sub = visit(dep, stack);
      if (sub) {
        chain = [file, ...sub];
        break;
      }
    }
    stack.delete(file);
    memo.set(file, chain);
    return chain;
  };
  for (const file of sources(FORGE_DIR).filter((f) => !isTestFile(f))) {
    const chain = visit(file, new Set());
    if (chain) offenders.push(chain.map((f) => relative(SRC_DIR, f).replace(/\\/g, '/')).join(' -> '));
  }
  return offenders;
}

describe('src/forge never spawns', () => {
  it('has production sources to check', () => {
    expect(sources(FORGE_DIR).filter((f) => !isTestFile(f)).length).toBeGreaterThan(3);
  });

  it('no production file under src/forge reaches child_process through its imports', () => {
    expect(spawningChains()).toEqual([]);
  });

  it('test files and helpers are out of scope', () => {
    expect(isTestFile(join(FORGE_DIR, '__tests__', 'recording-exec.ts'))).toBe(true);
    expect(isTestFile(join(FORGE_DIR, 'ado', '__tests__', 'fixtures.ts'))).toBe(true);
    expect(isTestFile(join(FORGE_DIR, 'config.test.ts'))).toBe(true);
    expect(isTestFile(join(FORGE_DIR, 'config.ts'))).toBe(false);
  });

  it('the patterns catch every import form', () => {
    const forms = [
      "import { spawnSync } from 'child_process';",
      'import { execFileSync } from "node:child_process";',
      "import 'child_process';",
      "const cp = require('child_process');",
      "const cp = await import('node:child_process');",
    ];
    for (const form of forms) expect(SPAWN_IMPORT.some((re) => re.test(form)), form).toBe(true);
  });

  it('the deny-list catches the bare spawning packages, and not look-alikes', () => {
    const caught = [
      "import { execa } from 'execa';",
      "import spawn from 'cross-spawn';",
      "const cpp = require('child-process-promise');",
      "import 'shelljs';",
      "const pty = await import('node-pty');",
      "import promiseSpawn from '@npmcli/promise-spawn';",
      "import { $ } from 'zx/core';",
    ];
    for (const form of caught) expect(SPAWN_IMPORT.some((re) => re.test(form)), form).toBe(true);
    const fine = ["import { readFileSync } from 'fs';", "import { parse } from 'jsonc-parser';", "import x from 'execa-like';", "import o from 'opener-lib';"];
    for (const form of fine) expect(SPAWN_IMPORT.some((re) => re.test(form)), form).toBe(false);
  });

  it('follows value imports and skips type-only ones', () => {
    const file = join(FORGE_DIR, 'x.ts');
    const text = [
      '// a comment that says import (PR 2).',
      "import type { Exec } from '../ship/exec.js';",
      "import { parseRemoteUrl } from '../providers/index.js';",
      "import type { Exec } from '../ship/exec.js';",
      "import { type GhCheck } from '../ship/gates.js';",
      "export { isAzureDevOpsHost } from '../providers/remote-url.js';",
    ].join('\n');
    expect(valueImports(file, text).map((f) => relative(SRC_DIR, f).replace(/\\/g, '/'))).toEqual(['providers/index.ts', 'providers/remote-url.ts']);
    // providers/index.ts spawns git, so importing it from src/forge would fail the rule above.
    expect(SPAWN_IMPORT.some((re) => re.test(readFileSync(join(SRC_DIR, 'providers', 'index.ts'), 'utf8')))).toBe(true);
  });
});
