import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// Forge adapters get the caller's guarded Exec and never spawn (design §1).
const FORGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPAWN_IMPORT = [
  /\bfrom\s*['"](?:node:)?child_process['"]/,
  /\bimport\s*['"](?:node:)?child_process['"]/,
  /\b(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]\s*\)/,
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name) ? [path] : [];
  });
}

describe('src/forge never spawns', () => {
  it('has sources to check', () => {
    expect(sources(FORGE_DIR).length).toBeGreaterThan(3);
  });

  it('no file under src/forge imports child_process', () => {
    // This file quotes the import forms below, so it is the one file not scanned.
    const self = fileURLToPath(import.meta.url);
    const offenders = sources(FORGE_DIR).filter((file) => {
      if (file === self) return false;
      const text = readFileSync(file, 'utf8');
      return SPAWN_IMPORT.some((re) => re.test(text));
    });
    expect(offenders.map((f) => relative(FORGE_DIR, f))).toEqual([]);
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
});
